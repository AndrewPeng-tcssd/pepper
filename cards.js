const { ObjectId } = require('mongodb');

const MAX_TRADE_CARDS = 50;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACCOUNT_ID = /^PPR-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DEFINITION_ID = /^[a-zA-Z0-9_-]{1,64}$/;

class CardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeCardIds(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TRADE_CARDS ||
      value.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id))) {
    throw new CardError(400, `${label} must contain up to ${MAX_TRADE_CARDS} valid card copy IDs.`);
  }
  const ids = value.map(id => id.toLowerCase()).sort();
  if (new Set(ids).size !== ids.length) throw new CardError(400, 'Each card copy can appear only once in a trade.');
  return ids;
}

function cardMetadata(definition) {
  if (!definition || typeof definition._id !== 'string' || !DEFINITION_ID.test(definition._id) ||
      typeof definition.name !== 'string' || !definition.name.trim()) return null;
  return {
    cardId: definition._id,
    name: definition.name,
    rarity: typeof definition.rarity === 'string' ? definition.rarity : 'Common',
    setName: typeof definition.setName === 'string' ? definition.setName : '',
    imageUrl: typeof definition.imageUrl === 'string' &&
      (/^https:\/\//i.test(definition.imageUrl) || /^\/(?!\/)/.test(definition.imageUrl)) ? definition.imageUrl : null
  };
}

async function cardSnapshots({ cardDefinitions, cardInstances }, ids, owner, { session, status = 409 } = {}) {
  if (!ids.length) return [];
  const copies = await cardInstances.find({
    _id: { $in: ids.map(id => new ObjectId(id)) },
    ownerUserId: owner._id, ownerAccountId: owner.accountId, tradable: true
  }, { session }).toArray();
  if (copies.length !== ids.length) throw new CardError(status, 'Some selected cards are no longer available from their owner. Refresh the cards and choose what to give again.');
  const definitions = await cardDefinitions.find({ _id: { $in: [...new Set(copies.map(copy => copy.cardId))] } }, { session }).toArray();
  const metadata = new Map(definitions.map(definition => [definition._id, cardMetadata(definition)]));
  const byId = new Map(copies.map(copy => [copy._id.toString(), copy]));
  return ids.map(id => {
    const copy = byId.get(id);
    const definition = metadata.get(copy.cardId);
    if (!definition) throw new CardError(status, 'A selected card is no longer available in the card catalog.');
    return { id, ...definition };
  });
}

async function tradableInventory({ cardDefinitions, cardInstances }, owner) {
  const copies = await cardInstances.find({ ownerUserId: owner._id, ownerAccountId: owner.accountId, tradable: true })
    .sort({ acquiredAt: -1, _id: 1 }).toArray();
  const definitions = await cardDefinitions.find({ _id: { $in: [...new Set(copies.map(copy => copy.cardId))] } }).toArray();
  const metadata = new Map(definitions.map(definition => [definition._id, cardMetadata(definition)]));
  return {
    owner: { username: owner.username, accountId: owner.accountId },
    cards: copies.filter(copy => metadata.get(copy.cardId)).map(copy => ({
      id: copy._id.toString(), ...metadata.get(copy.cardId), tradable: true,
      acquiredAt: (copy.acquiredAt ?? copy.createdAt).toISOString()
    }))
  };
}

async function moveCards({ cardDefinitions, cardInstances }, snapshots, from, to, session, tradeId) {
  if (!snapshots.length) return;
  const ids = snapshots.map(card => card.id);
  // Recheck every saved copy and its catalog entry in the same transaction as the balances.
  const current = await cardSnapshots({ cardDefinitions, cardInstances }, ids, from, { session });
  if (current.some((card, index) => card.cardId !== snapshots[index].cardId)) {
    throw new CardError(409, 'A selected card changed during this trade. Choose your cards again.');
  }
  for (const card of snapshots) {
    const result = await cardInstances.updateOne({
      _id: new ObjectId(card.id), cardId: card.cardId,
      ownerUserId: from._id, ownerAccountId: from.accountId, tradable: true
    }, { $set: {
      ownerUserId: to._id, ownerAccountId: to.accountId, acquiredAt: new Date(), lastTradeId: tradeId
    } }, { session });
    if (!result.matchedCount) throw new CardError(409, 'A selected card is no longer owned by the player in this trade.');
  }
}

// Trusted server-side catalog and issuance hooks for future pack rewards. No public mint endpoint.
async function upsertCardDefinition({ cardDefinitions }, { id, name, rarity = 'Common', setName = '', imageUrl = null }) {
  if (typeof id !== 'string' || !DEFINITION_ID.test(id) || typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
      typeof rarity !== 'string' || !rarity.trim() || rarity.trim().length > 40 ||
      typeof setName !== 'string' || setName.trim().length > 120 ||
      (imageUrl !== null && (typeof imageUrl !== 'string' || imageUrl.length > 2048 ||
        !(/^https:\/\//i.test(imageUrl) || /^\/(?!\/)/.test(imageUrl))))) {
    throw new CardError(400, 'Card definitions need a valid ID, name, rarity, set, and optional image URL.');
  }
  const definition = { name: name.trim(), rarity: rarity.trim(), setName: setName.trim(), imageUrl };
  await cardDefinitions.updateOne({ _id: id }, { $set: definition }, { upsert: true });
  return { ...definition, id };
}

function publicGrant(receipt) {
  return {
    grantId: receipt._id, ownerAccountId: receipt.ownerAccountId,
    cardInstanceIds: receipt.cardInstanceIds.map(id => id.toString()), createdAt: receipt.createdAt.toISOString()
  };
}

async function grantCards(store, { ownerAccountId, cardIds, grantId }, { session: providedSession } = {}) {
  const { client, users, cardDefinitions, cardInstances, cardGrants } = store;
  if (typeof ownerAccountId !== 'string' || !ACCOUNT_ID.test(ownerAccountId) ||
      typeof grantId !== 'string' || !UUID_V4.test(grantId) || !Array.isArray(cardIds) || !cardIds.length || cardIds.length > 100 ||
      cardIds.some(id => typeof id !== 'string' || !DEFINITION_ID.test(id))) {
    throw new CardError(400, 'A card grant needs a permanent owner ID, a unique grant ID, and 1–100 catalog card IDs.');
  }
  const accountId = ownerAccountId.toUpperCase();
  const id = grantId.toLowerCase();
  const definitionIds = [...cardIds].sort();
  function replay(saved) {
    if (saved.ownerAccountId !== accountId || JSON.stringify(saved.cardIds) !== JSON.stringify(definitionIds)) {
      throw new CardError(409, 'This card grant ID was already used with different contents or a different owner.');
    }
    // The original receipt survives later trades; retries never issue replacement copies.
    return publicGrant(saved);
  }
  async function issue(session) {
    const saved = await cardGrants.findOne({ _id: id }, { session });
    if (saved) return replay(saved);
    const owner = await users.findOne({ accountId }, { session });
    if (!owner) throw new CardError(404, 'The card recipient could not be found.');
    // Serialize issuance with account deletion, including grants from a pack transaction.
    const activeOwner = await users.updateOne({ _id: owner._id, accountId }, { $inc: { activityRevision: 1 } }, { session });
    if (!activeOwner.matchedCount) throw new CardError(404, 'The card recipient could not be found.');
    const definitions = await cardDefinitions.find({ _id: { $in: [...new Set(definitionIds)] } }, { session }).toArray();
    if (definitions.length !== new Set(definitionIds).size || definitions.some(definition => !cardMetadata(definition))) {
      throw new CardError(400, 'All granted cards must exist in the card catalog.');
    }
    const now = new Date();
    const copies = definitionIds.map(cardId => ({
      _id: new ObjectId(), cardId, ownerUserId: owner._id, ownerAccountId: owner.accountId,
      tradable: true, createdAt: now, acquiredAt: now, grantId: id
    }));
    const receipt = { _id: id, ownerUserId: owner._id, ownerAccountId: owner.accountId,
      cardIds: definitionIds, cardInstanceIds: copies.map(copy => copy._id), createdAt: now };
    await cardGrants.insertOne(receipt, { session });
    await cardInstances.insertMany(copies, { session });
    return publicGrant(receipt);
  }
  if (providedSession) {
    if (!providedSession.inTransaction()) throw new CardError(400, 'Card grants must run inside an active transaction.');
    return issue(providedSession);
  }
  try {
    return await client.withSession(session => session.withTransaction(() => issue(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary'
    }));
  } catch (error) {
    if (error.code === 11000) {
      const saved = await cardGrants.findOne({ _id: id });
      if (saved) return replay(saved);
    }
    if (error.code === 20 || error.code === 303) throw new CardError(503, 'Card grants require a MongoDB replica set. No cards were issued.');
    throw error;
  }
}

module.exports = { CardError, MAX_TRADE_CARDS, normalizeCardIds, cardSnapshots, tradableInventory, moveCards, upsertCardDefinition, grantCards };
