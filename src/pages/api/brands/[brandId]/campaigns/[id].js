// src/pages/api/brands/[brandId]/campaigns/[id].js
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import connectToDatabase from '@/lib/mongodb';
import { getCampaignById, updateCampaign, deleteCampaign } from '@/services/campaignService';
import { getBrandById } from '@/services/brandService';
import { checkBrandPermission, PERMISSIONS } from '@/lib/authorization';
import mongoose from 'mongoose';
import initializeQueues from '@/lib/queue';
import Segment from '@/models/Segment';
import Contact from '@/models/Contact';

// Build MongoDB query from segment conditions
function buildSegmentQuery(segment, brandId, additionalFilters = {}) {
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
    const fieldPath = field;

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
            const inValues = Array.isArray(value) ? value : [value];
            if (inValues.length > 1000) {
                return {}; // Reject excessively large arrays
            }
            return { [fieldPath]: { $in: inValues } };

        case 'not_in':
            const notInValues = Array.isArray(value) ? value : [value];
            if (notInValues.length > 1000) {
                return {}; // Reject excessively large arrays
            }
            return { [fieldPath]: { $nin: notInValues } };

        case 'has_tag':
            return { tags: value };

        case 'missing_tag':
            return { tags: { $ne: value } };

        case 'has_any_tag':
            return { tags: { $in: Array.isArray(value) ? value : [value] } };

        case 'has_all_tags':
            return { tags: { $all: Array.isArray(value) ? value : [value] } };

        case 'is_empty':
            return {
                $or: [{ [fieldPath]: { $exists: false } }, { [fieldPath]: null }, { [fieldPath]: '' }, { [fieldPath]: [] }],
            };

        case 'is_not_empty':
            return {
                [fieldPath]: { $exists: true, $ne: null, $ne: '' },
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

// Escape special regex characters
function escapeRegex(string) {
    if (!string) return '';
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper function to get total recipients count (supports both lists and segments)
async function getActiveRecipientsCount(brandId, contactListIds = [], segmentIds = []) {
    const hasLists = contactListIds && contactListIds.length > 0;
    const hasSegments = segmentIds && segmentIds.length > 0;

    if (!hasLists && !hasSegments) return 0;

    // Build the combined query
    const orConditions = [];

    // Add contact list conditions
    if (hasLists) {
        orConditions.push({
            listId: { $in: contactListIds.map((id) => new mongoose.Types.ObjectId(id)) },
            brandId: new mongoose.Types.ObjectId(brandId),
            status: 'active',
        });
    }

    // Add segment conditions
    if (hasSegments) {
        const segments = await Segment.find({
            _id: { $in: segmentIds.map((id) => new mongoose.Types.ObjectId(id)) },
            brandId: new mongoose.Types.ObjectId(brandId),
        });

        for (const segment of segments) {
            const segmentQuery = buildSegmentQuery(segment, brandId);
            orConditions.push(segmentQuery);
        }
    }

    // If we have multiple conditions, use $or; otherwise use the single condition
    let finalQuery;
    if (orConditions.length === 1) {
        finalQuery = orConditions[0];
    } else if (orConditions.length > 1) {
        finalQuery = { $or: orConditions };
    } else {
        return 0;
    }

    // Use aggregation to get unique contacts (avoid counting duplicates)
    const result = await Contact.aggregate([
        { $match: finalQuery },
        { $group: { _id: '$email' } }, // Group by email to get unique contacts
        { $count: 'total' },
    ]);

    return result.length > 0 ? result[0].total : 0;
}

// Build the contact query for sending (used by worker)
async function buildContactQuery(brandId, contactListIds = [], segmentIds = []) {
    const hasLists = contactListIds && contactListIds.length > 0;
    const hasSegments = segmentIds && segmentIds.length > 0;

    if (!hasLists && !hasSegments) {
        return null;
    }

    const orConditions = [];

    // Add contact list conditions
    if (hasLists) {
        orConditions.push({
            listId: { $in: contactListIds.map((id) => new mongoose.Types.ObjectId(id)) },
        });
    }

    // Add segment conditions
    if (hasSegments) {
        const segments = await Segment.find({
            _id: { $in: segmentIds.map((id) => new mongoose.Types.ObjectId(id)) },
            brandId: new mongoose.Types.ObjectId(brandId),
        });

        for (const segment of segments) {
            // Remove the brandId from segment query since we'll add it at the top level
            const segmentQuery = buildSegmentQuery(segment, brandId);
            // Extract only the segment-specific conditions
            const { brandId: _, status: __, ...segmentConditions } = segmentQuery;
            if (Object.keys(segmentConditions).length > 0) {
                orConditions.push(segmentConditions);
            }
        }
    }

    // Build final query
    const baseQuery = {
        brandId: new mongoose.Types.ObjectId(brandId),
        status: 'active',
    };

    if (orConditions.length === 1) {
        return { ...baseQuery, ...orConditions[0] };
    } else if (orConditions.length > 1) {
        return { ...baseQuery, $or: orConditions };
    }

    return baseQuery;
}

export default async function handler(req, res) {
    try {
        // Connect to database
        await connectToDatabase();

        // Get session directly from server
        const session = await getServerSession(req, res, authOptions);

        if (!session || !session.user) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const userId = session.user.id;
        const { brandId, id } = req.query;

        if (!brandId || !id) {
            return res.status(400).json({ message: 'Missing required parameters' });
        }

        // Check if the brand exists
        const brand = await getBrandById(brandId);
        if (!brand) {
            return res.status(404).json({ message: 'Brand not found' });
        }

        // GET request - get a specific campaign
        if (req.method === 'GET') {
            // Check permission (VIEW_CAMPAIGNS allows owners and team members)
            const authCheck = await checkBrandPermission(brandId, userId, PERMISSIONS.VIEW_CAMPAIGNS);
            if (!authCheck.authorized) {
                return res.status(authCheck.status).json({ message: authCheck.message });
            }
            try {
                const campaign = await getCampaignById(id, brandId);

                if (!campaign) {
                    return res.status(404).json({ message: 'Campaign not found' });
                }

                return res.status(200).json(campaign);
            } catch (error) {
                console.error('Error fetching campaign:', error);
                return res.status(500).json({ message: 'Error fetching campaign' });
            }
        }

        // PUT request - update a campaign
        if (req.method === 'PUT') {
            // Check permission (EDIT_CAMPAIGNS required for updating campaigns)
            const authCheck = await checkBrandPermission(brandId, userId, PERMISSIONS.EDIT_CAMPAIGNS);
            if (!authCheck.authorized) {
                return res.status(authCheck.status).json({ message: authCheck.message });
            }

            try {
                const {
                    name,
                    subject,
                    content,
                    editorMode,
                    fromName,
                    fromEmail,
                    replyTo,
                    status,
                    scheduleType,
                    scheduledAt,
                    contactListIds,
                    segmentIds, // NEW: Support for segments
                    warmupConfig,
                    trackingConfig,
                } = req.body;

                const campaign = await getCampaignById(id, brandId);

                if (!campaign) {
                    return res.status(404).json({ message: 'Campaign not found' });
                }

                const updateData = {};

                if (name) updateData.name = name;
                if (subject) updateData.subject = subject;
                if (content !== undefined) updateData.content = content;
                if (editorMode) updateData.editorMode = editorMode;
                if (fromName) updateData.fromName = fromName;
                if (fromEmail) updateData.fromEmail = fromEmail;
                if (replyTo) updateData.replyTo = replyTo;
                if (contactListIds) updateData.contactListIds = contactListIds;
                if (segmentIds !== undefined) updateData.segmentIds = segmentIds; // NEW
                if (trackingConfig) updateData.trackingConfig = trackingConfig;

                // Sending or scheduling functionality
                if (status === 'sending' || status === 'scheduled' || scheduleType === 'warmup') {
                    // Check if SES details exist in the brand
                    if (brand.status !== 'active') {
                        return res.status(400).json({ message: 'AWS SES credentials not configured for this brand' });
                    }

                    // Initialize queues
                    const { emailCampaignQueue, schedulerQueue } = await initializeQueues();

                    // Get the effective list and segment IDs
                    const effectiveListIds = contactListIds || campaign.contactListIds || [];
                    const effectiveSegmentIds = segmentIds !== undefined ? segmentIds : campaign.segmentIds || [];

                    // Validate that we have at least one list or segment
                    if (effectiveListIds.length === 0 && effectiveSegmentIds.length === 0) {
                        return res.status(400).json({ message: 'Please select at least one contact list or segment' });
                    }

                    // Handle scheduled campaigns
                    if (scheduleType === 'schedule' && scheduledAt) {
                        // Set the campaign to scheduled status
                        updateData.status = 'scheduled';
                        updateData.scheduleType = scheduleType;
                        updateData.scheduledAt = new Date(scheduledAt);
                        updateData.segmentIds = effectiveSegmentIds;

                        // Update campaign status first to ensure consistency
                        const updateSuccess = await updateCampaign(id, brandId, updateData);
                        if (!updateSuccess) {
                            return res.status(500).json({ message: 'Failed to update campaign status' });
                        }

                        // Create a delay until the scheduled time
                        const now = new Date();
                        const scheduledTime = new Date(scheduledAt);
                        const delay = Math.max(0, scheduledTime.getTime() - now.getTime());

                        // Add to the scheduler queue - rollback status if queue fails
                        try {
                            await schedulerQueue.add(
                                'process-scheduled-campaign',
                                {
                                    campaignId: campaign._id.toString(),
                                    brandId: brandId.toString(),
                                    userId: userId,
                                    contactListIds: effectiveListIds.map((id) => id.toString()),
                                    segmentIds: effectiveSegmentIds.map((id) => id.toString()), // NEW
                                    fromName: fromName || campaign.fromName || brand.fromName,
                                    fromEmail: fromEmail || campaign.fromEmail || brand.fromEmail,
                                    replyTo: replyTo || campaign.replyTo || campaign.fromEmail,
                                    subject: subject || campaign.subject,
                                },
                                {
                                    delay,
                                    jobId: `scheduled-campaign-${campaign._id}-${Date.now()}`,
                                    attempts: 3,
                                    backoff: {
                                        type: 'exponential',
                                        delay: 5000,
                                    },
                                    removeOnComplete: false,
                                }
                            );
                        } catch (queueError) {
                            // Rollback campaign status if queue operation fails
                            await updateCampaign(id, brandId, { status: campaign.status });
                            throw queueError;
                        }

                        return res.status(200).json({ message: 'Campaign scheduled successfully' });
                    } else if (scheduleType === 'warmup' && warmupConfig) {
                        // Set the campaign status to warmup
                        updateData.status = 'warmup';
                        updateData.scheduleType = 'warmup';
                        updateData.segmentIds = effectiveSegmentIds;

                        // Calculate total stages based on recipient count and configs
                        const totalRecipients = await getActiveRecipientsCount(brandId, effectiveListIds, effectiveSegmentIds);

                        if (totalRecipients === 0) {
                            return res.status(400).json({ message: 'No active contacts found in selected lists/segments' });
                        }

                        // Prepare warmup configuration
                        const initialBatchSize = warmupConfig.initialBatchSize || 50;
                        const incrementFactor = warmupConfig.incrementFactor || 2;
                        const incrementInterval = warmupConfig.incrementInterval || 24; // hours
                        const maxBatchSize = warmupConfig.maxBatchSize || 10000;

                        // Calculate total stages needed for warmup
                        let currentBatchSize = initialBatchSize;
                        let totalStages = 0;
                        let totalSent = 0;

                        while (totalSent < totalRecipients && currentBatchSize <= maxBatchSize) {
                            totalStages++;
                            totalSent += currentBatchSize;
                            currentBatchSize = Math.min(Math.floor(currentBatchSize * incrementFactor), maxBatchSize);
                        }

                        // Add final stage if needed
                        if (totalSent < totalRecipients) {
                            totalStages++;
                        }

                        // Set warmup configuration
                        const warmupStartDate = warmupConfig.warmupStartDate ? new Date(warmupConfig.warmupStartDate) : new Date();

                        updateData.warmupConfig = {
                            initialBatchSize,
                            incrementFactor,
                            incrementInterval,
                            maxBatchSize,
                            warmupStartDate,
                            currentWarmupStage: 0,
                            totalStages,
                            completedBatches: 0,
                            lastBatchSentAt: null,
                        };

                        // Calculate the first batch size (initial batch)
                        const firstBatchSize = Math.min(initialBatchSize, totalRecipients);

                        // Update total recipients
                        updateData.totalRecipients = totalRecipients;

                        // Initialize stats if needed
                        updateData.stats = {
                            ...campaign.stats,
                            recipients: totalRecipients,
                            processed: 0,
                        };

                        // Update campaign status first to ensure consistency
                        const updateSuccess = await updateCampaign(id, brandId, updateData);
                        if (!updateSuccess) {
                            return res.status(500).json({ message: 'Failed to update campaign status' });
                        }

                        // Schedule the first batch - rollback status if queue fails
                        try {
                            await schedulerQueue.add(
                                'process-warmup-batch',
                                {
                                    campaignId: campaign._id.toString(),
                                    brandId: brandId.toString(),
                                    userId: userId,
                                    contactListIds: effectiveListIds.map((id) => id.toString()),
                                    segmentIds: effectiveSegmentIds.map((id) => id.toString()), // NEW
                                    fromName: fromName || campaign.fromName || brand.fromName,
                                    fromEmail: fromEmail || campaign.fromEmail || brand.fromEmail,
                                    replyTo: replyTo || campaign.replyTo || campaign.fromEmail,
                                    subject: subject || campaign.subject,
                                    batchSize: firstBatchSize,
                                    warmupStage: 0,
                                },
                                {
                                    delay: warmupStartDate.getTime() - Date.now(),
                                    jobId: `warmup-campaign-${campaign._id}-batch-0-${Date.now()}`,
                                    attempts: 3,
                                    backoff: {
                                        type: 'exponential',
                                        delay: 5000,
                                    },
                                    removeOnComplete: false,
                                }
                            );
                        } catch (queueError) {
                            // Rollback campaign status if queue operation fails
                            await updateCampaign(id, brandId, { status: campaign.status });
                            throw queueError;
                        }

                        return res.status(200).json({ message: 'Campaign warmup started successfully' });
                    }
                    // Handle immediate sending
                    else if (status === 'sending') {
                        // Calculate total recipients
                        const totalRecipients = await getActiveRecipientsCount(brandId, effectiveListIds, effectiveSegmentIds);

                        if (totalRecipients === 0) {
                            return res.status(400).json({ message: 'No active contacts found in selected lists/segments' });
                        }

                        // Update status to queued
                        updateData.status = 'queued';
                        updateData.sentAt = new Date();
                        updateData.segmentIds = effectiveSegmentIds;
                        updateData.totalRecipients = totalRecipients;

                        // Update stats with recipient count
                        updateData.stats = {
                            ...campaign.stats,
                            recipients: totalRecipients,
                        };

                        // Update campaign status first to ensure consistency
                        const updateSuccess = await updateCampaign(id, brandId, updateData);
                        if (!updateSuccess) {
                            return res.status(500).json({ message: 'Failed to update campaign status' });
                        }

                        // Add to processing queue - rollback status if queue fails
                        try {
                            await emailCampaignQueue.add(
                                'send-campaign',
                                {
                                    campaignId: campaign._id.toString(),
                                    brandId: brandId.toString(),
                                    userId: userId,
                                    contactListIds: effectiveListIds.map((id) => id.toString()),
                                    segmentIds: effectiveSegmentIds.map((id) => id.toString()), // NEW
                                    fromName: fromName || campaign.fromName || brand.fromName,
                                    fromEmail: fromEmail || campaign.fromEmail || brand.fromEmail,
                                    replyTo: replyTo || campaign.replyTo || campaign.fromEmail,
                                    subject: subject || campaign.subject,
                                },
                                {
                                    jobId: `campaign-${campaign._id}-${Date.now()}`,
                                    attempts: 3,
                                    backoff: {
                                        type: 'exponential',
                                        delay: 5000,
                                    },
                                    removeOnComplete: false,
                                }
                            );
                        } catch (queueError) {
                            // Rollback campaign status if queue operation fails
                            await updateCampaign(id, brandId, { status: campaign.status });
                            throw queueError;
                        }

                        return res.status(200).json({ message: 'Campaign queued successfully' });
                    }
                } else if (status) {
                    // For other status updates that aren't sending or scheduling
                    updateData.status = status;
                    const success = await updateCampaign(id, brandId, updateData);

                    if (success) {
                        return res.status(200).json({ message: 'Campaign updated successfully' });
                    } else {
                        return res.status(500).json({ message: 'Failed to update campaign' });
                    }
                }
            } catch (error) {
                console.error('Error updating campaign:', error);
                return res.status(500).json({ message: 'Error updating campaign' });
            }
        }

        // DELETE request - delete a campaign
        if (req.method === 'DELETE') {
            // Check permission (EDIT_CAMPAIGNS required for deleting campaigns)
            const authCheck = await checkBrandPermission(brandId, userId, PERMISSIONS.EDIT_CAMPAIGNS);
            if (!authCheck.authorized) {
                return res.status(authCheck.status).json({ message: authCheck.message });
            }

            try {
                const campaign = await getCampaignById(id, brandId);

                if (!campaign) {
                    return res.status(404).json({ message: 'Campaign not found' });
                }

                if (campaign.status !== 'draft') {
                    return res.status(400).json({ message: 'Only draft campaigns can be deleted' });
                }

                const success = await deleteCampaign(id, brandId);

                if (success) {
                    return res.status(200).json({ message: 'Campaign deleted successfully' });
                } else {
                    return res.status(500).json({ message: 'Failed to delete campaign' });
                }
            } catch (error) {
                console.error('Error deleting campaign:', error);
                return res.status(500).json({ message: 'Error deleting campaign' });
            }
        }

        return res.status(405).json({ message: 'Method not allowed' });
    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
}
