const { ObjectId } = require('mongodb');
const crypto = require('node:crypto');
const { avatarUrl } = require('./accounts');
const { createDice, eligibleDicePlayers, recordDiceRoll, dicePayouts } = require('./dice');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACCOUNT_ID = /^PPR-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const GAME_TYPES = ['tic-tac-toe', 'rock-paper-scissors', 'dice'];
const CHOICES = ['rock', 'paper', 'scissors'];
const BOT_USER_ID = 'bot';
const BOT_ACCOUNT_ID = 'BOT';
const ACTIVE = ['pending', 'playing'];
const REQUEST_MS = 10 * 60 * 1000;
const TURN_MS = 2 * 60 * 1000;
const MAX_STAKE = Math.floor(Number.MAX_SAFE_INTEGER / 4);
const validStake = stake => Number.isSafeInteger(stake) && stake >= 1 && stake <= MAX_STAKE;
const sameId = (a, b) => a?.toString() === b?.toString();
const botMatch = match => match.opponentType === 'bot';
const participants = userId => ({ $or: [{ participantUserIds: userId }, { senderUserId: userId }, { recipientUserId: userId }] });
const matchPlayers = match => match.players ?? [
  { userId: match.senderUserId, accountId: match.senderAccountId, username: match.senderUsername, accepted: true },
  { userId: match.recipientUserId, accountId: match.recipientAccountId, username: match.recipientUsername, accepted: match.status !== 'pending', ...(botMatch(match) ? { isBot: true } : {}) }
];
const matchUserIds = match => matchPlayers(match).map(player => player.userId);
const walletUserIds = match => matchPlayers(match).filter(player => !player.isBot).map(player => player.userId);
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
async function finish(store, match, session, now, { winner = null, reason, status = 'completed', diceOutcome = null }) {
  if (!ACTIVE.includes(match.status)) return match;
  const players = matchPlayers(match);
  const pot = match.stake * players.length;
  const diceAwards = match.game === 'dice' && status === 'completed' && diceOutcome
    ? dicePayouts(diceOutcome.placements, match.stake, match.payoutMode, { draw: diceOutcome.draw, winnerAccountId: diceOutcome.winnerAccountId })
    : null;
  if (match.escrowed) {
    if (match.payoutReserved) {
      for (const id of walletUserIds(match)) {
        const released = await store.users.updateOne({ _id: id, gamePayoutReserve: { $gte: pot } }, {
          $inc: { gamePayoutReserve: -pot }
        }, { session });
        if (!released.matchedCount) throw new GameError(409, 'Token reserve unavailable.');
      }
    }
    if (diceAwards) {
      for (const award of diceAwards) await credit(store.users, players.find(player => player.accountId === award.accountId).userId, award.amount, session);
    } else if (winner) {
      if (!botMatch(match) || !sameId(winner, BOT_USER_ID)) await credit(store.users, winner, pot, session);
    } else for (const id of walletUserIds(match)) await credit(store.users, id, match.stake, session);
  }
  const update = { status, result: status === 'completed' ? diceOutcome ? diceOutcome.draw ? 'draw' : match.payoutMode === 'shared' ? 'ranked' : 'win' : winner ? 'win' : 'draw' : null,
    winnerUserId: winner, reason, escrowed: false, payoutReserved: false, expiresAt: null, turnUserId: null,
    completedAt: now, updatedAt: now, version: match.version + 1,
    ...(diceAwards ? { payouts: Object.fromEntries(diceAwards.map(award => [award.accountId, award.amount])),
      placements: diceOutcome.draw ? [] : diceOutcome.placements.map((accountId, index) => ({ accountId, place: index + 1,
        payout: diceAwards.find(award => award.accountId === accountId)?.amount ?? 0 })) } : {}) };
  await store.games.updateOne({ _id: match._id, version: match.version }, { $set: update }, { session });
  return { ...match, ...update };
}

