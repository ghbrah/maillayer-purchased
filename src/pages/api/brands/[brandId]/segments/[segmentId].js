// src/pages/api/brands/[brandId]/segments/[segmentId].js
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import connectToDatabase from '@/lib/mongodb';
import { getBrandById } from '@/services/brandService';
import Segment from '@/models/Segment';
import Contact from '@/models/Contact';
import mongoose from 'mongoose';
import { checkBrandPermission, PERMISSIONS } from '@/lib/authorization';

// Build segment query
function buildSegmentQuery(segment, brandId) {
    const baseQuery = {
        brandId: new mongoose.Types.ObjectId(brandId),
        status: 'active',
    };

    if (segment.contactListIds && segment.contactListIds.length > 0) {
        baseQuery.listId = {
            $in: segment.contactListIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
    }

    if (segment.type === 'static') {
        // Validate and convert staticContactIds to ObjectIds
        const staticIds = Array.isArray(segment.staticContactIds)
            ? segment.staticContactIds
                  .map((id) => {
                      try {
                          return new mongoose.Types.ObjectId(id);
                      } catch (e) {
                          return null;
                      }
                  })
                  .filter(Boolean)
            : [];
        return {
            ...baseQuery,
            _id: { $in: staticIds },
        };
    }

    if (!segment.conditions || !segment.conditions.rules || segment.conditions.rules.length === 0) {
        return baseQuery;
    }

    const conditions = segment.conditions.rules.map((rule) => buildRuleQuery(rule)).filter((c) => Object.keys(c).length > 0);

    if (conditions.length === 0) {
        return baseQuery;
    }

    const matchOperator = segment.conditions.matchType === 'any' ? '$or' : '$and';

    return {
        ...baseQuery,
        [matchOperator]: conditions,
    };
}

function buildRuleQuery(rule) {
    const { field, operator, value, customFieldName } = rule;

    // Validate required fields
    if (!field || !operator) {
        return {};
    }

    // Some operators require a value
    const valueRequiredOps = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'greater_than', 'less_than', 'before', 'after', 'has_tag', 'missing_tag', 'has_any_tag', 'has_all_tags', 'in', 'not_in'];
    if (valueRequiredOps.includes(operator) && (value === undefined || value === null)) {
        return {}; // Skip invalid rules
    }

    // Determine the actual field path
    let fieldPath = field;
    if (field === 'customField' && customFieldName) {
        // Validate customFieldName to prevent NoSQL injection
        if (!/^[a-zA-Z0-9_]+$/.test(customFieldName)) {
            return {};
        }
        fieldPath = `customFields.${customFieldName}`;
    }

    switch (operator) {
        case 'equals':
            // Handle boolean string conversion
            if (value === 'true') return { [fieldPath]: { $in: [true, 'true'] } };
            if (value === 'false') return { [fieldPath]: { $in: [false, 'false'] } };
            return { [fieldPath]: value };

        case 'not_equals':
            if (value === 'true') return { [fieldPath]: { $nin: [true, 'true'] } };
            if (value === 'false') return { [fieldPath]: { $nin: [false, 'false'] } };
            return { [fieldPath]: { $ne: value } };

        case 'contains':
            return { [fieldPath]: { $regex: value, $options: 'i' } };

        case 'not_contains':
            return { [fieldPath]: { $not: { $regex: value, $options: 'i' } } };

        case 'starts_with':
            return { [fieldPath]: { $regex: `^${escapeRegex(value)}`, $options: 'i' } };

        case 'ends_with':
            return { [fieldPath]: { $regex: `${escapeRegex(value)}$`, $options: 'i' } };

        case 'greater_than':
            return { [fieldPath]: { $gt: parseFloat(value) || value } };

        case 'less_than':
            return { [fieldPath]: { $lt: parseFloat(value) || value } };

        case 'has_tag':
            return { tags: value };

        case 'missing_tag':
            return { tags: { $ne: value } };

        case 'has_any_tag':
            return { tags: { $in: Array.isArray(value) ? value : [value] } };

        case 'has_all_tags':
            return { tags: { $all: Array.isArray(value) ? value : [value] } };

        case 'before':
            const beforeDate = new Date(value);
            if (isNaN(beforeDate.getTime())) {
                return {}; // Reject invalid dates
            }
            return { [fieldPath]: { $lt: beforeDate } };

        case 'after':
            const afterDate = new Date(value);
            if (isNaN(afterDate.getTime())) {
                return {}; // Reject invalid dates
            }
            return { [fieldPath]: { $gt: afterDate } };

        case 'is_empty':
            return {
                $or: [{ [fieldPath]: { $exists: false } }, { [fieldPath]: null }, { [fieldPath]: '' }, { [fieldPath]: [] }],
            };

        case 'is_not_empty':
            return {
                [fieldPath]: { $exists: true, $ne: null, $ne: '' },
            };

        default:
            return {};
    }
}

