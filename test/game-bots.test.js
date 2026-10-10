const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId, MongoServerError } = require('mongodb');
const { MongoMemoryReplSet, MongoMemoryServer } = require('mongodb-memory-server');
const { createApp, connectMongo } = require('../server');
const { TURN_MS } = require('../games');

let mongo;
const password = 'game-bots-test-password';
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });

function randomSequence(...values) {
  const calls = [];
  const random = length => {
    const value = values[calls.length];
    calls.push(length);
    assert.ok(Number.isInteger(value) && value >= 0 && value < length, `Unexpected bot random call ${calls.length}: ${length}`);
    return value;
  };
  return { random, calls };
}

async function fixture(t, { randomBot = () => 0, uri = mongo.getUri() } = {}) {
  const store = await connectMongo({ uri, dbName: `game_bots_${crypto.randomBytes(5).toString('hex')}` });
  t.after(() => store.client.close());
  let time = Date.now();
  const app = createApp(store, { mailer: null, now: () => time, verifyTurnstile: async () => true, randomInt: () => 20, randomBot });
  const server = app.listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = async (route, body, cookie, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { store, api, app, advance: milliseconds => { time += milliseconds; } };
}

async function player(api, store, username, balance = 100) {
  const response = await api('/api/register', { username, password });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const saved = await store.users.findOne({ accountId: response.data.user.accountId });
  await store.users.updateOne({ _id: saved._id }, { $set: { balance } });
  return { ...response.data.user, id: saved._id, cookie: response.cookie };
}
const terms = (extra = {}) => ({ opponentType: 'bot', game: 'tic-tac-toe', stake: 10, clientRequestId: crypto.randomUUID(), ...extra });
async function start(api, actor, extra = {}) {
  const response = await api('/api/games', terms(extra), actor.cookie);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.game.status, 'playing');
  return response.data.game;
}
const move = (api, actor, game, value, clientMoveId = crypto.randomUUID()) => api(`/api/games/${game.id}/move`, {
  clientMoveId, ...(game.game === 'tic-tac-toe' ? { position: value } : { choice: value })
}, actor.cookie);
const wallet = (store, actor) => store.users.findOne({ _id: actor.id });
const document = (store, game) => store.games.findOne({ _id: new ObjectId(game.id) });

test('bot games reject unsupported types, mixed recipients, and invalid stakes without wallet changes', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'bot_validate_a');
  const b = await player(api, store, 'bot_validate_b');
  const before = await wallet(store, a);
  assert.equal((await api('/api/games', terms())).status, 401);
  for (const extra of [
    { game: 'dice', recipientAccountIds: [b.accountId] }, { game: 'dice' }, { game: 'poker' },
    { opponentType: 'robot' }, { opponentType: true }, { opponentType: null },
    { recipientAccountId: b.accountId }, { recipientAccountIds: [b.accountId] },
    { stake: 0 }, { stake: -1 }, { stake: 0.5 }, { stake: '10' }, { stake: Number.MAX_SAFE_INTEGER },
    { clientRequestId: 'bad' }
  ]) {
    const response = await api('/api/games', terms(extra), a.cookie);
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  assert.equal((await api('/api/games', terms({ stake: 101 }), a.cookie)).status, 409);
  assert.equal(await store.games.countDocuments(), 0);
  assert.deepEqual(await wallet(store, a), before);
  assert.equal(await store.users.countDocuments(), 2);
});

