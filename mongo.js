require('dotenv').config();
const { MongoClient } = require('mongodb');

async function connectMongo(options = {}) {
  const uri = options.uri || process.env.MONGODB_URI;
  const dbName = options.dbName || process.env.MONGODB_DB || 'pepper_tcg';
  if (!uri) throw new Error('MONGODB_URI is missing. Add it to .env before starting the site.');

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    const users = db.collection('users');
    const sessions = db.collection('sessions');
    const messages = db.collection('messages');
    const verificationTokens = db.collection('verification_tokens');
    let existingIndexes = [];
    try { existingIndexes = await users.indexes(); }
    catch (error) { if (error.code !== 26) throw error; }
    const oldEmailIndex = existingIndexes.find(index => index.name === 'email_1');
    if (oldEmailIndex && !oldEmailIndex.partialFilterExpression) await users.dropIndex('email_1');
    await Promise.all([
      users.createIndex({ usernameKey: 1 }, { unique: true }),
      users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } }),
      sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      verificationTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      verificationTokens.createIndex({ userId: 1, purpose: 1 }),
      messages.createIndex({ createdAt: -1 }),
      messages.createIndex({ userId: 1, createdAt: -1 })
    ]);
    return { client, db, users, sessions, messages, verificationTokens };
  } catch (error) {
    await client.close();
    throw error;
  }
}

module.exports = { connectMongo };
