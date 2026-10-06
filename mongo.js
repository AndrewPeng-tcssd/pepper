require('dotenv').config();
const { MongoClient } = require('mongodb');
const crypto = require('node:crypto');

const CHAT_HISTORY_LIMIT = 100;
const CHANGELOG_SETTINGS_ID = 'changelog';
const createAccountId = () => `PPR-${crypto.randomUUID().toUpperCase()}`;
const missingAccountId = { $or: [{ accountId: { $exists: false } }, { accountId: null }, { accountId: '' }] };

async function ensureAccountId(users, user) {
  if (typeof user.accountId === 'string' && user.accountId) return user.accountId;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const accountId = createAccountId();
    try {
      const result = await users.updateOne({ _id: user._id, ...missingAccountId }, { $set: { accountId } });
      if (result.modifiedCount) {
        user.accountId = accountId;
        return accountId;
      }
      const current = await users.findOne({ _id: user._id }, { projection: { accountId: 1 } });
      if (typeof current?.accountId === 'string' && current.accountId) {
        user.accountId = current.accountId;
        return current.accountId;
      }
      throw new Error('A permanent account ID could not be assigned.');
    } catch (error) {
      if (error.code !== 11000 || !error.keyPattern?.accountId || attempt === 4) throw error;
    }
  }
}

async function backfillAccountIds(users) {
  const accounts = users.find(missingAccountId, { projection: { accountId: 1 } });
  for await (const user of accounts) await ensureAccountId(users, user);
}

async function resolveChangelogOwner(users, siteSettings) {
  const settings = await siteSettings.findOne({ _id: CHANGELOG_SETTINGS_ID });
  if (settings?.ownerAccountId) return settings.ownerAccountId;
  // Existing ownership must migrate through the stored account, never its current name.
  const originalOwner = await users.findOne(
    settings?.ownerUserId ? { _id: settings.ownerUserId } : { usernameKey: '675' },
    { projection: { accountId: 1 } }
  );
  if (!originalOwner) return null;
  const ownerAccountId = await ensureAccountId(users, originalOwner);
  await siteSettings.updateOne(
    { _id: CHANGELOG_SETTINGS_ID, ownerAccountId: null },
    { $set: { ownerAccountId, ownerUserId: originalOwner._id, ownerBoundAt: settings?.ownerBoundAt ?? new Date() } }
  );
  return (await siteSettings.findOne({ _id: CHANGELOG_SETTINGS_ID })).ownerAccountId ?? null;
}

async function trimChatHistory(messages) {
  const [oldestToKeep] = await messages.find()
    .sort({ createdAt: -1, _id: -1 })
    .skip(CHAT_HISTORY_LIMIT - 1)
    .limit(1)
    .project({ createdAt: 1 })
    .toArray();
  if (!oldestToKeep) return;
  // A cutoff preserves newer inserts when multiple sends trim at the same time.
  await messages.deleteMany({ $or: [
    { createdAt: { $lt: oldestToKeep.createdAt } },
    { createdAt: oldestToKeep.createdAt, _id: { $lt: oldestToKeep._id } }
  ] });
}

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
    const changelog = db.collection('changelog');
    const announcements = db.collection('announcements');
    const siteSettings = db.collection('site_settings');
    let existingIndexes = [];
    try { existingIndexes = await users.indexes(); }
    catch (error) { if (error.code !== 26) throw error; }
    const oldEmailIndex = existingIndexes.find(index => index.name === 'email_1');
    if (oldEmailIndex && !oldEmailIndex.partialFilterExpression) await users.dropIndex('email_1');
    await Promise.all([
      users.createIndex({ usernameKey: 1 }, { unique: true }),
      users.createIndex({ accountId: 1 }, { unique: true, partialFilterExpression: { accountId: { $type: 'string', $gt: '' } } }),
      users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } }),
      sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      sessions.createIndex({ lastSeenAt: 1, expiresAt: 1, userId: 1 }),
      verificationTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      verificationTokens.createIndex({ userId: 1, purpose: 1 }),
      messages.createIndex({ createdAt: -1, _id: -1 }),
      messages.createIndex({ userId: 1, createdAt: -1, _id: -1 }),
      changelog.createIndex({ createdAt: -1, _id: -1 }),
      announcements.createIndex({ createdAt: -1, _id: -1 })
    ]);
    await backfillAccountIds(users);
    await siteSettings.updateOne(
      { _id: CHANGELOG_SETTINGS_ID },
      { $setOnInsert: { ownerUserId: null, ownerAccountId: null } },
      { upsert: true }
    );
    await resolveChangelogOwner(users, siteSettings);
    await trimChatHistory(messages);
    return { client, db, users, sessions, messages, verificationTokens, changelog, announcements, siteSettings };
  } catch (error) {
    await client.close();
    throw error;
  }
}

module.exports = { connectMongo, CHAT_HISTORY_LIMIT, trimChatHistory, resolveChangelogOwner, createAccountId, ensureAccountId };