test('bots are synthetic participants, start immediately, match the chosen stake, and remain private', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'bot_synthetic_a');
  const outsider = await player(api, store, 'bot_synthetic_outsider');
  const outsiderBefore = await wallet(store, outsider);
  const game = await start(api, a, { game: 'rock-paper-scissors', stake: 7 });
  assert.equal(game.opponentType, 'bot');
  assert.equal(game.stake, 7);
  assert.equal(game.recipient.accountId, 'BOT');
  assert.equal(game.recipient.username, 'Bot');
  assert.equal(game.recipient.isBot, true);
  assert.equal(game.sender.accountId, a.accountId);
  assert.equal((await wallet(store, a)).balance, 93);
  assert.equal((await wallet(store, a)).gamePayoutReserve, 14);
  const saved = await document(store, game);
  assert.equal(saved.recipientUserId, 'bot');
  assert.equal(saved.escrowed, true);
  assert.equal(saved.payoutReserved, true);
  assert.equal(await store.users.countDocuments(), 2);
  assert.equal(await store.users.findOne({ $or: [{ _id: 'bot' }, { accountId: 'BOT' }] }), null);
  assert.deepEqual(await wallet(store, outsider), outsiderBefore);
  assert.equal((await api(`/api/games/${game.id}`, undefined, outsider.cookie)).status, 404);
  for (const action of ['accept', 'decline', 'cancel', 'resign', 'move']) {
    assert.equal((await api(`/api/games/${game.id}/${action}`, { clientMoveId: crypto.randomUUID(), choice: 'paper' }, outsider.cookie)).status, 404);
  }
  assert.deepEqual((await api('/api/games', undefined, outsider.cookie)).data.games, []);
  assert.equal((await api('/api/games', undefined, a.cookie)).data.games[0].recipient.isBot, true);
  const players = await api('/api/players?username=Bot', undefined, a.cookie);
  assert.equal(players.status, 200);
  assert.ok(players.data.players.every(person => person.accountId !== 'BOT'));
});

test('omitted and explicit player opponents still create invitations without automatically taking a stake', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'bot_default_a');
  const b = await player(api, store, 'bot_default_b');
  for (const opponentType of [undefined, 'player']) {
    const response = await api('/api/games', terms({ opponentType, recipientAccountId: b.accountId }), a.cookie);
    assert.equal(response.status, 201);
    assert.equal(response.data.game.status, 'pending');
    assert.notEqual(response.data.game.recipient.isBot, true);
    assert.equal(response.data.game.recipient.accountId, b.accountId);
    assert.equal((await wallet(store, a)).balance, 100);
    assert.equal((await wallet(store, b)).balance, 100);
  }
});

test('RPS hides the preselected random bot move, then immediately pays wins, losses, and draws', async t => {
  const { random, calls } = randomSequence(0, 1, 2);
  const { api, store } = await fixture(t, { randomBot: random });
  const a = await player(api, store, 'bot_rps_outcomes');
  let expectedBalance = 100;
  for (const [botChoice, humanChoice, delta, winner] of [
    ['rock', 'paper', 10, a.accountId], ['paper', 'paper', 0, null], ['scissors', 'paper', -10, 'BOT']
  ]) {
    const game = await start(api, a, { game: 'rock-paper-scissors' });
    assert.equal(game.choices, null);
    assert.equal(game.yourChoice, null);
    assert.equal(game.opponentChosen, true);
    assert.equal((await wallet(store, a)).balance, expectedBalance - 10);
    for (const exposed of [game, (await api(`/api/games/${game.id}`, undefined, a.cookie)).data.game,
      (await api('/api/games', undefined, a.cookie)).data.games.find(entry => entry.id === game.id)]) {
      assert.equal(exposed.choices, null);
      assert.ok(!JSON.stringify(exposed).includes(`"${botChoice}"`));
    }
    const response = await move(api, a, game, humanChoice);
    assert.equal(response.status, 200);
    assert.equal(response.data.game.status, 'completed');
    assert.equal(response.data.game.result, winner ? 'win' : 'draw');
    assert.equal(response.data.game.winnerAccountId, winner);
    assert.deepEqual(response.data.game.choices, { sender: humanChoice, recipient: botChoice });
    expectedBalance += delta;
    assert.equal(response.data.user.balance, expectedBalance);
    assert.equal((await wallet(store, a)).balance, expectedBalance);
    assert.equal((await wallet(store, a)).gamePayoutReserve, 0);
    assert.equal((await document(store, game)).escrowed, false);
  }
  assert.deepEqual(calls, [3, 3, 3]);
  assert.equal(await store.users.countDocuments(), 1);
});