// Helper function to escape regex special characters
function escapeRegex(string) {
    if (!string) return '';
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function updateSegmentCount(segment) {
    const query = buildSegmentQuery(segment, segment.brandId);
    const count = await Contact.countDocuments(query);

    await Segment.updateOne(
        { _id: segment._id },
        {
            cachedCount: count,
            lastCountUpdated: new Date(),
        }
    );

    return count;
}

export default async function handler(req, res) {
    try {
        await connectToDatabase();

        const session = await getServerSession(req, res, authOptions);
        if (!session || !session.user) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const userId = session.user.id;
        const { brandId, segmentId } = req.query;

        const brand = await getBrandById(brandId);
        if (!brand) {
            return res.status(404).json({ message: 'Brand not found' });
        }

        // GET: Get a specific segment
        if (req.method === 'GET') {
            const authCheck = await checkBrandPermission(brandId, userId, PERMISSIONS.VIEW_CONTACTS);
            if (!authCheck.authorized) {
                return res.status(authCheck.status).json({ message: authCheck.message });
            }
            const segment = await Segment.findOne({
                _id: new mongoose.Types.ObjectId(segmentId),
                brandId: new mongoose.Types.ObjectId(brandId),
                userId: new mongoose.Types.ObjectId(userId),
            });

            if (!segment) {
                return res.status(404).json({ message: 'Segment not found' });
            }

            return res.status(200).json(segment);
        }

        // PUT: Update a segment
        if (req.method === 'PUT') {
            const authCheck = await checkBrandPermission(brandId, userId, PERMISSIONS.EDIT_CONTACTS);
            if (!authCheck.authorized) {
                return res.status(authCheck.status).json({ message: authCheck.message });
            }

            const { name, description, type, conditions, contactListIds } = req.body;

            if (!name) {
                return res.status(400).json({ message: 'Segment name is required' });
            }

            const segment = await Segment.findOneAndUpdate(
                {
                    _id: new mongoose.Types.ObjectId(segmentId),
                    brandId: new mongoose.Types.ObjectId(brandId),
                    userId: new mongoose.Types.ObjectId(userId),
                },
                {
                    name,
                    description,
                    type: type || 'dynamic',
                    conditions: conditions || { matchType: 'all', rules: [] },
                    contactListIds: contactListIds || [],
                    lastCountUpdated: null,
                },
                { new: true }
            );

            if (!segment) {
                return res.status(404).json({ message: 'Segment not found' });
            }

            // Recalculate count
            await updateSegmentCount(segment);

            const updatedSegment = await Segment.findById(segment._id);

            return res.status(200).json(updatedSegment);
        }

        // DELETE: Delete a segment
        if (req.method === 'DELETE') {
            const authCheck = await checkBrandPermission(brandId, userId, PERMISSIONS.EDIT_CONTACTS);
            if (!authCheck.authorized) {
                return res.status(authCheck.status).json({ message: authCheck.message });
            }

            const result = await Segment.deleteOne({
                _id: new mongoose.Types.ObjectId(segmentId),
                brandId: new mongoose.Types.ObjectId(brandId),
                userId: new mongoose.Types.ObjectId(userId),
            });

            if (result.deletedCount === 0) {
                return res.status(404).json({ message: 'Segment not found' });
            }

            return res.status(200).json({ message: 'Segment deleted successfully' });
        }

        return res.status(405).json({ message: 'Method not allowed' });
    } catch (error) {
        console.error('Error handling segment:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
}
