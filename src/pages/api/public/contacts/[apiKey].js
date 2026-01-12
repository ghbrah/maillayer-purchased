// src/pages/api/public/contacts/[apiKey].js
import connectToDatabase from '@/lib/mongodb';
import ContactList from '@/models/ContactList';
import Contact from '@/models/Contact';
import mongoose from 'mongoose';

// Define max size for custom fields to prevent abuse
const MAX_CUSTOM_FIELDS_SIZE = 10 * 1024; // 10KB limit

export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            message: 'Method not allowed. Use POST.',
        });
    }

    try {
        await connectToDatabase();

        const { apiKey } = req.query;
        const { email, firstName, lastName, phone, customFields, ...otherFields } = req.body;

        // Validate required fields
        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required',
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email format',
            });
        }

        // Find the contact list by API key
        const contactList = await ContactList.findOne({
            apiKey,
            apiEnabled: true,
        });

        if (!contactList) {
            return res.status(404).json({
                success: false,
                message: 'Invalid API key or API is disabled',
            });
        }

        // Check allowed domains (origin/referer validation)
        if (contactList.allowedDomains && contactList.allowedDomains.length > 0) {
            const origin = req.headers.origin || req.headers.referer;

            // Require origin/referer header when domain restrictions are configured
            if (!origin) {
                return res.status(403).json({
                    success: false,
                    message: 'Origin or Referer header is required',
                });
            }

            let requestDomain = '';
            try {
                const url = new URL(origin);
                requestDomain = url.hostname.toLowerCase();
            } catch (e) {
                // Reject invalid origin URLs
                return res.status(403).json({
                    success: false,
                    message: 'Invalid origin or referer header',
                });
            }

            // Perform exact domain or subdomain matching
            const isAllowed = contactList.allowedDomains.some((domain) => {
                const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
                // Extract hostname if domain includes path
                const domainHostname = cleanDomain.split('/')[0];
                
                // Exact match
                if (requestDomain === domainHostname) {
                    return true;
                }
                
                // Subdomain match: requestDomain must end with .domainHostname
                if (requestDomain.endsWith('.' + domainHostname)) {
                    return true;
                }
                
                return false;
            });

            if (!isAllowed) {
                return res.status(403).json({
                    success: false,
                    message: 'Requests from this domain are not allowed',
                });
            }
        }

        // Process custom fields
        // Merge explicit customFields with any other fields sent in the body
        let mergedCustomFields = {};

        // Add any extra fields from the body (excluding known fields)
        if (Object.keys(otherFields).length > 0) {
            mergedCustomFields = { ...otherFields };
        }

        // Merge with explicit customFields (these take priority)
        if (customFields && typeof customFields === 'object') {
            mergedCustomFields = { ...mergedCustomFields, ...customFields };
        }

        // Validate custom fields size to prevent abuse
        const customFieldsString = JSON.stringify(mergedCustomFields);
        if (customFieldsString.length > MAX_CUSTOM_FIELDS_SIZE) {
            return res.status(400).json({
                success: false,
                message: `Custom fields exceed maximum size of ${MAX_CUSTOM_FIELDS_SIZE / 1024}KB`,
            });
        }

        // Sanitize custom fields - remove any potentially dangerous keys
        const sanitizedCustomFields = sanitizeCustomFields(mergedCustomFields);

        // Check if contact already exists
        const existingContact = await Contact.findOne({
            email: email.toLowerCase().trim(),
            listId: contactList._id,
        });

        if (existingContact) {
            if (!contactList.apiSettings?.allowDuplicates) {
                // Update existing contact with new custom fields
                try {
                    if (Object.keys(sanitizedCustomFields).length > 0) {
                        existingContact.customFields = {
                            ...existingContact.customFields,
                            ...sanitizedCustomFields,
                        };
                        existingContact.updatedAt = new Date();
                        await existingContact.save();
                    }

                    return res.status(200).json({
                        success: true,
                        message: 'Contact already exists in this list',
                        contactId: existingContact._id,
                        duplicate: true,
                        customFieldsUpdated: Object.keys(sanitizedCustomFields).length > 0,
                    });
                } catch (updateError) {
                    console.error('Error updating existing contact:', updateError);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to update existing contact. Please try again.',
                    });
                }
            } else {
                // Duplicates allowed, but contact already exists - return existing contact
                return res.status(200).json({
                    success: true,
                    message: 'Contact already exists in this list',
                    contactId: existingContact._id,
                    duplicate: true,
                });
            }
        }

        // Create new contact
        const contact = new Contact({
            email: email.toLowerCase().trim(),
            firstName: firstName || '',
            lastName: lastName || '',
            phone: phone || '',
            customFields: sanitizedCustomFields,
            listId: contactList._id,
            brandId: contactList.brandId,
            userId: contactList.userId,
            status: 'active',
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        await contact.save();

        // Recalculate contact count from actual documents to ensure accuracy
        const actualCount = await Contact.countDocuments({
            listId: contactList._id,
        });
        // Ensure count is never negative (atomic safeguard)
        const safeCount = Math.max(0, actualCount);
        await ContactList.updateOne(
            { _id: contactList._id },
            {
                contactCount: safeCount,
                updatedAt: new Date(),
            }
        );

        // Return success response
        return res.status(201).json({
            success: true,
            message: 'Contact added successfully',
            contactId: contact._id,
            redirectUrl: contactList.apiSettings?.redirectUrl || null,
        });
    } catch (error) {
        console.error('Error adding contact via API:', error);

        // Handle duplicate key error
        if (error.code === 11000) {
            // Recalculate count in case of duplicate to ensure accuracy
            try {
                const actualCount = await Contact.countDocuments({
                    listId: contactList._id,
                });
                // Ensure count is never negative (atomic safeguard)
                const safeCount = Math.max(0, actualCount);
                await ContactList.updateOne(
                    { _id: contactList._id },
                    {
                        contactCount: safeCount,
                        updatedAt: new Date(),
                    }
                );
            } catch (recalcError) {
                console.error('Error recalculating contact count:', recalcError);
            }

            return res.status(200).json({
                success: true,
                message: 'Contact already exists in this list',
                duplicate: true,
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Failed to add contact. Please try again.',
        });
    }
}

// Helper function to sanitize custom fields
function sanitizeCustomFields(fields) {
    if (!fields || typeof fields !== 'object') {
        return {};
    }

    const sanitized = {};
    const blockedKeys = ['_id', '__v', 'listId', 'brandId', 'userId', 'status', 'isUnsubscribed', 'password', 'token'];

    for (const [key, value] of Object.entries(fields)) {
        // Skip blocked keys
        if (blockedKeys.includes(key)) continue;

        // Skip keys starting with $ (MongoDB operators)
        if (key.startsWith('$')) continue;

        // Skip keys containing dots (nested field injection)
        if (key.includes('.')) continue;

        // Recursively sanitize nested objects (up to 3 levels deep)
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            sanitized[key] = sanitizeCustomFields(value);
        } else {
            sanitized[key] = value;
        }
    }

    return sanitized;
}