test('a human TTT starter gets an immediate random legal bot reply and a winning move stops the bot', async t => {
  const { random, calls } = randomSequence(0, 2, 1);
  const { api, store } = await fixture(t, { randomBot: random });
  const a = await player(api, store, 'bot_ttt_human_first');
  let game = await start(api, a);
  assert.equal(game.xAccountId, a.accountId);
  assert.equal(game.turnAccountId, a.accountId);
  assert.deepEqual(game.board, Array(9).fill(null));
  const firstId = crypto.randomUUID();
  const first = await move(api, a, game, 0, firstId);
  assert.equal(first.status, 200);
  game = first.data.game;
  assert.deepEqual(game.board, ['X', null, null, 'O', null, null, null, null, null]);
  assert.equal(game.turnAccountId, a.accountId);
  assert.deepEqual((await move(api, a, game, 0, firstId)).data.game, game);
  assert.equal((await move(api, a, game, 1, firstId)).status, 409);
  assert.equal((await move(api, a, game, 3)).status, 409);
  assert.equal((await move(api, a, game, 9)).status, 400);
  game = (await move(api, a, game, 1)).data.game;
  assert.deepEqual(game.board, ['X', 'X', null, 'O', 'O', null, null, null, null]);
  const final = await move(api, a, game, 2);
  assert.equal(final.status, 200);
  assert.equal(final.data.game.status, 'completed');
  assert.equal(final.data.game.winnerAccountId, a.accountId);
  assert.deepEqual(final.data.game.board, ['X', 'X', 'X', 'O', 'O', null, null, null, null]);
  assert.equal(final.data.game.turnAccountId, null);
  assert.equal((await wallet(store, a)).balance, 110);
  assert.equal((await wallet(store, a)).gamePayoutReserve, 0);
  assert.deepEqual(calls, [2, 8, 6]);
});

test('a bot TTT starter plays X immediately, takes only empty squares, and can win without a wallet', async t => {
  const { random, calls } = randomSequence(1, 0, 0, 0);
  const { api, store } = await fixture(t, { randomBot: random });
  const a = await player(api, store, 'bot_ttt_bot_first');
  let game = await start(api, a, { stake: 1 });
  assert.equal(game.xAccountId, 'BOT');
  assert.equal(game.turnAccountId, a.accountId);
  assert.deepEqual(game.board, ['X', null, null, null, null, null, null, null, null]);
  game = (await move(api, a, game, 3)).data.game;
  assert.deepEqual(game.board, ['X', 'X', null, 'O', null, null, null, null, null]);
  const final = await move(api, a, game, 4);
  assert.equal(final.status, 200);
  assert.equal(final.data.game.status, 'completed');
  assert.equal(final.data.game.winnerAccountId, 'BOT');
  assert.deepEqual(final.data.game.board, ['X', 'X', 'X', 'O', 'O', null, null, null, null]);
  assert.equal((await wallet(store, a)).balance, 99);
  assert.equal((await wallet(store, a)).gamePayoutReserve, 0);
  assert.deepEqual(calls, [2, 9, 7, 5]);
  assert.equal(await store.users.countDocuments(), 1);
});

test('a TTT draw returns the human stake and never attempts a final bot move on a full board', async t => {
  const { random, calls } = randomSequence(0, 0, 1, 0, 0);
  const { api, store } = await fixture(t, { randomBot: random });
  const a = await player(api, store, 'bot_ttt_draw');
  let game = await start(api, a);
  for (const position of [0, 2, 3, 7, 8]) {
    const response = await move(api, a, game, position);
    assert.equal(response.status, 200);
    game = response.data.game;
  }
  assert.equal(game.status, 'completed');
  assert.equal(game.result, 'draw');
  assert.equal(game.winnerAccountId, null);
  assert.deepEqual(game.board, ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']);
  assert.equal((await wallet(store, a)).balance, 100);
  assert.equal((await wallet(store, a)).gamePayoutReserve, 0);
  assert.deepEqual(calls, [2, 8, 6, 4, 2]);
});

test('bot start and move replays remain idempotent under concurrent requests and cannot change opponents', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'bot_replay_a');
  const b = await player(api, store, 'bot_replay_b');
  const payload = terms({ game: 'rock-paper-scissors' });
  const started = await Promise.all([api('/api/games', payload, a.cookie), api('/api/games', payload, a.cookie)]);
  assert.deepEqual(started.map(response => response.status), [201, 201]);
  assert.equal(started[0].data.game.id, started[1].data.game.id);
  assert.equal(await store.games.countDocuments(), 1);
  assert.equal((await wallet(store, a)).balance, 90);
  assert.equal((await wallet(store, a)).gamePayoutReserve, 20);
  for (const change of [{ stake: 11 }, { game: 'tic-tac-toe' }, { opponentType: 'player', recipientAccountId: b.accountId }]) {
    assert.equal((await api('/api/games', { ...payload, ...change }, a.cookie)).status, 409);
  }
  const game = started[0].data.game;
  const moveId = crypto.randomUUID();
  const completed = await Promise.all([move(api, a, game, 'paper', moveId), move(api, a, game, 'paper', moveId)]);
  assert.deepEqual(completed.map(response => response.status), [200, 200]);
  assert.equal(completed[0].data.game.status, 'completed');
  assert.equal((await wallet(store, a)).balance, 110);
  assert.equal((await wallet(store, a)).gamePayoutReserve, 0);
  assert.equal((await move(api, a, game, 'scissors', moveId)).status, 409);
  assert.equal((await move(api, a, game, 'paper')).status, 409);
  assert.equal((await api('/api/games', payload, a.cookie)).data.game.status, 'completed');
  assert.equal((await wallet(store, a)).balance, 110);
});

