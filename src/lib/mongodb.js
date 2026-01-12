import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    throw new Error('Please define the MONGODB_URI environment variable inside .env.local');
}

let cached = global.mongoose;

if (!cached) {
    cached = global.mongoose = { conn: null, promise: null };
}

async function connectToDatabase() {
    // Check if we have a cached connection that is actually connected
    if (cached.conn && mongoose.connection.readyState === 1) {
        return cached.conn;
    }

    // If connection exists but is not ready, clear it
    if (cached.conn && mongoose.connection.readyState !== 1) {
        cached.conn = null;
    }

    // If no in-flight connection attempt, create one
    if (!cached.promise) {
        const opts = {
            bufferCommands: false,
        };

        cached.promise = mongoose.connect(MONGODB_URI, opts)
            .then((mongoose) => {
                cached.conn = mongoose;
                cached.promise = null; // Clear promise on success
                return mongoose;
            })
            .catch((error) => {
                cached.promise = null; // Reset promise on failure to allow retries
                cached.conn = null; // Clear cached connection on failure
                throw error;
            });
    }

    // Wait for the in-flight connection attempt (shared by concurrent callers)
    return cached.promise;
}

export default connectToDatabase;