function timeoutOutcome(match) {
  if (match.status === 'pending') return { status: 'expired', reason: 'timeout' };
  if (match.game === 'dice') return { status: 'cancelled', reason: 'timeout' };
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
    match.game !== 'dice' && match.expiresAt && match.expiresAt <= now ? timeoutOutcome(match) : { status: 'cancelled', reason });
}

async function cancelGamesForAccount(store, userId, session, now = new Date()) {
  if (!store.games) return;
  await cancelGamesForPlayer(store, userId, session, now, 'account-deleted');
  await store.games.updateMany({ senderUserId: userId }, { $set: { senderUsername: 'Deleted player' } }, { session });
  await store.games.updateMany({ recipientUserId: userId }, { $set: { recipientUsername: 'Deleted player' } }, { session });
  await store.games.updateMany({ participantUserIds: userId }, { $set: { 'players.$[player].username': 'Deleted player' } },
    { session, arrayFilters: [{ 'player.userId': userId }] });
}

function registerGames(app, store, { requireUser, rateLimit, signedInUser, publicPlayerFields = async () => ({ role: 'player', banned: false }), now = Date.now, randomDice = () => crypto.randomInt(1, 7), randomBot = length => crypto.randomInt(length) }) {
  const { client, users, games } = store;
  const currentDate = () => new Date(now());
  const otherId = (match, id) => sameId(match.senderUserId, id) ? match.recipientUserId : match.senderUserId;
  const botPick = (receipts, key, length) => {
    if (!receipts.has(key)) {
      const value = randomBot(length);
      if (!Number.isInteger(value) || value < 0 || value >= length) throw new GameError(503, 'Bot unavailable. Try later.');
      receipts.set(key, value);
    }
    return receipts.get(key);
  };
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
    const ids = [...new Map(matches.flatMap(walletUserIds).map(id => [id.toString(), id])).values()];
    const people = ids.length ? await users.find({ _id: { $in: ids } }, { projection: { username: 1, accountId: 1, avatarVersion: 1, role: 1, banned: 1 } }).toArray() : [];
    const byId = new Map(people.map(person => [person._id.toString(), person]));
    const publicFields = new Map(await Promise.all(people.map(async person => [person._id.toString(), await publicPlayerFields(person)])));
    return matches.map(match => {
      const publicPerson = player => {
        if (player.isBot) return { accountId: BOT_ACCOUNT_ID, username: 'Bot', isBot: true, avatarUrl: null, role: 'player', banned: false };
        const user = byId.get(player.userId.toString());
        return { accountId: player.accountId, username: user?.username ?? player.username, avatarUrl: avatarUrl(user),
          ...(user ? publicFields.get(user._id.toString()) : { role: 'player', banned: false }) };
      };
      const person = role => {
        return publicPerson({ userId: match[`${role}UserId`], accountId: match[`${role}AccountId`], username: match[`${role}Username`], isBot: role === 'recipient' && botMatch(match) });
      };
      const mine = sameId(match.senderUserId, viewerId) ? 'sender' : 'recipient';
      const theirs = mine === 'sender' ? 'recipient' : 'sender';
      const xUserId = match.game === 'tic-tac-toe'
        ? match.xUserId ?? (['playing', 'completed'].includes(match.status) ? match.senderUserId : null)
        : null;
      return {
        id: match._id.toString(), clientRequestId: match.clientRequestId, game: match.game, stake: match.stake, opponentType: match.opponentType ?? 'player',
        sender: person('sender'), recipient: person('recipient'), status: match.status, version: match.version,
        xAccountId: xUserId ? sameId(xUserId, match.senderUserId) ? match.senderAccountId : match.recipientAccountId : null,
        board: match.board, turnAccountId: match.turnUserId ? sameId(match.turnUserId, match.senderUserId) ? match.senderAccountId : match.recipientAccountId : null,
        winnerAccountId: match.winnerUserId ? matchPlayers(match).find(player => sameId(player.userId, match.winnerUserId))?.accountId ?? null : null,
        result: match.result ?? null, reason: match.reason ?? null,
        yourChoice: match.choices?.[mine] ?? null, opponentChosen: Boolean(match.choices?.[theirs]),
        choices: match.status === 'completed' ? match.choices ?? null : null,
        ...(match.game === 'dice' ? { players: matchPlayers(match).map(player => ({ ...publicPerson(player), accepted: player.accepted })),
          payoutMode: match.payoutMode, pot: match.stake * matchPlayers(match).length, dice: match.dice,
          eligibleAccountIds: match.status === 'playing' ? eligibleDicePlayers(match.dice, match.payoutMode, match.players.length) : [],
          placements: match.placements ?? [], payouts: match.payouts ?? null } : {}),
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
    const timeoutRolls = new Map();
    return atomic(client, async session => {
      const match = await games.findOne({ _id: id }, { session });
      const at = currentDate();
      if (!match || !ACTIVE.includes(match.status) || !match.expiresAt || match.expiresAt > at) return match;
      if (match.game === 'dice' && match.status === 'playing') {
        // Finish the current round for absent players. A revealed high roll
        // cannot be escaped by waiting, and tied players get a fresh round.
        let state = match.dice;
        let outcome;
        const moves = [...match.moves];
        for (const accountId of eligibleDicePlayers(state, match.payoutMode, match.players.length)) {
          const receipt = `${state.round}:${accountId}`;
          if (!timeoutRolls.has(receipt)) timeoutRolls.set(receipt, randomDice());
          const value = timeoutRolls.get(receipt);
          if (!Number.isInteger(value) || value < 1 || value > 6) throw new GameError(503, 'Dice unavailable. Try later.');
          const player = match.players.find(person => person.accountId === accountId);
          moves.push({ id: `timeout:${receipt}`, userId: player.userId, round: state.round, value, automatic: true });
          outcome = recordDiceRoll(state, accountId, value, match.payoutMode, match.players.length);
          state = outcome.state;
        }
        const update = { dice: state, moves, version: match.version + 1, updatedAt: at, expiresAt: new Date(at.getTime() + TURN_MS) };
        await games.updateOne({ _id: id, version: match.version }, { $set: update }, { session });
        const changed = { ...match, ...update };
        const winner = outcome?.winnerAccountId ? match.players.find(player => player.accountId === outcome.winnerAccountId).userId : null;
        return outcome?.complete ? finish(store, changed, session, at, { winner, reason: 'rolls', diceOutcome: outcome }) : changed;
      }
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
    const { game, stake, recipientAccountId, recipientAccountIds, clientRequestId, payoutMode: requestedMode, opponentType = 'player' } = req.body || {};
    if (!GAME_TYPES.includes(game)) throw new GameError(400, 'Choose a game.');
    if (!validStake(stake)) throw new GameError(400, 'Bet at least 1 token.');
    if (typeof clientRequestId !== 'string' || !UUID.test(clientRequestId)) throw new GameError(400, 'Invalid request ID.');
    if (!['player', 'bot'].includes(opponentType)) throw new GameError(400, 'Choose an opponent.');
    const withBot = opponentType === 'bot';
    if (withBot && game === 'dice') throw new GameError(400, 'Bots can only play Tic-Tac-Toe or Rock Paper Scissors.');
    if (withBot && (recipientAccountId !== undefined || recipientAccountIds !== undefined || requestedMode !== undefined)) throw new GameError(400, 'Choose either a bot or a player.');
    const requestedRecipients = withBot ? [] : game === 'dice' ? recipientAccountIds : [recipientAccountId];
    if (!withBot && (!Array.isArray(requestedRecipients) || requestedRecipients.length < 1 || requestedRecipients.length > (game === 'dice' ? 3 : 1)
      || requestedRecipients.some(accountId => typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)))) throw new GameError(400, 'Choose a player.');
    const requestId = clientRequestId.toLowerCase();
    const recipientIds = requestedRecipients.map(accountId => accountId.toUpperCase()).sort();
    if (new Set(recipientIds).size !== recipientIds.length) throw new GameError(400, 'Choose different players.');
    if (game === 'dice' && requestedMode !== undefined && !['shared', 'single-winner'].includes(requestedMode)) throw new GameError(400, 'Choose a prize mode.');
    const payoutMode = game === 'dice' ? recipientIds.length === 1 ? 'single-winner' : requestedMode ?? 'shared' : null;
    const recipientId = recipientIds[0];
    const replay = async session => {
      const saved = await games.findOne({ senderUserId: req.user._id, clientRequestId: requestId }, session ? { session } : {});
      const savedRecipients = saved && botMatch(saved) ? [] : saved?.game === 'dice' ? saved.players.slice(1).map(player => player.accountId).sort() : [saved?.recipientAccountId];
      if (saved && (saved.game !== game || saved.stake !== stake || (saved.opponentType ?? 'player') !== opponentType || JSON.stringify(savedRecipients) !== JSON.stringify(recipientIds)
        || (game === 'dice' && saved.payoutMode !== payoutMode))) throw new GameError(409, 'Request terms already saved.');
      return saved;
    };
    const botReceipts = new Map();
    let match;
    try {
      match = await atomic(client, async session => {
        const saved = await replay(session);
        if (saved) return saved;
        const sender = await users.findOne({ _id: req.user._id }, { session });
        const invitees = withBot ? [] : await users.find({ accountId: { $in: recipientIds } }, { session }).toArray();
        const byAccount = new Map(invitees.map(player => [player.accountId, player]));
        const recipients = recipientIds.map(accountId => byAccount.get(accountId));
        const recipient = withBot ? { _id: BOT_USER_ID, accountId: BOT_ACCOUNT_ID, username: 'Bot' } : recipients[0];
        if (!sender || recipients.some(player => !player)) throw new GameError(404, 'Player unavailable.');
        if (sender.banned) throw new GameError(403, 'Account banned.');
        if (recipients.some(player => player.banned)) throw new GameError(409, 'Player unavailable.');
        if (recipients.some(player => sameId(sender._id, player._id))) throw new GameError(400, 'Choose another player.');
        if (!Number.isSafeInteger(sender.balance) || sender.balance < stake) throw new GameError(409, 'Not enough tokens.');
        // Serialize invitations against account deletion and concurrent requests.
        for (const user of [sender, ...recipients].sort((a, b) => a._id.toString().localeCompare(b._id.toString()))) {
          const locked = await users.updateOne({ _id: user._id, banned: { $ne: true } }, { $inc: { activityRevision: 1 } }, { session });
          if (!locked.matchedCount) throw new GameError(409, 'Player unavailable.');
        }
        const at = currentDate();
        const document = {
          _id: new ObjectId(), clientRequestId: requestId, game, stake, opponentType, status: withBot ? 'playing' : 'pending', version: 1,
          senderUserId: sender._id, senderAccountId: sender.accountId, senderUsername: sender.username,
          recipientUserId: recipient._id, recipientAccountId: recipient.accountId, recipientUsername: recipient.username,
          board: game === 'tic-tac-toe' ? Array(9).fill(null) : null,
          choices: game === 'rock-paper-scissors' ? { sender: null, recipient: null } : null,
          turnUserId: null, winnerUserId: null, escrowed: withBot, payoutReserved: withBot, moves: [],
          ...(game === 'dice' ? { payoutMode, participantUserIds: [sender._id, ...recipients.map(player => player._id)],
            players: [sender, ...recipients].map((player, index) => ({ userId: player._id, accountId: player.accountId, username: player.username, accepted: index === 0 })),
            dice: createDice([sender.accountId, ...recipientIds]) } : {}),
          createdAt: at, updatedAt: at, expiresAt: new Date(at.getTime() + (withBot ? TURN_MS : REQUEST_MS))
        };
        if (withBot) {
          const reserved = sender.gamePayoutReserve ?? 0;
          if (!Number.isSafeInteger(reserved) || reserved < 0 || sender.balance > Number.MAX_SAFE_INTEGER - stake - reserved) throw new GameError(409, 'Token balance too large.');
          const debited = await users.updateOne({ _id: sender._id, balance: sender.balance }, {
            $inc: { balance: -stake, gamePayoutReserve: stake * 2, activityRevision: 1 }
          }, { session });
          if (!debited.matchedCount) throw new GameError(409, 'Token balance changed.');
          document.acceptedAt = at;
          if (game === 'tic-tac-toe') {
            document.xUserId = botPick(botReceipts, 'first-player', 2) === 0 ? sender._id : BOT_USER_ID;
            document.turnUserId = sender._id;
            if (sameId(document.xUserId, BOT_USER_ID)) {
              const position = botPick(botReceipts, 'opening-square', 9);
              document.board[position] = 'X';
              document.moves.push({ id: 'bot:opening', userId: BOT_USER_ID, value: position, automatic: true });
            }
          } else {
            const choice = CHOICES[botPick(botReceipts, 'rps-choice', CHOICES.length)];
            document.choices.recipient = choice;
            document.moves.push({ id: 'bot:choice', userId: BOT_USER_ID, value: choice, automatic: true });
          }
        }
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
    // Retain one choice if MongoDB retries this acceptance transaction.
    let xUserId;
    const match = await atomic(client, async session => {
      const saved = await privateMatch(id, req.user._id, session);
      if (saved.game === 'dice') {
        const actor = saved.players.find(player => sameId(player.userId, req.user._id));
        if (sameId(saved.senderUserId, req.user._id)) throw new GameError(403, 'Only invited players accept.');
        if (saved.status === 'playing' || saved.status === 'completed') {
          await lockActor(req.user._id, session);
          return saved;
        }
        if (saved.status !== 'pending') throw new GameError(409, 'Request closed.');
        if (!validStake(saved.stake)) throw new GameError(409, 'Bet at least 1 token.');
        stillOpen(saved);
        await lockActor(req.user._id, session);
        if (actor.accepted) return saved;
        const players = saved.players.map(player => sameId(player.userId, req.user._id) ? { ...player, accepted: true } : player);
        const everyoneAccepted = players.every(player => player.accepted);
        const pot = saved.stake * players.length;
        if (everyoneAccepted) {
          for (const userId of matchUserIds(saved).sort((a, b) => a.toString().localeCompare(b.toString()))) {
            const user = await users.findOne({ _id: userId }, { session });
            if (!user || user.banned) throw new GameError(409, 'Player unavailable.');
            if (!Number.isSafeInteger(user.balance) || user.balance < saved.stake) throw new GameError(409, 'Not enough tokens.');
            const reserved = user.gamePayoutReserve ?? 0;
            if (!Number.isSafeInteger(reserved) || reserved < 0 || user.balance > Number.MAX_SAFE_INTEGER - (pot - saved.stake) - reserved) throw new GameError(409, 'Token balance too large.');
            const debited = await users.updateOne({ _id: userId, balance: user.balance }, {
              $inc: { balance: -saved.stake, gamePayoutReserve: pot, activityRevision: 1 }
            }, { session });
            if (!debited.matchedCount) throw new GameError(409, 'Token balance changed.');
          }
        }
        const at = currentDate();
        const update = { players, updatedAt: at, version: saved.version + 1,
          ...(everyoneAccepted ? { status: 'playing', escrowed: true, payoutReserved: true, acceptedAt: at, expiresAt: new Date(at.getTime() + TURN_MS) } : {}) };
        await games.updateOne({ _id: id, version: saved.version }, { $set: update }, { session });
        return { ...saved, ...update };
      }
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
      if (saved.game === 'tic-tac-toe') xUserId ??= crypto.randomInt(2) === 0 ? saved.senderUserId : saved.recipientUserId;
      const update = { status: 'playing', escrowed: true, payoutReserved: true, acceptedAt: at, updatedAt: at, expiresAt: new Date(at.getTime() + TURN_MS),
        ...(saved.game === 'tic-tac-toe' ? { xUserId } : {}), turnUserId: xUserId ?? null, version: saved.version + 1 };
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
      const invited = !sameId(saved.senderUserId, req.user._id);
      if ((action === 'decline') !== invited) throw new GameError(403, 'Action unavailable.');
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
      if (saved.game === 'dice') throw new GameError(409, 'Dice matches cannot resign.');
      if (saved.status === 'completed' && saved.reason === 'resign' && !sameId(saved.winnerUserId, req.user._id)) return saved;
      if (saved.status !== 'playing') throw new GameError(409, 'Match closed.');
      stillOpen(saved);
      return finish(store, saved, session, currentDate(), { winner: otherId(saved, req.user._id), reason: 'resign' });
    });
    await respond(res, match, req.user._id);
  }));
  app.post('/api/games/:id/move', requireUser, rateLimit(60, 60 * 1000), route(async (req, res) => {
    const id = await prepare(req);
    const { clientMoveId, position, choice, round } = req.body || {};
    if (typeof clientMoveId !== 'string' || !UUID.test(clientMoveId)) throw new GameError(400, 'Invalid move ID.');
    const moveId = clientMoveId.toLowerCase();
    let rolledDice;
    const botReceipts = new Map();
    const match = await atomic(client, async session => {
      await lockActor(req.user._id, session);
      const saved = await privateMatch(id, req.user._id, session);
      if (saved.game === 'dice') {
        if (!Number.isSafeInteger(round) || round < 1) throw new GameError(400, 'Choose a valid round.');
        const replay = saved.moves.find(move => sameId(move.userId, req.user._id) && move.id === moveId);
        if (replay) {
          if (replay.round !== round) throw new GameError(409, 'Move already saved.');
          return saved;
        }
        if (saved.status !== 'playing') throw new GameError(409, 'Match closed.');
        stillOpen(saved);
        if (saved.dice.round !== round) throw new GameError(409, 'Round changed. Refresh now.');
        const actor = saved.players.find(player => sameId(player.userId, req.user._id));
        if (!eligibleDicePlayers(saved.dice, saved.payoutMode, saved.players.length).includes(actor.accountId)) throw new GameError(409, 'Roll unavailable.');
        rolledDice ??= randomDice();
        if (!Number.isInteger(rolledDice) || rolledDice < 1 || rolledDice > 6) throw new GameError(503, 'Dice unavailable. Try later.');
        const outcome = recordDiceRoll(saved.dice, actor.accountId, rolledDice, saved.payoutMode, saved.players.length);
        const at = currentDate();
        const update = { dice: outcome.state, updatedAt: at, version: saved.version + 1, expiresAt: new Date(at.getTime() + TURN_MS),
          moves: [...saved.moves, { id: moveId, userId: req.user._id, round, value: rolledDice }] };
        await games.updateOne({ _id: id, version: saved.version }, { $set: update }, { session });
        const changed = { ...saved, ...update };
        const winner = outcome.winnerAccountId ? saved.players.find(player => player.accountId === outcome.winnerAccountId).userId : null;
        return outcome.complete ? finish(store, changed, session, at, { winner, reason: 'rolls', diceOutcome: outcome }) : changed;
      }
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
        const symbol = sameId(saved.xUserId ?? saved.senderUserId, req.user._id) ? 'X' : 'O';
        update.board = [...saved.board]; update.board[position] = symbol;
        if (lines.some(line => line.every(index => update.board[index] === symbol))) { winner = req.user._id; complete = true; }
        else if (update.board.every(Boolean)) complete = true;
        update.turnUserId = otherId(saved, req.user._id);
        update.expiresAt = new Date(at.getTime() + TURN_MS);
        if (botMatch(saved) && !complete) {
          const empty = update.board.flatMap((square, index) => square === null ? [index] : []);
          const botPosition = empty[botPick(botReceipts, `square:${update.board.join(',')}`, empty.length)];
          const botSymbol = sameId(saved.xUserId, BOT_USER_ID) ? 'X' : 'O';
          update.board[botPosition] = botSymbol;
          update.moves.push({ id: `bot:${moveId}`, userId: BOT_USER_ID, value: botPosition, automatic: true });
          if (lines.some(line => line.every(index => update.board[index] === botSymbol))) { winner = BOT_USER_ID; complete = true; }
          else if (update.board.every(Boolean)) complete = true;
          update.turnUserId = saved.senderUserId;
        }
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
