const { ObjectId } = require('mongodb');
const { CardError, normalizeCardIds, cardSnapshots, tradableInventory, moveCards } = require('./cards');
const { avatarUrl, withAccountActivity } = require('./accounts');

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACCOUNT_ID = /^PPR-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TRADE_HISTORY_LIMIT = 100;
const CHAT_HISTORY_LIMIT = 100;
const ACTIVE_STATUSES = ['pending', 'negotiating'];
const SESSION_SCHEMA = 2;

class TradeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function registerTrading(app, { client, users, trades, tradeMessages, cardDefinitions, cardInstances }, { requireUser, rateLimit, signedInUser, publicPlayerFields = async () => ({ role: 'player', banned: false }) }) {
  const cardStore = { cardDefinitions, cardInstances };
  const participants = userId => ({ $or: [{ senderUserId: userId }, { recipientUserId: userId }] });
  const sameId = (first, second) => first?.toString() === second?.toString();
  const cardIds = cards => (cards ?? []).map(card => card.id).sort();
  const sameCards = (cards, ids) => JSON.stringify(cardIds(cards)) === JSON.stringify(ids);
  const isSender = (trade, userId) => sameId(trade.senderUserId, userId);

  function validateTradeId(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id)) throw new TradeError(400, 'This trade ID is invalid.');
    return new ObjectId(id);
  }

  function validateVersion(version) {
    if (!Number.isSafeInteger(version) || version < 1) throw new TradeError(400, 'Refresh this trade before continuing.');
  }

  function checkVersion(trade, version) {
    if (trade.version !== version) throw new TradeError(409, 'This trade has changed. Review the latest terms before continuing.');
  }

  function validateTokens(tokens) {
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TradeError(400, 'Use a whole token amount of zero or more.');
  }

  function assertParticipant(trade) {
    if (!trade) throw new TradeError(404, 'Trade not found.');
  }

  function assertRecipient(trade, userId) {
    if (isSender(trade, userId)) throw new TradeError(403, 'Only the invited player can join or decline this request.');
  }

  function closedError(trade) {
    if (trade.status === 'negotiating') throw new TradeError(409, 'This request has already been joined. You can cancel the session.');
    throw new TradeError(409, `This trade has already been ${trade.status}.`);
  }

  // Old requests must never carry forward assets chosen on behalf of the invited player.
  // The schema filter makes simultaneous reads and later restarts safe for negotiated sessions.
  async function upgradeRequest(trade) {
    if (!trade || trade.sessionSchema === SESSION_SCHEMA || trade.status !== 'pending') return trade;
    const result = await trades.findOneAndUpdate({ _id: trade._id, status: 'pending', sessionSchema: { $ne: SESSION_SCHEMA } }, {
      $set: {
        sessionSchema: SESSION_SCHEMA, version: 1,
        requestTerms: { offeredTokens: trade.offeredTokens ?? 0, offeredCardIds: cardIds(trade.offeredCards) },
        offeredTokens: trade.offeredTokens ?? 0, offeredCards: trade.offeredCards ?? [],
        requestedTokens: 0, requestedCards: [], senderConfirmed: false, recipientConfirmed: false,
        updatedAt: new Date()
      }
    }, { returnDocument: 'after' });
    return result || await trades.findOne({ _id: trade._id });
  }

  async function privateTrade(id, userId) {
    const trade = await upgradeRequest(await trades.findOne({ _id: id, ...participants(userId) }));
    assertParticipant(trade);
    return trade;
  }

  async function publicTrades(entries) {
    const ids = [...new Map(entries.flatMap(trade => [trade.senderUserId, trade.recipientUserId])
      .map(id => [id.toString(), id])).values()];
    const players = ids.length ? await users.find({ _id: { $in: ids } }, {
      projection: { username: 1, accountId: 1, avatarVersion: 1, role: 1, banned: 1 }
    }).toArray() : [];
    const names = new Map(players.map(player => [player._id.toString(), player.username]));
    const avatars = new Map(players.map(player => [player._id.toString(), avatarUrl(player)]));
    const fields = new Map(await Promise.all(players.map(async player => [player._id.toString(), await publicPlayerFields(player)])));
    return entries.map(trade => {
      const requestAccepted = trade.status === 'negotiating' || trade.status === 'accepted' || Boolean(trade.requestAcceptedAt);
      return {
      id: trade._id.toString(), clientOfferId: trade.clientOfferId,
      sender: { username: names.get(trade.senderUserId.toString()) ?? trade.senderUsername, accountId: trade.senderAccountId, avatarUrl: avatars.get(trade.senderUserId.toString()) ?? avatarUrl(null), ...(fields.get(trade.senderUserId.toString()) ?? { role: 'player', banned: false }) },
      recipient: { username: names.get(trade.recipientUserId.toString()) ?? trade.recipientUsername, accountId: trade.recipientAccountId, avatarUrl: avatars.get(trade.recipientUserId.toString()) ?? avatarUrl(null), ...(fields.get(trade.recipientUserId.toString()) ?? { role: 'player', banned: false }) },
      requestAccepted,
      offeredTokens: requestAccepted ? trade.offeredTokens : 0,
      requestedTokens: requestAccepted ? trade.requestedTokens : 0,
      offeredCards: requestAccepted ? trade.offeredCards ?? [] : [],
      requestedCards: requestAccepted ? trade.requestedCards ?? [] : [],
      version: trade.version ?? 0,
      senderConfirmed: trade.senderConfirmed ?? trade.status === 'accepted',
      recipientConfirmed: trade.recipientConfirmed ?? trade.status === 'accepted',
      status: trade.status,
      createdAt: trade.createdAt.toISOString(), updatedAt: trade.updatedAt.toISOString()
      };
    });
  }

  async function currentPublicUser(userId) {
    const user = await users.findOne({ _id: userId });
    if (!user) throw new TradeError(401, 'Please log in first.');
    return signedInUser(user);
  }

  async function respond(res, trade, userId, status = 200) {
    res.status(status).json({ trade: (await publicTrades([trade]))[0], user: await currentPublicUser(userId) });
  }

  function route(handler) {
    return async (req, res, next) => {
      try { await handler(req, res); }
      catch (error) {
        if (!(error instanceof TradeError) && !(error instanceof CardError)) return next(error);
        const user = await currentPublicUser(req.user._id).catch(() => null);
        res.status(error.status).json({ error: error.message, ...(user ? { user } : {}) });
      }
    };
  }

  async function transaction(callback) {
    try {
      await client.withSession(session => session.withTransaction(() => callback(session), {
        readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary'
      }));
    } catch (error) {
      if (error.code === 20 || error.code === 303) {
        throw new TradeError(503, 'Trading sessions require a MongoDB replica set. No cards or tokens were moved.');
      }
      throw error;
    }
  }

  app.get('/api/trades', requireUser, route(async (req, res) => {
    const [active, history] = await Promise.all([
      trades.find({ ...participants(req.user._id), status: { $in: ACTIVE_STATUSES } }).sort({ updatedAt: -1, _id: -1 }).toArray(),
      trades.find({ ...participants(req.user._id), status: { $nin: ACTIVE_STATUSES } }).sort({ updatedAt: -1, _id: -1 })
        .limit(TRADE_HISTORY_LIMIT).toArray()
    ]);
    const upgraded = await Promise.all(active.map(upgradeRequest));
    const unique = new Map();
    for (const trade of [...upgraded, ...history]) {
      const saved = unique.get(trade._id.toString());
      if (!saved || trade.updatedAt >= saved.updatedAt) unique.set(trade._id.toString(), trade);
    }
    const latest = [...unique.values()].sort((first, second) =>
      second.updatedAt - first.updatedAt || second._id.toString().localeCompare(first._id.toString()));
    res.json({ trades: await publicTrades(latest), user: await currentPublicUser(req.user._id) });
  }));

  app.get('/api/trades/inventory', requireUser, route(async (req, res) => {
    const owner = await users.findOne({ _id: req.user._id });
    if (!owner) throw new TradeError(401, 'Please log in first.');
    res.json(await tradableInventory(cardStore, owner));
  }));

  app.post('/api/trades', requireUser, rateLimit(60, 60 * 60 * 1000), route(async (req, res) => {
    const { offeredTokens = 0, recipientAccountId, clientOfferId } = req.body || {};
    if (Object.hasOwn(req.body || {}, 'requestedTokens') || Object.hasOwn(req.body || {}, 'requestedCardIds') ||
        Object.hasOwn(req.body || {}, 'requestedCards')) {
      throw new TradeError(400, 'Each player chooses what they give in the trade session.');
    }
    validateTokens(offeredTokens);
    const offeredCardIds = normalizeCardIds(req.body?.offeredCardIds, 'Your cards');
    if (offeredTokens !== 0 || offeredCardIds.length) {
      throw new TradeError(400, 'Choose what to give after the other player accepts your request.');
    }
    if (typeof clientOfferId !== 'string' || !UUID_V4.test(clientOfferId)) {
      throw new TradeError(400, 'This trade request ID is invalid. Please review the request again.');
    }
    if (typeof recipientAccountId !== 'string' || !ACCOUNT_ID.test(recipientAccountId)) {
      throw new TradeError(400, 'Choose a player to trade with first.');
    }
    const offerId = clientOfferId.toLowerCase();
    const recipientId = recipientAccountId.toUpperCase();

    async function replayIfSaved() {
      const saved = await upgradeRequest(await trades.findOne({ senderUserId: req.user._id, clientOfferId: offerId }));
      if (!saved) return false;
      const initial = saved.requestTerms ?? { offeredTokens: saved.offeredTokens, offeredCardIds: cardIds(saved.offeredCards) };
      if (saved.recipientAccountId !== recipientId || initial.offeredTokens !== offeredTokens ||
          JSON.stringify(initial.offeredCardIds) !== JSON.stringify(offeredCardIds)) {
        throw new TradeError(409, 'This request was already sent with different terms. Review a new request.');
      }
      await respond(res, saved, req.user._id, 201);
      return true;
    }
    if (await replayIfSaved()) return;

    const recipient = await users.findOne({ accountId: recipientId });
    if (!recipient) throw new TradeError(404, 'This player could not be found.');
    if (sameId(recipient._id, req.user._id)) throw new TradeError(400, 'You cannot trade with yourself.');
    const sender = await users.findOne({ _id: req.user._id });
    if (!sender) throw new TradeError(401, 'Please log in first.');
    let offeredCards;
    try {
      if (!Number.isSafeInteger(sender.balance) || sender.balance < offeredTokens) {
        throw new TradeError(409, 'You do not have enough tokens for this trade.');
      }
      offeredCards = await cardSnapshots(cardStore, offeredCardIds, sender);
    } catch (error) {
      if ((error instanceof TradeError || error instanceof CardError) && await replayIfSaved()) return;
      throw error;
    }
    const now = new Date();
    const trade = {
      senderUserId: sender._id, senderAccountId: sender.accountId, senderUsername: sender.username,
      recipientUserId: recipient._id, recipientAccountId: recipient.accountId, recipientUsername: recipient.username,
      clientOfferId: offerId, sessionSchema: SESSION_SCHEMA, version: 1,
      requestTerms: { offeredTokens, offeredCardIds },
      offeredTokens, offeredCards, requestedTokens: 0, requestedCards: [],
      senderConfirmed: false, recipientConfirmed: false,
      status: 'pending', createdAt: now, updatedAt: now
    };
    try { await withAccountActivity({ client, users }, [sender._id, recipient._id], session => trades.insertOne(trade, session ? { session } : {})); }
    catch (error) {
      if (error.code !== 11000 || (error.keyPattern && !error.keyPattern.clientOfferId)) throw error;
      if (await replayIfSaved()) return;
      throw error;
    }
    await respond(res, trade, req.user._id, 201);
  }));

  app.get('/api/trades/:id', requireUser, route(async (req, res) => {
    await respond(res, await privateTrade(validateTradeId(req.params.id), req.user._id), req.user._id);
  }));

  app.post('/api/trades/:id/join', requireUser, rateLimit(60, 60 * 60 * 1000), route(async (req, res) => {
    const tradeId = validateTradeId(req.params.id);
    const trade = await privateTrade(tradeId, req.user._id);
    assertRecipient(trade, req.user._id);
    if (trade.status === 'negotiating') { await respond(res, trade, req.user._id); return; }
    if (trade.status !== 'pending') closedError(trade);
    const joined = await trades.findOneAndUpdate({ _id: tradeId, status: 'pending', version: trade.version }, {
      $set: { status: 'negotiating', requestAcceptedAt: new Date(), senderConfirmed: false, recipientConfirmed: false, updatedAt: new Date() },
      $inc: { version: 1 }
    }, { returnDocument: 'after' });
    if (!joined) {
      const current = await privateTrade(tradeId, req.user._id);
      if (current.status === 'negotiating') { await respond(res, current, req.user._id); return; }
      throw new TradeError(409, 'This request changed. Refresh it before joining.');
    }
    await respond(res, joined, req.user._id);
  }));

  app.post('/api/trades/:id/contribution', requireUser, rateLimit(300, 60 * 1000), route(async (req, res) => {
    const { tokens, version } = req.body || {};
    validateTokens(tokens);
    validateVersion(version);
    const ids = normalizeCardIds(req.body?.cardIds, 'Your cards');
    const tradeId = validateTradeId(req.params.id);
    const trade = await privateTrade(tradeId, req.user._id);
    const senderSide = isSender(trade, req.user._id);
    if (!ACTIVE_STATUSES.includes(trade.status)) closedError(trade);
    if (trade.status === 'pending') throw new TradeError(403, 'Wait for the request to be accepted before choosing what to give.');
    checkVersion(trade, version);
    const tokenField = senderSide ? 'offeredTokens' : 'requestedTokens';
    const cardsField = senderSide ? 'offeredCards' : 'requestedCards';
    if (trade[tokenField] === tokens && sameCards(trade[cardsField], ids)) {
      await respond(res, trade, req.user._id);
      return;
    }
    const owner = await users.findOne({ _id: req.user._id });
    if (!owner) throw new TradeError(401, 'Please log in first.');
    if (!Number.isSafeInteger(owner.balance) || owner.balance < tokens) throw new TradeError(409, 'You do not have enough tokens for this trade.');
    const cards = await cardSnapshots(cardStore, ids, owner);
    const updated = await trades.findOneAndUpdate({ _id: tradeId, version, status: trade.status }, {
      $set: { [tokenField]: tokens, [cardsField]: cards, senderConfirmed: false, recipientConfirmed: false, updatedAt: new Date() },
      $inc: { version: 1 }
    }, { returnDocument: 'after' });
    if (!updated) throw new TradeError(409, 'This trade has changed. Review the latest terms before continuing.');
    await respond(res, updated, req.user._id);
  }));

  async function validateOwnContribution(trade, senderSide, session) {
    const userId = senderSide ? trade.senderUserId : trade.recipientUserId;
    const accountId = senderSide ? trade.senderAccountId : trade.recipientAccountId;
    const tokens = senderSide ? trade.offeredTokens : trade.requestedTokens;
    const cards = senderSide ? trade.offeredCards : trade.requestedCards;
    const owner = await users.findOne({ _id: userId, accountId }, { session });
    if (!owner || owner.banned) throw new TradeError(409, 'A player in this trade is no longer available.');
    if (!Number.isSafeInteger(owner.balance) || owner.balance < tokens) throw new TradeError(409, `${owner.username} no longer has enough tokens for this trade.`);
    const actual = await cardSnapshots(cardStore, cardIds(cards), owner, { session });
    const definitions = new Map(actual.map(card => [card.id, card.cardId]));
    if ((cards ?? []).some(card => definitions.get(card.id) !== card.cardId)) throw new TradeError(409, 'A card in this trade has changed. Choose your cards again.');
  }

  async function applyBalance(userId, accountId, outgoing, delta, session) {
    const player = await users.findOne({ _id: userId, accountId }, { session });
    if (!player || player.banned) throw new TradeError(409, 'A player in this trade is no longer available.');
    if (!Number.isSafeInteger(player.balance) || player.balance < outgoing) throw new TradeError(409, `${player.username} no longer has enough tokens for this trade.`);
    if (delta > 0 && player.balance > Number.MAX_SAFE_INTEGER - delta - (player.gamePayoutReserve ?? 0)) {
      throw new TradeError(409, "This trade would exceed a player's token balance limit.");
    }
    const updated = await users.updateOne({ _id: userId, accountId, balance: player.balance }, {
      // Equal exchanges also write both users to serialize competing trades and claims.
      $inc: { balance: delta, tokenTradeVersion: 1 }
    }, { session });
    if (!updated.matchedCount) throw new TradeError(409, 'A token balance changed. Review this trade again.');
  }

  app.post('/api/trades/:id/confirm', requireUser, rateLimit(120, 60 * 60 * 1000), route(async (req, res) => {
    const { version } = req.body || {};
    validateVersion(version);
    const tradeId = validateTradeId(req.params.id);
    await privateTrade(tradeId, req.user._id);
    let confirmed;
    await transaction(async session => {
      const trade = await trades.findOne({ _id: tradeId, ...participants(req.user._id) }, { session });
      assertParticipant(trade);
      checkVersion(trade, version);
      if (trade.status === 'accepted') { confirmed = trade; return; }
      if (trade.status !== 'negotiating') {
        if (trade.status === 'pending') throw new TradeError(409, 'The request must be accepted before confirming the trade.');
        closedError(trade);
      }
      if (trade.offeredTokens === 0 && trade.requestedTokens === 0 && !trade.offeredCards.length && !trade.requestedCards.length) {
        throw new TradeError(400, 'Add at least one card or token before confirming the trade.');
      }
      const senderSide = isSender(trade, req.user._id);
      const ownField = senderSide ? 'senderConfirmed' : 'recipientConfirmed';
      const otherField = senderSide ? 'recipientConfirmed' : 'senderConfirmed';
      if (trade[ownField]) { confirmed = trade; return; }
      await validateOwnContribution(trade, senderSide, session);
      const completes = trade[otherField];
      const updatedAt = new Date();
      const changes = { [ownField]: true, updatedAt, ...(completes ? { status: 'accepted' } : {}) };
      const updated = await trades.updateOne({ _id: tradeId, status: 'negotiating', version, [ownField]: false }, {
        $set: changes
      }, { session });
      if (!updated.matchedCount) throw new TradeError(409, 'This trade has changed. Review the latest terms before continuing.');
      if (completes) {
        const senderDelta = trade.requestedTokens - trade.offeredTokens;
        await applyBalance(trade.senderUserId, trade.senderAccountId, trade.offeredTokens, senderDelta, session);
        await applyBalance(trade.recipientUserId, trade.recipientAccountId, trade.requestedTokens, -senderDelta, session);
        const sender = { _id: trade.senderUserId, accountId: trade.senderAccountId };
        const recipient = { _id: trade.recipientUserId, accountId: trade.recipientAccountId };
        await moveCards(cardStore, trade.offeredCards, sender, recipient, session, trade._id);
        await moveCards(cardStore, trade.requestedCards, recipient, sender, session, trade._id);
      }
      confirmed = { ...trade, ...changes };
    });
    await respond(res, confirmed, req.user._id);
  }));

  for (const [action, status] of [['decline', 'declined'], ['cancel', 'cancelled']]) {
    app.post(`/api/trades/:id/${action}`, requireUser, rateLimit(60, 60 * 60 * 1000), route(async (req, res) => {
      const tradeId = validateTradeId(req.params.id);
      const trade = await privateTrade(tradeId, req.user._id);
      if (action === 'decline') assertRecipient(trade, req.user._id);
      if (trade.status === status) { await respond(res, trade, req.user._id); return; }
      const allowed = action === 'decline' ? ['pending'] : ACTIVE_STATUSES;
      if (!allowed.includes(trade.status)) closedError(trade);
      const updated = await trades.findOneAndUpdate({ _id: tradeId, status: { $in: allowed } }, {
        $set: { status, senderConfirmed: false, recipientConfirmed: false, updatedAt: new Date() }
      }, { returnDocument: 'after' });
      if (!updated) {
        const current = await privateTrade(tradeId, req.user._id);
        if (current.status === status) { await respond(res, current, req.user._id); return; }
        closedError(current);
      }
      await respond(res, updated, req.user._id);
    }));
  }

  async function publicMessages(entries) {
    const ids = [...new Map(entries.map(message => [message.senderUserId.toString(), message.senderUserId])).values()];
    const players = ids.length ? await users.find({ _id: { $in: ids } }, { projection: { username: 1, accountId: 1, avatarVersion: 1, role: 1, banned: 1 } }).toArray() : [];
    const names = new Map(players.map(player => [player._id.toString(), player.username]));
    const avatars = new Map(players.map(player => [player._id.toString(), avatarUrl(player)]));
    const fields = new Map(await Promise.all(players.map(async player => [player._id.toString(), await publicPlayerFields(player)])));
    return entries.map(message => ({
      id: message._id.toString(), clientMessageId: message.clientMessageId,
      sender: { username: names.get(message.senderUserId.toString()) ?? message.senderUsername, accountId: message.senderAccountId, avatarUrl: avatars.get(message.senderUserId.toString()) ?? avatarUrl(null), ...(fields.get(message.senderUserId.toString()) ?? { role: 'player', banned: false }) },
      body: message.body, createdAt: message.createdAt.toISOString()
    }));
  }

  app.get('/api/trades/:id/messages', requireUser, route(async (req, res) => {
    const trade = await privateTrade(validateTradeId(req.params.id), req.user._id);
    if (trade.status === 'pending') throw new TradeError(409, 'Chat opens when the invited player accepts the request.');
    const latest = await tradeMessages.find({ tradeId: trade._id }).sort({ createdAt: -1, _id: -1 }).limit(CHAT_HISTORY_LIMIT).toArray();
    res.json({ messages: await publicMessages(latest.reverse()) });
  }));

  app.post('/api/trades/:id/messages', requireUser, rateLimit(60, 60 * 1000), route(async (req, res) => {
    const tradeId = validateTradeId(req.params.id);
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const clientMessageId = req.body?.clientMessageId;
    if (!body || body.length > 1000) throw new TradeError(400, 'Messages must contain between 1 and 1,000 characters.');
    if (typeof clientMessageId !== 'string' || !UUID_V4.test(clientMessageId)) throw new TradeError(400, 'This message ID is invalid. Please try a new message.');
    const messageId = clientMessageId.toLowerCase();
    const trade = await privateTrade(tradeId, req.user._id);
    const filter = { tradeId, senderUserId: req.user._id, clientMessageId: messageId };

    async function replayIfSaved() {
      const saved = await tradeMessages.findOne(filter);
      if (!saved) return false;
      if (saved.body !== body) throw new TradeError(409, 'This message was already sent with different text.');
      res.status(201).json({ message: (await publicMessages([saved]))[0] });
      return true;
    }
    if (await replayIfSaved()) return;
    if (trade.status !== 'negotiating') throw new TradeError(409, trade.status === 'pending'
      ? 'Chat opens when the invited player accepts the request.' : 'This trade has ended. Its chat is now read-only.');
    const message = {
      _id: new ObjectId(), ...filter, body,
      senderAccountId: req.user.accountId, senderUsername: req.user.username, createdAt: new Date()
    };
    try {
      await transaction(async session => {
        // Writing the session orders new messages against cancellation and settlement.
        const active = await trades.updateOne({ _id: tradeId, ...participants(req.user._id), status: 'negotiating' }, {
          $inc: { chatSequence: 1 }
        }, { session });
        if (!active.matchedCount) throw new TradeError(409, 'This trade has ended. Its chat is now read-only.');
        await tradeMessages.insertOne(message, { session });
      });
    } catch (error) {
      if ((error.code === 11000 || error instanceof TradeError) && await replayIfSaved()) return;
      throw error;
    }
    res.status(201).json({ message: (await publicMessages([message]))[0] });
  }));
}

module.exports = { registerTrading };