test('competing bot starts cannot overspend a human wallet', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'bot_overspend', 10);
  const responses = await Promise.all([
    api('/api/games', terms({ game: 'rock-paper-scissors' }), a.cookie),
    api('/api/games', terms({ game: 'rock-paper-scissors' }), a.cookie)
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(await store.games.countDocuments(), 1);
  assert.equal((await wallet(store, a)).balance, 0);
  assert.equal((await wallet(store, a)).gamePayoutReserve, 20);
  assert.equal(await store.users.countDocuments(), 1);
});

test('bot opening randomness survives transaction retries and request replays', async t => {
  const { random, calls } = randomSequence(1, 4);
  const { api, store } = await fixture(t, { randomBot: random });
  const a = await player(api, store, 'bot_start_retry');
  const originalInsert = store.games.insertOne.bind(store.games);
  let attempts = 0;
  t.mock.method(store.games, 'insertOne', async (...args) => {
    if (++attempts === 1) {
      const error = new MongoServerError({ message: 'Retry bot start', code: 112 });
      error.addErrorLabel('TransientTransactionError');
      throw error;
    }
    return originalInsert(...args);
  });
  const payload = terms();
  const response = await api('/api/games', payload, a.cookie);
  assert.equal(response.status, 201);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [2, 9]);
  assert.deepEqual(response.data.game.board, [null, null, null, null, 'X', null, null, null, null]);
  assert.deepEqual((await api('/api/games', payload, a.cookie)).data.game, response.data.game);
  assert.deepEqual(calls, [2, 9]);
  assert.equal((await wallet(store, a)).balance, 90);
  assert.equal((await wallet(store, a)).gamePayoutReserve, 20);
});

test('a retried human move retains the random bot reply and records each turn once', async t => {
  const { random, calls } = randomSequence(0, 2);
  const { api, store } = await fixture(t, { randomBot: random });
  const a = await player(api, store, 'bot_move_retry');
  const game = await start(api, a);
  const originalUpdate = store.games.updateOne.bind(store.games);
  let attempts = 0;
  t.mock.method(store.games, 'updateOne', async (...args) => {
    if (args[1]?.$set?.board && ++attempts === 1) {
      const error = new MongoServerError({ message: 'Retry bot move', code: 112 });
      error.addErrorLabel('TransientTransactionError');
      throw error;
    }
    return originalUpdate(...args);
  });
  const moveId = crypto.randomUUID();
  const response = await move(api, a, game, 0, moveId);
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [2, 8]);
  assert.deepEqual(response.data.game.board, ['X', null, null, 'O', null, null, null, null, null]);
  assert.deepEqual((await move(api, a, game, 0, moveId)).data.game, response.data.game);
  const saved = await document(store, game);
  assert.equal(saved.moves.filter(turn => turn.userId.toString() === a.id.toString()).length, 1);
  assert.equal(saved.moves.filter(turn => turn.userId === 'bot').length, 1);
  assert.equal((await wallet(store, a)).balance, 90);
});

