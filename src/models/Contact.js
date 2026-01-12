// src/models/Contact.js - Updated with tags
import mongoose from 'mongoose';

const ContactSchema = new mongoose.Schema(
    {
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
        },
        firstName: {
            type: String,
            trim: true,
        },
        lastName: {
            type: String,
            trim: true,
        },
        phone: {
            type: String,
            trim: true,
        },
        listId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ContactList',
            required: true,
        },
        brandId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Brand',
            required: true,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        customFields: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        // NEW: Tags for segmentation
        tags: [
            {
                type: String,
                trim: true,
                lowercase: true,
            },
        ],
        status: {
            type: String,
            enum: ['active', 'unsubscribed', 'bounced', 'complained'],
            default: 'active',
        },
        isUnsubscribed: {
            type: Boolean,
            default: false,
        },
        unsubscribedAt: {
            type: Date,
            default: null,
        },
        unsubscribedFromCampaign: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign',
            default: null,
        },
        unsubscribeReason: {
            type: String,
            default: null,
        },
        bouncedAt: {
            type: Date,
            default: null,
        },
        bounceType: {
            type: String,
            default: null,
        },
        bounceReason: {
            type: String,
            default: null,
        },
        complainedAt: {
            type: Date,
            default: null,
        },
        complaintReason: {
            type: String,
            default: null,
        },
        createdAt: {
            type: Date,
            default: Date.now,
        },
        updatedAt: {
            type: Date,
            default: Date.now,
        },
    },
    {
        timestamps: true,
    }
);

// Indexes
ContactSchema.index({ email: 1, listId: 1 }, { unique: true });
ContactSchema.index({ tags: 1 }); // NEW: Index for tags
ContactSchema.index({ brandId: 1, tags: 1 }); // NEW: Compound index for brand + tags
ContactSchema.index({ brandId: 1, status: 1 });

ContactSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

ContactSchema.pre('save', function (next) {
    // Treat status === 'unsubscribed' as the single source of truth
    if (this.status === 'unsubscribed') {
        // Ensure isUnsubscribed is synchronized
        if (!this.isUnsubscribed) {
            this.isUnsubscribed = true;
        }
        // Set unsubscribedAt exactly once when transitioning to unsubscribed
        if (!this.unsubscribedAt) {
            this.unsubscribedAt = new Date();
        }
    } else {
        // If status is not unsubscribed, ensure isUnsubscribed is false
        if (this.isUnsubscribed) {
            this.isUnsubscribed = false;
        }
    }
    next();
});

const Contact = mongoose.models.Contact || mongoose.model('Contact', ContactSchema);

export default Contact;
