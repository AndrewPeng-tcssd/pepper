const { ObjectId } = require('mongodb');
const { avatarUrl } = require('./accounts');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACCOUNT_ID = /^PPR-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const GAME_TYPES = ['tic-tac-toe', 'rock-paper-scissors'];
const CHOICES = ['rock', 'paper', 'scissors'];
const ACTIVE = ['pending', 'playing'];
const REQUEST_MS = 10 * 60 * 1000;
const TURN_MS = 2 * 60 * 1000;
const MAX_STAKE = Math.floor(Number.MAX_SAFE_INTEGER / 4);
const validStake = stake => Number.isSafeInteger(stake) && stake >= 1 && stake <= MAX_STAKE;
const sameId = (a, b) => a?.toString() === b?.toString();
const participants = userId => ({ $or: [{ senderUserId: userId }, { recipientUserId: userId }] });
const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

class GameError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function atomic(client, callback) {
  try {
    return await client.withSession(session => session.withTransaction(() => callback(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary'
    }));
  } catch (error) {
    if ([20, 303].includes(error.code) || [20, 303].includes(error.originalError?.code)) {
      throw new GameError(503, 'Games unavailable. Try later.');
    }
    throw error;
  }
}

async function credit(users, userId, amount, session) {
  if (!amount) return;
  const result = await users.updateOne({ _id: userId, balance: { $lte: Number.MAX_SAFE_INTEGER - amount } }, {
    $inc: { balance: amount }
  }, { session });
  if (!result.matchedCount) throw new GameError(409, 'Token balance unavailable.');
}

// The game document and wallets always change in one transaction. A retry reads
// the terminal document and therefore cannot pay the same pot twice.
async function finish(store, match, session, now, { winner = null, reason, status = 'completed' }) {
  if (!ACTIVE.includes(match.status)) return match;
  if (match.escrowed) {
    if (match.payoutReserved) {
      for (const id of [match.senderUserId, match.recipientUserId]) {
        const released = await store.users.updateOne({ _id: id, gamePayoutReserve: { $gte: match.stake * 2 } }, {
          $inc: { gamePayoutReserve: -match.stake * 2 }
        }, { session });
        if (!released.matchedCount) throw new GameError(409, 'Token reserve unavailable.');
      }
    }
    if (winner) await credit(store.users, winner, match.stake * 2, session);
    else {
      await credit(store.users, match.senderUserId, match.stake, session);
      await credit(store.users, match.recipientUserId, match.stake, session);
    }
  }
  const update = { status, result: status === 'completed' ? winner ? 'win' : 'draw' : null,
    winnerUserId: winner, reason, escrowed: false, payoutReserved: false, expiresAt: null, turnUserId: null,
    completedAt: now, updatedAt: now, version: match.version + 1 };
  await store.games.updateOne({ _id: match._id, version: match.version }, { $set: update }, { session });
  return { ...match, ...update };
}

function timeoutOutcome(match) {
  if (match.status === 'pending') return { status: 'expired', reason: 'timeout' };
  let winner = null;
  if (match.game === 'tic-tac-toe') winner = sameId(match.turnUserId, match.senderUserId) ? match.recipientUserId : match.senderUserId;
  else if (match.choices.sender && !match.choices.recipient) winner = match.senderUserId;
  else if (match.choices.recipient && !match.choices.sender) winner = match.recipientUserId;
  return { winner, reason: 'timeout' };
}

async function cancelGamesForPlayer(store, userId, session, now = new Date(), reason = 'account-unavailable') {
  if (!store.games) return;
  const active = await store.games.find({ ...participants(userId), status: { $in: ACTIVE } }, { session }).toArray();
  for (const match of active) await finish(store, match, session, now,
    match.expiresAt && match.expiresAt <= now ? timeoutOutcome(match) : { status: 'cancelled', reason });
}