test('resigning and timing out both bot game types lose the human stake exactly once', async t => {
  const { api, store, app, advance } = await fixture(t);
  const a = await player(api, store, 'bot_forfeits');
  let expectedBalance = 100;
  for (const gameType of ['tic-tac-toe', 'rock-paper-scissors']) {
    const resigned = await start(api, a, { game: gameType });
    const route = `/api/games/${resigned.id}/resign`;
    const responses = await Promise.all([api(route, {}, a.cookie), api(route, {}, a.cookie)]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    for (const response of responses) {
      assert.equal(response.data.game.status, 'completed');
      assert.equal(response.data.game.winnerAccountId, 'BOT');
      assert.equal(response.data.game.reason, 'resign');
    }
    expectedBalance -= 10;
    assert.equal((await wallet(store, a)).balance, expectedBalance);
    const timedOut = await start(api, a, { game: gameType });
    advance(TURN_MS);
    await Promise.all([app.locals.games.expireGames(), app.locals.games.expireGames()]);
    const final = (await api(`/api/games/${timedOut.id}`, undefined, a.cookie)).data.game;
    assert.equal(final.status, 'completed');
    assert.equal(final.winnerAccountId, 'BOT');
    assert.equal(final.reason, 'timeout');
    expectedBalance -= 10;
    assert.equal((await wallet(store, a)).balance, expectedBalance);
    assert.equal((await wallet(store, a)).gamePayoutReserve, 0);
  }
  assert.equal(await store.users.countDocuments(), 1);
});

test('banning cancels live bot matches with refunds and preserves already-earned timeout losses', async t => {
  const { api, store, advance } = await fixture(t);
  const admin = await player(api, store, '675');
  const a = await player(api, store, 'bot_banned');
  const expired = await start(api, a, { game: 'rock-paper-scissors' });
  advance(TURN_MS);
  const active = await start(api, a);
  const response = await api(`/api/moderation/players/${a.accountId}`, { banned: true }, admin.cookie, 'PATCH');
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const completed = await document(store, expired);
  const cancelled = await document(store, active);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.reason, 'timeout');
  assert.equal(completed.winnerUserId, 'bot');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.reason, 'account-banned');
  assert.equal(cancelled.escrowed, false);
  assert.equal((await wallet(store, a)).balance, 90);
  assert.equal((await wallet(store, a)).gamePayoutReserve, 0);
  assert.equal((await api('/api/games', terms(), a.cookie)).status, 403);
  assert.equal(await store.users.countDocuments(), 2);
});

test('account deletion atomically closes bot games without leaving synthetic account writes or escrow', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'bot_deleted');
  const games = [await start(api, a), await start(api, a, { game: 'rock-paper-scissors' })];
  assert.equal((await wallet(store, a)).balance, 80);
  const response = await api('/api/account', { confirmation: 'DELETE', currentPassword: password }, a.cookie, 'DELETE');
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(await store.users.countDocuments(), 0);
  for (const game of games) {
    const saved = await document(store, game);
    assert.equal(saved.status, 'cancelled');
    assert.equal(saved.reason, 'account-deleted');
    assert.equal(saved.senderUsername, 'Deleted player');
    assert.equal(saved.recipientUsername, 'Bot');
    assert.equal(saved.escrowed, false);
    assert.equal(saved.payoutReserved, false);
  }
});

test('bot winnings reserve safe payout capacity, block overflowing claims, and release the reserve on settlement', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'bot_capacity', Number.MAX_SAFE_INTEGER - 10);
  const game = await start(api, a, { game: 'rock-paper-scissors' });
  assert.equal((await wallet(store, a)).gamePayoutReserve, 20);
  assert.equal((await api('/api/claim', { turnstileToken: 'fixture' }, a.cookie)).status, 409);
  const result = await move(api, a, game, 'paper');
  assert.equal(result.status, 200);
  assert.equal(result.data.user.balance, Number.MAX_SAFE_INTEGER);
  assert.equal((await wallet(store, a)).gamePayoutReserve, 0);
  const before = await wallet(store, a);
  assert.equal((await api('/api/games', terms({ game: 'rock-paper-scissors', stake: 1 }), a.cookie)).status, 409);
  assert.deepEqual(await wallet(store, a), before);
  assert.equal(await store.games.countDocuments(), 1);
});

test('standalone databases reject bot stakes without creating matches or debiting the player', async t => {
  const standalone = await MongoMemoryServer.create();
  t.after(() => standalone.stop());
  const { api, store } = await fixture(t, { uri: standalone.getUri() });
  const a = await player(api, store, 'bot_standalone');
  const response = await api('/api/games', terms({ game: 'rock-paper-scissors' }), a.cookie);
  assert.equal(response.status, 503);
  assert.equal(await store.games.countDocuments(), 0);
  assert.equal((await wallet(store, a)).balance, 100);
  assert.equal(await store.users.countDocuments(), 1);
});
