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
  await messages.deleteMany({ deleted: { $ne: true }, $or: [
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
    const trades = db.collection('trades');
    const games = db.collection('games');
    const tradeMessages = db.collection('trade_messages');
    const friendships = db.collection('friendships');
    const friendMessages = db.collection('friend_messages');
    const newsComments = db.collection('news_comments');
    const announcementSeen = db.collection('announcement_seen');
    const cardDefinitions = db.collection('card_definitions');
    const cardInstances = db.collection('card_instances');
    const cardGrants = db.collection('card_grants');
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
      users.createIndex({ balance: -1, usernameKey: 1, _id: 1 }),
      sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      sessions.createIndex({ lastSeenAt: 1, expiresAt: 1, userId: 1 }),
      verificationTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      verificationTokens.createIndex({ userId: 1, purpose: 1 }),
      messages.createIndex({ createdAt: -1, _id: -1 }),
      messages.createIndex({ userId: 1, createdAt: -1, _id: -1 }),
      messages.createIndex({ userId: 1, clientMessageId: 1 }, { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } }),
      changelog.createIndex({ createdAt: -1, _id: -1 }),
      announcements.createIndex({ createdAt: -1, _id: -1 }),
      trades.createIndex({ senderUserId: 1, clientOfferId: 1 }, { unique: true }),
      trades.createIndex({ senderUserId: 1, updatedAt: -1, _id: -1 }),
      trades.createIndex({ recipientUserId: 1, updatedAt: -1, _id: -1 }),
      games.createIndex({ senderUserId: 1, clientRequestId: 1 }, { unique: true }),
      games.createIndex({ senderUserId: 1, updatedAt: -1 }),
      games.createIndex({ recipientUserId: 1, updatedAt: -1 }),
      games.createIndex({ participantUserIds: 1, updatedAt: -1 }),
      games.createIndex({ status: 1, expiresAt: 1 }),
      tradeMessages.createIndex({ tradeId: 1, createdAt: -1, _id: -1 }),
      tradeMessages.createIndex({ tradeId: 1, senderUserId: 1, clientMessageId: 1 }, { unique: true }),
      friendships.createIndex({ pairKey: 1 }, { unique: true }),
      friendships.createIndex({ requestKeys: 1 }, { unique: true }),
      friendships.createIndex({ senderUserId: 1, status: 1 }),
      friendships.createIndex({ recipientUserId: 1, status: 1 }),
      friendMessages.createIndex({ friendshipId: 1, createdAt: -1, _id: -1 }),
      friendMessages.createIndex({ friendshipId: 1, senderUserId: 1, clientMessageId: 1 }, { unique: true }),
      friendMessages.createIndex({ senderUserId: 1, createdAt: -1, _id: -1 }),
      newsComments.createIndex({ kind: 1, entryId: 1, createdAt: 1, _id: 1 }),
      newsComments.createIndex({ kind: 1, entryId: 1, authorUserId: 1, clientMessageId: 1 }, { unique: true }),
      newsComments.createIndex({ authorUserId: 1, createdAt: -1, _id: -1 }),
      announcementSeen.createIndex({ entryId: 1, userId: 1 }, { unique: true }),
      announcementSeen.createIndex({ userId: 1, entryId: 1 }),
      cardInstances.createIndex({ ownerUserId: 1, tradable: 1, acquiredAt: -1, _id: 1 }),
      cardInstances.createIndex({ cardId: 1, ownerUserId: 1 }),
      cardGrants.createIndex({ ownerUserId: 1, createdAt: -1 })
    ]);
    await backfillAccountIds(users);
    await siteSettings.updateOne(
      { _id: CHANGELOG_SETTINGS_ID },
      { $setOnInsert: { ownerUserId: null, ownerAccountId: null } },
      { upsert: true }
    );
    await resolveChangelogOwner(users, siteSettings);
    await trimChatHistory(messages);
    return { client, db, users, sessions, messages, verificationTokens, changelog, announcements, trades, games, tradeMessages, friendships, friendMessages, newsComments, announcementSeen, cardDefinitions, cardInstances, cardGrants, siteSettings };
  } catch (error) {
    await client.close();
    throw error;
  }
}

module.exports = { connectMongo, CHAT_HISTORY_LIMIT, trimChatHistory, resolveChangelogOwner, createAccountId, ensureAccountId };
