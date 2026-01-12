// src/pages/api/brands/[brandId]/contacts/count.js
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

function escapeRegex(string) {
    if (!string) return '';
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        fieldPath = `customFields.${customFieldName}`;
    }

    switch (operator) {
        case 'equals':
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
            return { [fieldPath]: { $exists: true, $ne: null, $ne: '' } };
        default:
            return {};
    }
}

export default async function handler(req, res) {
    try {
        if (req.method !== 'GET') {
            return res.status(405).json({ message: 'Method not allowed' });
        }

        await connectToDatabase();

        const session = await getServerSession(req, res, authOptions);
        if (!session || !session.user) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const userId = session.user.id;
        const { brandId } = req.query;

        const brand = await getBrandById(brandId);
        if (!brand) {
            return res.status(404).json({ message: 'Brand not found' });
        }

        // Check permission
        const authCheck = await checkBrandPermission(brandId, userId, PERMISSIONS.VIEW_CONTACTS);
        if (!authCheck.authorized) {
            return res.status(authCheck.status).json({ message: authCheck.message });
        }

        // Parse list IDs and segment IDs from query
        const listIds = req.query.listIds ? req.query.listIds.split(',').filter(Boolean) : [];
        const segmentIds = req.query.segmentIds ? req.query.segmentIds.split(',').filter(Boolean) : [];

        if (listIds.length === 0 && segmentIds.length === 0) {
            return res.status(200).json({ count: 0 });
        }

        // Build the combined query
        const orConditions = [];

        // Add contact list conditions
        if (listIds.length > 0) {
            orConditions.push({
                listId: { $in: listIds.map((id) => new mongoose.Types.ObjectId(id)) },
            });
        }

        // Add segment conditions
        if (segmentIds.length > 0) {
            const segments = await Segment.find({
                _id: { $in: segmentIds.map((id) => new mongoose.Types.ObjectId(id)) },
                brandId: new mongoose.Types.ObjectId(brandId),
            });

            for (const segment of segments) {
                const segmentQuery = buildSegmentQuery(segment, brandId);
                // Extract segment-specific conditions
                const { brandId: _, status: __, ...segmentConditions } = segmentQuery;
                if (Object.keys(segmentConditions).length > 0) {
                    orConditions.push(segmentConditions);
                }
            }
        }

        // Base query
        const baseQuery = {
            brandId: new mongoose.Types.ObjectId(brandId),
            status: 'active',
        };

        let finalQuery;
        if (orConditions.length === 1) {
            finalQuery = { ...baseQuery, ...orConditions[0] };
        } else if (orConditions.length > 1) {
            finalQuery = { ...baseQuery, $or: orConditions };
        } else {
            finalQuery = baseQuery;
        }

        // Use aggregation to count unique emails (avoid duplicates)
        const result = await Contact.aggregate([{ $match: finalQuery }, { $group: { _id: '$email' } }, { $count: 'total' }]);

        const count = result.length > 0 ? result[0].total : 0;

        return res.status(200).json({ count });
    } catch (error) {
        console.error('Error counting contacts:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
}