async function cancelGamesForAccount(store, userId, session, now = new Date()) {
  if (!store.games) return;
  await cancelGamesForPlayer(store, userId, session, now, 'account-deleted');
  await store.games.updateMany({ senderUserId: userId }, { $set: { senderUsername: 'Deleted player' } }, { session });
  await store.games.updateMany({ recipientUserId: userId }, { $set: { recipientUsername: 'Deleted player' } }, { session });
}

function registerGames(app, store, { requireUser, rateLimit, signedInUser, publicPlayerFields = async () => ({ role: 'player', banned: false }), now = Date.now }) {
  const { client, users, games } = store;
  const currentDate = () => new Date(now());
  const otherId = (match, id) => sameId(match.senderUserId, id) ? match.recipientUserId : match.senderUserId;
  const idFrom = value => {
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) throw new GameError(400, 'Invalid match.');
    return new ObjectId(value);
  };
  const route = handler => async (req, res, next) => {
    try { await handler(req, res); }
    catch (error) {
      if (!(error instanceof GameError)) return next(error);
      const user = req.user && await users.findOne({ _id: req.user._id });
      res.status(error.status).json({ error: error.message, ...(user ? { user: await signedInUser(user) } : {}), ...(user?.banned ? { banned: true } : {}) });
    }
  };
  const privateMatch = async (id, userId, session) => {
    const match = await games.findOne({ _id: id, ...participants(userId) }, session ? { session } : {});
    if (!match) throw new GameError(404, 'Match not found.');
    return match;
  };
  async function serialize(matches, viewerId) {
    const ids = [...new Map(matches.flatMap(match => [match.senderUserId, match.recipientUserId]).map(id => [id.toString(), id])).values()];
    const people = ids.length ? await users.find({ _id: { $in: ids } }, { projection: { username: 1, accountId: 1, avatarVersion: 1, role: 1, banned: 1 } }).toArray() : [];
    const byId = new Map(people.map(person => [person._id.toString(), person]));
    const publicFields = new Map(await Promise.all(people.map(async person => [person._id.toString(), await publicPlayerFields(person)])));
    return matches.map(match => {
      const person = role => {
        const user = byId.get(match[`${role}UserId`].toString());
        return { accountId: match[`${role}AccountId`], username: user?.username ?? match[`${role}Username`], avatarUrl: avatarUrl(user),
          ...(user ? publicFields.get(user._id.toString()) : { role: 'player', banned: false }) };
      };
      const mine = sameId(match.senderUserId, viewerId) ? 'sender' : 'recipient';
      const theirs = mine === 'sender' ? 'recipient' : 'sender';
      return {
        id: match._id.toString(), clientRequestId: match.clientRequestId, game: match.game, stake: match.stake,
        sender: person('sender'), recipient: person('recipient'), status: match.status, version: match.version,
        board: match.board, turnAccountId: match.turnUserId ? sameId(match.turnUserId, match.senderUserId) ? match.senderAccountId : match.recipientAccountId : null,
        winnerAccountId: match.winnerUserId ? sameId(match.winnerUserId, match.senderUserId) ? match.senderAccountId : match.recipientAccountId : null,
        result: match.result ?? null, reason: match.reason ?? null,
        yourChoice: match.choices?.[mine] ?? null, opponentChosen: Boolean(match.choices?.[theirs]),
        choices: match.status === 'completed' ? match.choices ?? null : null,
        createdAt: match.createdAt.toISOString(), updatedAt: match.updatedAt.toISOString(), expiresAt: match.expiresAt?.toISOString() ?? null
      };
    });
  }
  async function respond(res, match, userId, status = 200) {
    const user = await users.findOne({ _id: userId });
    if (!user) throw new GameError(401, 'Sign in required.');
    res.status(status).json({ game: (await serialize([match], userId))[0], user: await signedInUser(user) });
  }
  async function expire(id) {
    return atomic(client, async session => {
      const match = await games.findOne({ _id: id }, { session });
      const at = currentDate();
      if (!match || !ACTIVE.includes(match.status) || !match.expiresAt || match.expiresAt > at) return match;
      return finish(store, match, session, at, timeoutOutcome(match));
    });
  }
  async function expireGames(userId = null) {
    const expired = await games.find({ ...(userId ? participants(userId) : {}), status: { $in: ACTIVE }, expiresAt: { $lte: currentDate() } }, { projection: { _id: 1 } }).limit(100).toArray();
    for (const match of expired) {
      try { await expire(match._id); }
      catch (error) {
        if (!(error instanceof GameError)) throw error;
        console.error('Game settlement failed:', match._id.toString(), error.message);
      }
    }
  }
  const stillOpen = match => {
    if (match.expiresAt && match.expiresAt <= currentDate()) throw new GameError(409, 'Match expired. Refresh now.');
  };
  async function lockActor(userId, session) {
    const result = await users.updateOne({ _id: userId, banned: { $ne: true } }, { $inc: { activityRevision: 1 } }, { session });
    if (!result.matchedCount) throw new GameError(403, 'Account unavailable.');
  }
  async function prepare(req) {
    const id = idFrom(req.params.id);
    await privateMatch(id, req.user._id);
    await expire(id);
    return id;
  }

  app.get('/api/games', requireUser, route(async (req, res) => {
    await expireGames(req.user._id);
    const [active, history, user] = await Promise.all([
      games.find({ ...participants(req.user._id), status: { $in: ACTIVE } }).sort({ updatedAt: -1 }).toArray(),
      games.find({ ...participants(req.user._id), status: { $nin: ACTIVE } }).sort({ updatedAt: -1 }).limit(100).toArray(),
      users.findOne({ _id: req.user._id })
    ]);
    if (!user) throw new GameError(401, 'Sign in required.');
    const unique = new Map();
    for (const match of [...active, ...history]) if (!unique.has(match._id.toString()) || unique.get(match._id.toString()).version < match.version) unique.set(match._id.toString(), match);
    res.json({ games: await serialize([...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt), req.user._id), user: await signedInUser(user) });
  }));
  app.get('/api/games/:id', requireUser, route(async (req, res) => {
    const id = await prepare(req);
    await respond(res, await privateMatch(id, req.user._id), req.user._id);
  }));
  app.post('/api/games', requireUser, rateLimit(60, 60 * 60 * 1000), route(async (req, res) => {
    const { game, stake, recipientAccountId, clientRequestId } = req.body || {};
    if (!GAME_TYPES.includes(game)) throw new GameError(400, 'Choose a game.');
    if (!validStake(stake)) throw new GameError(400, 'Bet at least 1 token.');
    if (typeof clientRequestId !== 'string' || !UUID.test(clientRequestId)) throw new GameError(400, 'Invalid request ID.');
    if (typeof recipientAccountId !== 'string' || !ACCOUNT_ID.test(recipientAccountId)) throw new GameError(400, 'Choose a player.');
    const requestId = clientRequestId.toLowerCase();
    const recipientId = recipientAccountId.toUpperCase();
    const replay = async session => {
      const saved = await games.findOne({ senderUserId: req.user._id, clientRequestId: requestId }, session ? { session } : {});
      if (saved && (saved.game !== game || saved.stake !== stake || saved.recipientAccountId !== recipientId)) throw new GameError(409, 'Request terms already saved.');
      return saved;
    };
    let match;
    try {
      match = await atomic(client, async session => {
        const saved = await replay(session);
        if (saved) return saved;
        const sender = await users.findOne({ _id: req.user._id }, { session });
        const recipient = await users.findOne({ accountId: recipientId }, { session });
        if (!sender || !recipient) throw new GameError(404, 'Player unavailable.');
        if (sender.banned) throw new GameError(403, 'Account banned.');
        if (recipient.banned) throw new GameError(409, 'Player unavailable.');
        if (sameId(sender._id, recipient._id)) throw new GameError(400, 'Choose another player.');
        if (!Number.isSafeInteger(sender.balance) || sender.balance < stake) throw new GameError(409, 'Not enough tokens.');
        // Serialize invitations against account deletion and concurrent requests.
        for (const user of [sender, recipient].sort((a, b) => a._id.toString().localeCompare(b._id.toString()))) {
          const locked = await users.updateOne({ _id: user._id, banned: { $ne: true } }, { $inc: { activityRevision: 1 } }, { session });
          if (!locked.matchedCount) throw new GameError(409, 'Player unavailable.');
        }
        const at = currentDate();
        const document = {
          _id: new ObjectId(), clientRequestId: requestId, game, stake, status: 'pending', version: 1,
          senderUserId: sender._id, senderAccountId: sender.accountId, senderUsername: sender.username,
          recipientUserId: recipient._id, recipientAccountId: recipient.accountId, recipientUsername: recipient.username,
          board: game === 'tic-tac-toe' ? Array(9).fill(null) : null,
          choices: game === 'rock-paper-scissors' ? { sender: null, recipient: null } : null,
          turnUserId: null, winnerUserId: null, escrowed: false, moves: [],
          createdAt: at, updatedAt: at, expiresAt: new Date(at.getTime() + REQUEST_MS)
        };
        await games.insertOne(document, { session });
        return document;
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      match = await replay();
      if (!match) throw error;
    }
    await respond(res, match, req.user._id, 201);
  }));
  app.post('/api/games/:id/accept', requireUser, rateLimit(60, 60 * 1000), route(async (req, res) => {
    const id = await prepare(req);
    const match = await atomic(client, async session => {
      const saved = await privateMatch(id, req.user._id, session);
      if (!sameId(saved.recipientUserId, req.user._id)) throw new GameError(403, 'Only the invited player accepts.');
      if (saved.status === 'playing' || saved.status === 'completed') {
        await lockActor(req.user._id, session);
        return saved;
      }
      if (saved.status !== 'pending') throw new GameError(409, 'Request closed.');
      if (!validStake(saved.stake)) throw new GameError(409, 'Bet at least 1 token.');
      stillOpen(saved);
      await lockActor(req.user._id, session);
      for (const userId of [saved.senderUserId, saved.recipientUserId].sort((a, b) => a.toString().localeCompare(b.toString()))) {
        const user = await users.findOne({ _id: userId }, { session });
        if (user?.banned) throw new GameError(409, 'Player unavailable.');
        if (!user || !Number.isSafeInteger(user.balance) || user.balance < saved.stake) throw new GameError(409, 'Not enough tokens.');
        const reserved = user.gamePayoutReserve ?? 0;
        if (!Number.isSafeInteger(reserved) || reserved < 0 || user.balance > Number.MAX_SAFE_INTEGER - saved.stake - reserved) throw new GameError(409, 'Token balance too large.');
        const debited = await users.updateOne({ _id: userId, balance: user.balance }, {
          $inc: { balance: -saved.stake, gamePayoutReserve: saved.stake * 2, activityRevision: 1 }
        }, { session });
        if (!debited.matchedCount) throw new GameError(409, 'Token balance changed.');
      }
      const at = currentDate();
      const update = { status: 'playing', escrowed: true, payoutReserved: true, acceptedAt: at, updatedAt: at, expiresAt: new Date(at.getTime() + TURN_MS),
        turnUserId: saved.game === 'tic-tac-toe' ? saved.senderUserId : null, version: saved.version + 1 };
      await games.updateOne({ _id: id, version: saved.version }, { $set: update }, { session });
      return { ...saved, ...update };
    });
    await respond(res, match, req.user._id);
  }));
  for (const action of ['decline', 'cancel']) app.post(`/api/games/:id/${action}`, requireUser, route(async (req, res) => {
    const id = await prepare(req);
    const match = await atomic(client, async session => {
      await lockActor(req.user._id, session);
      const saved = await privateMatch(id, req.user._id, session);
      if ((action === 'decline') !== sameId(saved.recipientUserId, req.user._id)) throw new GameError(403, 'Action unavailable.');
      const status = action === 'decline' ? 'declined' : 'cancelled';
      if (saved.status === status) return saved;
      if (saved.status !== 'pending') throw new GameError(409, 'Request closed.');
      stillOpen(saved);
      return finish(store, saved, session, currentDate(), { status, reason: null });
    });
    await respond(res, match, req.user._id);
  }));
  app.post('/api/games/:id/resign', requireUser, route(async (req, res) => {
    const id = await prepare(req);
    const match = await atomic(client, async session => {
      await lockActor(req.user._id, session);
      const saved = await privateMatch(id, req.user._id, session);
      if (saved.status === 'completed' && saved.reason === 'resign' && !sameId(saved.winnerUserId, req.user._id)) return saved;
      if (saved.status !== 'playing') throw new GameError(409, 'Match closed.');
      stillOpen(saved);
      return finish(store, saved, session, currentDate(), { winner: otherId(saved, req.user._id), reason: 'resign' });
    });
    await respond(res, match, req.user._id);
  }));
  app.post('/api/games/:id/move', requireUser, rateLimit(60, 60 * 1000), route(async (req, res) => {
    const id = await prepare(req);
    const { clientMoveId, position, choice } = req.body || {};
    if (typeof clientMoveId !== 'string' || !UUID.test(clientMoveId)) throw new GameError(400, 'Invalid move ID.');
    const moveId = clientMoveId.toLowerCase();
    const match = await atomic(client, async session => {
      await lockActor(req.user._id, session);
      const saved = await privateMatch(id, req.user._id, session);
      const payload = saved.game === 'tic-tac-toe' ? position : choice;
      if (saved.game === 'tic-tac-toe' ? !Number.isInteger(position) || position < 0 || position > 8 : !CHOICES.includes(choice)) throw new GameError(400, 'Choose a valid move.');
      const replay = saved.moves.find(move => sameId(move.userId, req.user._id) && move.id === moveId);
      if (replay) {
        if (replay.value !== payload) throw new GameError(409, 'Move already saved.');
        return saved;
      }
      if (saved.status !== 'playing') throw new GameError(409, 'Match closed.');
      stillOpen(saved);
      const at = currentDate();
      let winner = null;
      let complete = false;
      const update = { updatedAt: at, version: saved.version + 1,
        moves: [...saved.moves, { id: moveId, userId: req.user._id, value: payload }] };
      if (saved.game === 'tic-tac-toe') {
        if (!sameId(saved.turnUserId, req.user._id)) throw new GameError(409, 'Wait for your turn.');
        if (saved.board[position] !== null) throw new GameError(409, 'Choose an empty square.');
        const symbol = sameId(saved.senderUserId, req.user._id) ? 'X' : 'O';
        update.board = [...saved.board]; update.board[position] = symbol;
        if (lines.some(line => line.every(index => update.board[index] === symbol))) { winner = req.user._id; complete = true; }
        else if (update.board.every(Boolean)) complete = true;
        update.turnUserId = otherId(saved, req.user._id);
        update.expiresAt = new Date(at.getTime() + TURN_MS);
      } else {
        const role = sameId(saved.senderUserId, req.user._id) ? 'sender' : 'recipient';
        if (saved.choices[role]) throw new GameError(409, 'Choice already submitted.');
        update.choices = { ...saved.choices, [role]: choice };
        if (update.choices.sender && update.choices.recipient) {
          complete = true;
          const { sender, recipient } = update.choices;
          if (sender !== recipient) winner = ({ rock: 'scissors', paper: 'rock', scissors: 'paper' })[sender] === recipient ? saved.senderUserId : saved.recipientUserId;
        }
      }
      await games.updateOne({ _id: id, version: saved.version }, { $set: update }, { session });
      const changed = { ...saved, ...update };
      return complete ? finish(store, changed, session, at, { winner, reason: saved.game === 'tic-tac-toe' ? 'line' : 'choices' }) : changed;
    });
    await respond(res, match, req.user._id);
  }));
  return { expireGames };
}

module.exports = { registerGames, cancelGamesForPlayer, cancelGamesForAccount, GameError, REQUEST_MS, TURN_MS };
