// src/pages/api/brands/[brandId]/contact-lists/[listId]/contacts/index.js
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import connectToDatabase from '@/lib/mongodb';
import { getBrandById } from '@/services/brandService';
import { getContactListById } from '@/services/contactService';
import Contact from '@/models/Contact';
import ContactList from '@/models/ContactList';
import mongoose from 'mongoose';
import { checkBrandPermission, PERMISSIONS } from '@/lib/authorization';

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
        const { brandId, listId } = req.query;

        if (!brandId || !listId) {
            return res.status(400).json({ message: 'Missing required parameters' });
        }

        // Check if the brand exists
        const brand = await getBrandById(brandId);
        if (!brand) {
            return res.status(404).json({ message: 'Brand not found' });
        }

        // Check if the list exists
        const contactList = await getContactListById(listId, brandId, userId);
        if (!contactList) {
            return res.status(404).json({ message: 'Contact list not found' });
        }

        // GET - Fetch contacts in a list
        if (req.method === 'GET') {
            const authCheck = await checkBrandPermission(brandId, userId, PERMISSIONS.VIEW_CONTACTS);
            if (!authCheck.authorized) {
                return res.status(authCheck.status).json({ message: authCheck.message });
            }
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const sortField = req.query.sort || 'email';
            const sortOrder = req.query.order || 'asc';
            const search = req.query.search || '';
            const status = req.query.status || '';

            const skip = (page - 1) * limit;
            const sortDirection = sortOrder === 'desc' ? -1 : 1;

            // Build the query
            const query = {
                listId: new mongoose.Types.ObjectId(listId),
                brandId: new mongoose.Types.ObjectId(brandId),
                userId: new mongoose.Types.ObjectId(userId),
            };

            // Add status filter if provided
            if (status && status !== 'all') {
                query.status = status;
            }

            // Add search filter if provided
            if (search) {
                query.$or = [{ email: { $regex: search, $options: 'i' } }, { firstName: { $regex: search, $options: 'i' } }, { lastName: { $regex: search, $options: 'i' } }];
            }

            // Build the sort option
            const sortOption = {};
            sortOption[sortField] = sortDirection;

            // Count total matching contacts
            const totalContacts = await Contact.countDocuments(query);
            const totalPages = Math.ceil(totalContacts / limit);

            // Fetch the contacts
            const contacts = await Contact.find(query).sort(sortOption).skip(skip).limit(limit);

            // Get count by status for statistics
            const statusCounts = await Contact.aggregate([
                {
                    $match: {
                        listId: new mongoose.Types.ObjectId(listId),
                        brandId: new mongoose.Types.ObjectId(brandId),
                        userId: new mongoose.Types.ObjectId(userId),
                    },
                },
                {
                    $group: {
                        _id: { $ifNull: ['$status', 'active'] }, // Default to "active" if status is null
                        count: { $sum: 1 },
                    },
                },
            ]);

            // Convert to a more usable format
            const statusCountsObj = statusCounts.reduce(
                (acc, curr) => {
                    acc[curr._id] = curr.count;
                    return acc;
                },
                {
                    active: 0,
                    unsubscribed: 0,
                    bounced: 0,
                    complained: 0,
                }
            );

            return res.status(200).json({
                contacts,
                totalContacts,
                totalPages,
                currentPage: page,
                statusCounts: statusCountsObj,
            });
        }

        // POST - Add contacts to a list
        if (req.method === 'POST') {
            const authCheck = await checkBrandPermission(brandId, userId, PERMISSIONS.EDIT_CONTACTS);
            if (!authCheck.authorized) {
                return res.status(authCheck.status).json({ message: authCheck.message });
            }

            const { contacts: newContacts, skipDuplicates = false } = req.body;

            if (!newContacts || !Array.isArray(newContacts) || newContacts.length === 0) {
                return res.status(400).json({ message: 'No contacts provided' });
            }

            // Validate email addresses
            const invalidEmails = newContacts.filter((contact) => {
                return !contact.email || !contact.email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
            });

            if (invalidEmails.length > 0) {
                return res.status(400).json({
                    message: 'Some contacts have invalid email addresses',
                    invalidEntries: invalidEmails,
                });
            }

            // Prepare contacts for insertion
            const contactsToInsert = newContacts.map((contact) => ({
                ...contact,
                email: contact.email.toLowerCase().trim(),
                status: 'active', // Set default status to active
                listId: new mongoose.Types.ObjectId(listId),
                brandId: new mongoose.Types.ObjectId(brandId),
                userId: new mongoose.Types.ObjectId(userId),
                createdAt: new Date(),
                updatedAt: new Date(),
            }));

            let importResult = {
                total: contactsToInsert.length,
                imported: 0,
                skipped: 0,
            };

            // Always check for existing emails, regardless of skipDuplicates setting
            const existingEmails = new Set();
            const existingContacts = await Contact.find(
                {
                    listId: new mongoose.Types.ObjectId(listId),
                },
                'email'
            );

            existingContacts.forEach((contact) => {
                existingEmails.add(contact.email.toLowerCase());
            });

            // Filter contacts based on duplicates
            const newContactsToInsert = [];
            const duplicateContacts = [];

            contactsToInsert.forEach((contact) => {
                if (existingEmails.has(contact.email.toLowerCase())) {
                    duplicateContacts.push(contact);
                } else {
                    // Add to our new set to also check for duplicates within the current batch
                    if (!existingEmails.has(contact.email.toLowerCase())) {
                        newContactsToInsert.push(contact);
                        // Add to the set so we detect duplicates within the import itself
                        existingEmails.add(contact.email.toLowerCase());
                    } else {
                        duplicateContacts.push(contact);
                    }
                }
            });

            importResult.skipped = duplicateContacts.length;

            // If skipDuplicates is true, we'll add only the new contacts
            // If it's false and there are duplicates, we'll throw an error
            if (!skipDuplicates && duplicateContacts.length > 0) {
                const error = new Error(`Found ${duplicateContacts.length} duplicate emails. Set skipDuplicates to true to ignore them.`);
                error.code = 11000;
                error.duplicates = duplicateContacts.map((c) => c.email);
                throw error;
            }

            // Insert the new contacts
            if (newContactsToInsert.length > 0) {
                try {
                    const result = await Contact.insertMany(newContactsToInsert);
                    importResult.imported = result.length;

                    // Recalculate contact count from actual documents to ensure accuracy
                    const actualCount = await Contact.countDocuments({
                        listId: new mongoose.Types.ObjectId(listId),
                    });
                    // Ensure count is never negative (atomic safeguard)
                    const safeCount = Math.max(0, actualCount);
                    await ContactList.updateOne(
                        { _id: new mongoose.Types.ObjectId(listId) },
                        {
                            contactCount: safeCount,
                            updatedAt: new Date(),
                        }
                    );
                } catch (error) {
                    console.log('Error inserting contacts:', error);
                    // Recalculate count even on error to ensure accuracy
                    try {
                        const actualCount = await Contact.countDocuments({
                            listId: new mongoose.Types.ObjectId(listId),
                        });
                        // Ensure count is never negative (atomic safeguard)
                        const safeCount = Math.max(0, actualCount);
                        await ContactList.updateOne(
                            { _id: new mongoose.Types.ObjectId(listId) },
                            {
                                contactCount: safeCount,
                                updatedAt: new Date(),
                            }
                        );
                    } catch (recalcError) {
                        console.error('Error recalculating contact count:', recalcError);
                    }
                    throw error;
                }
            }

            return res.status(201).json(importResult);
        }

        // DELETE - Delete contacts from a list
        if (req.method === 'DELETE') {
            const authCheck = await checkBrandPermission(brandId, userId, PERMISSIONS.EDIT_CONTACTS);
            if (!authCheck.authorized) {
                return res.status(authCheck.status).json({ message: authCheck.message });
            }

            const { contactIds } = req.body;

            if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
                return res.status(400).json({ message: 'No contact IDs provided' });
            }

            // Convert string IDs to ObjectIds
            const objectIds = contactIds.map((id) => new mongoose.Types.ObjectId(id));

            // Delete the contacts
            const result = await Contact.deleteMany({
                _id: { $in: objectIds },
                listId: new mongoose.Types.ObjectId(listId),
                brandId: new mongoose.Types.ObjectId(brandId),
                userId: new mongoose.Types.ObjectId(userId),
            });

            // Recalculate contact count from actual documents to ensure accuracy
            if (result.deletedCount > 0) {
                const actualCount = await Contact.countDocuments({
                    listId: new mongoose.Types.ObjectId(listId),
                });
                // Ensure count is never negative (atomic safeguard)
                const safeCount = Math.max(0, actualCount);
                await ContactList.updateOne(
                    { _id: new mongoose.Types.ObjectId(listId) },
                    {
                        contactCount: safeCount,
                        updatedAt: new Date(),
                    }
                );
            }

            return res.status(200).json({
                deletedCount: result.deletedCount,
            });
        }

        return res.status(405).json({ message: 'Method not allowed' });
    } catch (error) {
        console.error('Error handling contacts:', error);
        return res.status(500).json({ message: 'Internal server error', error: error.message });
    }
}
