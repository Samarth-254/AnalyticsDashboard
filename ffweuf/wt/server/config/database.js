const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || `mongodb://${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 27017}/${process.env.DB_NAME || 'usertracking'}`;

let client;
let db;

async function connectToMongoDB() {
    try {
        client = new MongoClient(uri);
        await client.connect();
        db = client.db(process.env.DB_NAME || 'usertracking');
        console.log('✅ Connected to MongoDB');
        return db;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        throw error;
    }
}

function getDB() {
    if (!db) {
        throw new Error('Database not initialized. Call connectToMongoDB() first.');
    }
    return db;
}

async function closeConnection() {
    if (client) {
        await client.close();
        console.log('🔌 MongoDB connection closed');
    }
}

module.exports = {
    connectToMongoDB,
    getDB,
    closeConnection,
    pool: { getConnection: () => ({ execute: () => {}, release: () => {} }) }
};
