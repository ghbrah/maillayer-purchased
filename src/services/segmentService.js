// src/services/segmentService.js
import mongoose from 'mongoose';
import Segment from '@/models/Segment';
import Contact from '@/models/Contact';

// Build MongoDB query from segment conditions
export function buildSegmentQuery(segment, brandId, additionalFilters = {}) {
    const baseQuery = {
        brandId: new mongoose.Types.ObjectId(brandId),
        status: 'active',
        ...additionalFilters,
    };

    // If segment has specific contact lists, add that filter
    if (segment.contactListIds && segment.contactListIds.length > 0) {
        baseQuery.listId = {
            $in: segment.contactListIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
    }

    // If static segment, just return contacts in the list
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

    // Build dynamic conditions
    if (!segment.conditions || !segment.conditions.rules || segment.conditions.rules.length === 0) {
        return baseQuery;
    }

    const conditions = segment.conditions.rules.map((rule) => buildRuleQuery(rule));

    if (conditions.length === 0) {
        return baseQuery;
    }

    const matchOperator = segment.conditions.matchType === 'any' ? '$or' : '$and';

    return {
        ...baseQuery,
        [matchOperator]: conditions,
    };
}

// Escape special regex characters
function escapeRegex(string) {
    if (!string) return '';
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Convert a single rule to MongoDB query
function buildRuleQuery(rule) {
    const { field, operator, value } = rule;

    // Validate required fields
    if (!field || !operator) {
        return {};
    }

    // Some operators require a value
    const valueRequiredOps = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'greater_than', 'less_than', 'before', 'after', 'has_tag', 'missing_tag', 'has_any_tag', 'has_all_tags', 'in', 'not_in'];
    if (valueRequiredOps.includes(operator) && (value === undefined || value === null)) {
        return {}; // Skip invalid rules
    }

    // Handle different field types
    const fieldPath = field.startsWith('customFields.') ? field : field;

    switch (operator) {
        case 'equals':
            return { [fieldPath]: value };

        case 'not_equals':
            return { [fieldPath]: { $ne: value } };

        case 'contains':
            return { [fieldPath]: { $regex: escapeRegex(value), $options: 'i' } };

        case 'not_contains':
            return { [fieldPath]: { $not: { $regex: escapeRegex(value), $options: 'i' } } };

        case 'starts_with':
            return { [fieldPath]: { $regex: `^${escapeRegex(value)}`, $options: 'i' } };

        case 'ends_with':
            return { [fieldPath]: { $regex: `${escapeRegex(value)}$`, $options: 'i' } };

        case 'greater_than':
            return { [fieldPath]: { $gt: value } };

        case 'less_than':
            return { [fieldPath]: { $lt: value } };

        case 'in':
            return { [fieldPath]: { $in: Array.isArray(value) ? value : [value] } };

        case 'not_in':
            return { [fieldPath]: { $nin: Array.isArray(value) ? value : [value] } };

        case 'has_tag':
            return { tags: value };

        case 'missing_tag':
            return { tags: { $ne: value } };

        case 'is_empty':
            return {
                $or: [{ [fieldPath]: { $exists: false } }, { [fieldPath]: null }, { [fieldPath]: '' }, { [fieldPath]: [] }],
            };

        case 'is_not_empty':
            return {
                [fieldPath]: { $exists: true, $ne: null, $ne: '', $not: { $size: 0 } },
            };

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

        default:
            return {};
    }
}

// Get contacts matching a segment
export async function getSegmentContacts(segmentId, brandId, userId, options = {}) {
    const { page = 1, limit = 50, countOnly = false } = options;

    const segment = await Segment.findOne({
        _id: segmentId,
        brandId,
        userId,
    });

    if (!segment) {
        throw new Error('Segment not found');
    }

    const query = buildSegmentQuery(segment, brandId);

    if (countOnly) {
        return Contact.countDocuments(query);
    }

    const skip = (page - 1) * limit;
    const contacts = await Contact.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);

    const total = await Contact.countDocuments(query);

    return {
        contacts,
        total,
        page,
        totalPages: Math.ceil(total / limit),
    };
}

// Update segment cached count
export async function updateSegmentCount(segmentId) {
    const segment = await Segment.findById(segmentId);
    if (!segment) return;

    const query = buildSegmentQuery(segment, segment.brandId);
    const count = await Contact.countDocuments(query);

    await Segment.updateOne(
        { _id: segmentId },
        {
            cachedCount: count,
            lastCountUpdated: new Date(),
        }
    );

    return count;
}

// CRUD operations
export async function createSegment(data) {
    const segment = new Segment(data);
    await segment.save();

    // Calculate initial count
    await updateSegmentCount(segment._id);

    return Segment.findById(segment._id);
}

export async function getSegmentsByBrandId(brandId, userId) {
    return Segment.find({
        brandId,
        userId,
        status: 'active',
    }).sort({ createdAt: -1 });
}

export async function getSegmentById(segmentId, brandId, userId) {
    return Segment.findOne({
        _id: segmentId,
        brandId,
        userId,
    });
}

export async function updateSegment(segmentId, brandId, userId, updateData) {
    const segment = await Segment.findOneAndUpdate({ _id: segmentId, brandId, userId }, { ...updateData, lastCountUpdated: null }, { new: true });

    if (segment) {
        await updateSegmentCount(segment._id);
    }

    return segment;
}

export async function deleteSegment(segmentId, brandId, userId) {
    return Segment.deleteOne({ _id: segmentId, brandId, userId });
}
