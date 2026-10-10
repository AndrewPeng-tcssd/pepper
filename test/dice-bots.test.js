const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId, MongoServerError } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp, connectMongo } = require('../server');
const { REQUEST_MS, TURN_MS } = require('../games');

let mongo;
const password = 'dice-bots-test-password';
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });

async function fixture(t) {
  const store = await connectMongo({ uri: mongo.getUri(), dbName: `dice_bots_${crypto.randomBytes(5).toString('hex')}` });
  t.after(() => store.client.close());
  let time = Date.now();
  let rolls = [];
  let calls = 0;
  const app = createApp(store, { mailer: null, now: () => time, verifyTurnstile: async () => true,
    randomDice: () => {
      calls += 1;
      const value = rolls.shift();
      assert.ok(Number.isInteger(value) && value >= 1 && value <= 6, `Unexpected die sample ${calls}: ${value}`);
      return value;
    } });
  const server = app.listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = async (route, body, cookie, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { store, api, app, advance: milliseconds => { time += milliseconds; }, roll: (...values) => { rolls = values; }, calls: () => calls };
}
async function player(f, username, balance = 100) {
  const response = await f.api('/api/register', { username, password });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const saved = await f.store.users.findOne({ accountId: response.data.user.accountId });
  await f.store.users.updateOne({ _id: saved._id }, { $set: { balance } });
  return { ...response.data.user, id: saved._id, cookie: response.cookie };
}
const terms = extra => ({ opponentType: 'bot', game: 'dice', stake: 10, clientRequestId: crypto.randomUUID(), ...extra });
async function create(f, actor, extra = {}) {
  const response = await f.api('/api/games', terms(extra), actor.cookie);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.game;
}
async function accept(f, actor, game) {
  const response = await f.api(`/api/games/${game.id}/accept`, {}, actor.cookie);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.game;
}
const move = (f, actor, game, round = game.dice.round, clientMoveId = crypto.randomUUID()) =>
  f.api(`/api/games/${game.id}/move`, { round, clientMoveId }, actor.cookie);
async function rolling(f, actor, game, ...values) {
  f.roll(...values);
  const response = await move(f, actor, game);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.game;
}
const balances = (f, people) => Promise.all(people.map(async actor => (await f.store.users.findOne({ _id: actor.id }))?.balance));
const reserves = (f, people) => Promise.all(people.map(async actor => (await f.store.users.findOne({ _id: actor.id }))?.gamePayoutReserve ?? 0));
const savedGame = (f, game) => f.store.games.findOne({ _id: new ObjectId(game.id) });

test('Dice validates bot counts, mixed rosters, supported modes, and immutable replay terms', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_bot_validate_a'); const b = await player(f, 'dice_bot_validate_b');
  const c = await player(f, 'dice_bot_validate_c');
  for (const extra of [
    { botCount: 0 }, { botCount: -1 }, { botCount: 4 }, { botCount: 1.5 }, { botCount: '1' }, { botCount: null },
    { recipientAccountIds: [b.accountId] }, { recipientAccountId: b.accountId }, { payoutMode: 'invalid' },
    { opponentType: 'mixed', botCount: 0, recipientAccountIds: [b.accountId] },
    { opponentType: 'mixed', botCount: 3, recipientAccountIds: [b.accountId] },
    { opponentType: 'mixed', botCount: 1, recipientAccountIds: [] },
    { opponentType: 'mixed', botCount: 1, recipientAccountIds: [a.accountId] },
    { opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId, b.accountId] },
    { opponentType: 'mixed', botCount: 2, recipientAccountIds: [b.accountId, c.accountId] },
    { opponentType: 'mixed', botCount: 1, recipientAccountIds: ['BOT-1'] },
    { opponentType: 'mixed', botCount: 1, recipientAccountIds: b.accountId },
    { opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId], game: 'rock-paper-scissors' },
    { opponentType: 'player', botCount: 1, recipientAccountIds: [b.accountId] }
  ]) {
    assert.equal((await f.api('/api/games', terms(extra), a.cookie)).status, 400, JSON.stringify(extra));
  }
  assert.equal(await f.store.games.countDocuments(), 0);
  assert.deepEqual(await balances(f, [a, b, c]), [100, 100, 100]);
  f.roll(1, 2);
  const payload = terms({ botCount: 2 });
  const response = await f.api('/api/games', payload, a.cookie);
  assert.equal(response.status, 201);
  assert.equal((await f.api('/api/games', payload, a.cookie)).data.game.id, response.data.game.id);
  assert.equal(f.calls(), 2);
  for (const extra of [{ botCount: 1 }, { stake: 11 }, { payoutMode: 'single-winner' },
    { opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId] }]) {
    assert.equal((await f.api('/api/games', { ...payload, ...extra }, a.cookie)).status, 409);
  }
  const ordinary = terms({ opponentType: 'player', botCount: 0, recipientAccountIds: [b.accountId] });
  assert.equal((await f.api('/api/games', ordinary, a.cookie)).status, 201);
});

test('pure bot Dice fills two to four seats, rolls instantly, and reserves only the real wallet', async t => {
  const f = await fixture(t);
  for (const botCount of [1, 2, 3]) {
    const a = await player(f, `dice_bot_roster_${botCount}`);
    f.roll(...Array.from({ length: botCount }, (_, index) => index + 1));
    const game = await create(f, a, botCount === 1 ? {} : { botCount });
    assert.equal(game.status, 'playing'); assert.equal(game.opponentType, 'bot');
    assert.equal(game.players.length, botCount + 1); assert.equal(game.pot, 10 * (botCount + 1));
    assert.deepEqual(game.players.map(person => person.accepted), Array(botCount + 1).fill(true));
    const bots = game.players.filter(person => person.isBot);
    assert.equal(bots.length, botCount);
    assert.deepEqual(bots.map(person => person.username), botCount === 1 ? ['Bot'] : ['Bot #1', 'Bot #2', 'Bot #3'].slice(0, botCount));
    assert.deepEqual(bots.map(person => person.accountId), botCount === 1 ? ['BOT'] : ['BOT-1', 'BOT-2', 'BOT-3'].slice(0, botCount));
    assert.ok(bots.every(person => person.avatarUrl === null && person.role === 'player' && person.banned === false));
    assert.deepEqual(game.eligibleAccountIds, [a.accountId]);
    assert.deepEqual(Object.values(game.dice.rolls), Array.from({ length: botCount }, (_, index) => index + 1));
    assert.deepEqual(await balances(f, [a]), [90]); assert.deepEqual(await reserves(f, [a]), [game.pot]);
    const saved = await savedGame(f, game);
    assert.equal(saved.moves.filter(receipt => receipt.automatic).length, botCount);
    assert.deepEqual(saved.players.filter(person => person.isBot).map(person => person.userId), botCount === 1 ? ['bot'] : ['bot:1', 'bot:2', 'bot:3'].slice(0, botCount));
  }
  assert.equal(await f.store.users.countDocuments(), 3);
  assert.equal(await f.store.users.countDocuments({ accountId: /^BOT/ }), 0);
});

test('bot Dice records virtual prizes but only real winners receive wallet credits', async t => {
  const f = await fixture(t);
  for (const [botCount, payoutMode, humanWins, expectedBalance] of [
    [1, 'single-winner', true, 110], [1, 'single-winner', false, 90],
    [2, 'shared', true, 110], [3, 'shared', true, 107],
    [3, 'single-winner', true, 130], [3, 'single-winner', false, 90]
  ]) {
    f.advance(15 * 60 * 1000);
    const a = await player(f, `dbp_${botCount}_${payoutMode === 'shared' ? 's' : 'w'}_${humanWins ? 'win' : 'loss'}`);
    f.roll(...Array.from({ length: botCount }, (_, index) => humanWins ? index + 1 : 6 - index));
    let game = await create(f, a, { botCount, payoutMode });
    game = await rolling(f, a, game, humanWins ? 6 : 1);
    assert.equal(game.status, 'completed');
    assert.equal(game.winnerAccountId, humanWins ? a.accountId : botCount === 1 ? 'BOT' : 'BOT-1');
    assert.equal(Object.keys(game.payouts).length, botCount + 1);
    assert.deepEqual(await balances(f, [a]), [expectedBalance]); assert.deepEqual(await reserves(f, [a]), [0]);
    assert.equal((await savedGame(f, game)).escrowed, false);
    assert.equal((await savedGame(f, game)).payoutReserved, false);
  }
  assert.equal(await f.store.users.countDocuments(), 6);
});

test('shared initial ties refund humans for two, three, and four participants', async t => {
  const f = await fixture(t);
  for (const botCount of [1, 2, 3]) {
    const a = await player(f, `dice_bot_draw_${botCount}`);
    f.roll(...Array(botCount).fill(4));
    let game = await create(f, a, { botCount });
    game = await rolling(f, a, game, 4);
    assert.equal(game.result, 'draw'); assert.equal(game.winnerAccountId, null);
    assert.deepEqual(Object.values(game.payouts), Array(botCount + 1).fill(10));
    assert.deepEqual(await balances(f, [a]), [100]); assert.deepEqual(await reserves(f, [a]), [0]);
  }
});

test('bot-only tied leaders reroll instantly until a shared or single-winner game finishes', async t => {
  const f = await fixture(t);
  for (const payoutMode of ['shared', 'single-winner']) {
    const a = await player(f, `db_playoff_${payoutMode === 'shared' ? 's' : 'w'}`);
    f.roll(6, 6);
    let game = await create(f, a, { botCount: 2, payoutMode });
    game = await rolling(f, a, game, 1, 3, 3, 2, 5);
    assert.equal(game.status, 'completed'); assert.equal(game.dice.history.length, 3);
    assert.equal(game.winnerAccountId, 'BOT-2');
    assert.deepEqual(game.placements.map(person => person.accountId), ['BOT-2', 'BOT-1', a.accountId]);
    assert.deepEqual(game.placements.map(person => person.payout), payoutMode === 'shared' ? [20, 10, 0] : [30, 0, 0]);
    assert.deepEqual(await balances(f, [a]), [90]); assert.deepEqual(await reserves(f, [a]), [0]);
    const saved = await savedGame(f, game);
    assert.equal(saved.moves.filter(receipt => receipt.automatic).length, 6);
    assert.equal(saved.moves.filter(receipt => !receipt.automatic).length, 1);
  }
});

test('a tie involving a human opens a new round with the bot roll already taken', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_bot_human_playoff');
  f.roll(6, 1);
  let game = await create(f, a, { botCount: 2, payoutMode: 'single-winner' });
  const moveId = crypto.randomUUID(); f.roll(6, 2);
  let response = await move(f, a, game, 1, moveId);
  assert.equal(response.status, 200); game = response.data.game;
  assert.equal(game.status, 'playing'); assert.equal(game.dice.round, 2);
  assert.deepEqual(game.dice.rolls, { 'BOT-1': 2 }); assert.deepEqual(game.eligibleAccountIds, [a.accountId]);
  const beforeCalls = f.calls();
  response = await move(f, a, game, 1, moveId);
  assert.equal(response.status, 200); assert.deepEqual(response.data.game, game); assert.equal(f.calls(), beforeCalls);
  game = await rolling(f, a, game, 5);
  assert.equal(game.winnerAccountId, a.accountId); assert.deepEqual(await balances(f, [a]), [120]);
});

test('mixed Dice waits for real invitees and accepts bot seats without taking any stake early', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_mixed_host'); const b = await player(f, 'dice_mixed_guest');
  const c = await player(f, 'dice_mixed_second_guest'); const outsider = await player(f, 'dice_mixed_outsider');
  const recipientIds = [b.accountId, c.accountId].sort();
  let game = await create(f, a, { opponentType: 'mixed', botCount: 1, recipientAccountIds: [...recipientIds].reverse() });
  assert.equal(game.status, 'pending'); assert.equal(game.opponentType, 'mixed');
  assert.equal(game.sender.accountId, a.accountId); assert.equal(game.recipient.accountId, recipientIds[0]);
  assert.deepEqual(game.players.map(person => person.accountId), [a.accountId, ...recipientIds, 'BOT-1']);
  assert.deepEqual(game.players.map(person => person.accepted), [true, false, false, true]);
  assert.equal(game.players[3].username, 'Bot #1'); assert.equal(game.players[3].accountId, 'BOT-1');
  assert.equal(game.players[3].isBot, true); assert.equal(f.calls(), 0);
  assert.deepEqual(await balances(f, [a, b, c]), [100, 100, 100]);
  assert.deepEqual(await reserves(f, [a, b, c]), [0, 0, 0]);
  const replay = await create(f, a, { opponentType: 'mixed', botCount: 1, recipientAccountIds: recipientIds, clientRequestId: game.clientRequestId });
  assert.equal(replay.id, game.id); assert.deepEqual(replay.players, game.players); assert.equal(f.calls(), 0);
  assert.equal((await f.api(`/api/games/${game.id}`, undefined, outsider.cookie)).status, 404);
  assert.deepEqual((await f.api('/api/games', undefined, outsider.cookie)).data.games, []);
  assert.equal((await f.api(`/api/games/${game.id}/accept`, {}, a.cookie)).status, 403);
  game = await accept(f, b, game); assert.equal(game.status, 'pending'); assert.equal(f.calls(), 0);
  assert.equal(game.players.find(person => person.accountId === b.accountId).accepted, true);
  assert.equal(game.players.find(person => person.accountId === c.accountId).accepted, false);
  f.roll(2);
  game = await accept(f, c, game);
  assert.equal(game.status, 'playing'); assert.equal(game.pot, 40);
  assert.deepEqual(game.dice.rolls, { 'BOT-1': 2 });
  assert.deepEqual(game.eligibleAccountIds, [a.accountId, ...recipientIds]);
  assert.deepEqual(await balances(f, [a, b, c]), [90, 90, 90]);
  assert.deepEqual(await reserves(f, [a, b, c]), [40, 40, 40]);
  const beforeCalls = f.calls();
  game = await accept(f, c, game); assert.equal(game.status, 'playing'); assert.equal(f.calls(), beforeCalls);
  assert.equal(await f.store.users.countDocuments(), 4);
});

test('one invited person and two bots settle real placement prizes while bot-only lower slots finish instantly', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_fill_host'); const b = await player(f, 'dice_fill_guest');
  let game = await create(f, a, { opponentType: 'mixed', botCount: 2, recipientAccountIds: [b.accountId] });
  f.roll(1, 1); game = await accept(f, b, game);
  assert.deepEqual(game.players.map(person => person.username), [a.username, b.username, 'Bot #1', 'Bot #2']);
  game = await rolling(f, a, game, 6);
  game = await rolling(f, b, game, 4, 6, 2);
  assert.equal(game.status, 'completed'); assert.equal(game.dice.history.length, 2);
  assert.deepEqual(game.placements.map(person => person.accountId), [a.accountId, b.accountId, 'BOT-1', 'BOT-2']);
  assert.deepEqual(game.placements.map(person => person.payout), [17, 13, 9, 0]);
  assert.deepEqual(await balances(f, [a, b]), [107, 103]); assert.deepEqual(await reserves(f, [a, b]), [0, 0]);
  assert.equal(await f.store.users.countDocuments(), 2);
  const after = await balances(f, [a, b]);
  await f.app.locals.games.expireGames(); assert.deepEqual(await balances(f, [a, b]), after);
});

test('mixed single-winner games award the entire virtual pot to the winning real participant', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_mixed_single_a'); const b = await player(f, 'dice_mixed_single_b');
  let game = await create(f, a, { opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId], payoutMode: 'single-winner' });
  f.roll(2); game = await accept(f, b, game);
  game = await rolling(f, a, game, 1);
  game = await rolling(f, b, game, 6);
  assert.equal(game.winnerAccountId, b.accountId);
  assert.deepEqual(game.payouts, { [b.accountId]: 30, 'BOT-1': 0, [a.accountId]: 0 });
  assert.deepEqual(await balances(f, [a, b]), [90, 120]); assert.deepEqual(await reserves(f, [a, b]), [0, 0]);
});

test('mixed replay compares humans and bot count, and concurrent acceptance debits stakes once', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_mixed_replay_a'); const b = await player(f, 'dice_mixed_replay_b');
  const c = await player(f, 'dice_mixed_replay_c');
  const payload = terms({ opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId] });
  const responses = await Promise.all([f.api('/api/games', payload, a.cookie), f.api('/api/games', payload, a.cookie)]);
  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  assert.equal(responses[0].data.game.id, responses[1].data.game.id); assert.equal(await f.store.games.countDocuments(), 1);
  for (const extra of [{ botCount: 2 }, { recipientAccountIds: [c.accountId] }, { opponentType: 'player', botCount: 0 }]) {
    assert.equal((await f.api('/api/games', { ...payload, ...extra }, a.cookie)).status, 409);
  }
  f.roll(1, 2, 3, 4);
  const game = responses[0].data.game;
  const started = await Promise.all([accept(f, b, game), accept(f, b, game)]);
  assert.ok(started.every(match => match.status === 'playing'));
  assert.deepEqual(await balances(f, [a, b]), [90, 90]); assert.deepEqual(await reserves(f, [a, b]), [30, 30]);
  assert.equal((await savedGame(f, game)).moves.filter(receipt => receipt.automatic).length, 1);
});

test('creation and playoff transaction retries retain every cached bot die exactly once', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_bot_retry');
  f.roll(6, 6, 1, 1);
  const originalInsert = f.store.games.insertOne.bind(f.store.games); let insertAttempts = 0;
  const insertMock = t.mock.method(f.store.games, 'insertOne', async (...args) => {
    if (++insertAttempts === 1) {
      const error = new MongoServerError({ message: 'Retry bot creation', code: 112 }); error.addErrorLabel('TransientTransactionError'); throw error;
    }
    return originalInsert(...args);
  });
  const payload = terms({ botCount: 2 });
  let response = await f.api('/api/games', payload, a.cookie);
  assert.equal(response.status, 201); assert.equal(insertAttempts, 2); assert.equal(f.calls(), 2);
  let game = response.data.game; assert.deepEqual(game.dice.rolls, { 'BOT-1': 6, 'BOT-2': 6 });
  insertMock.mock.restore();
  assert.equal((await f.api('/api/games', payload, a.cookie)).data.game.id, game.id); assert.equal(f.calls(), 2);
  const originalUpdate = f.store.games.updateOne.bind(f.store.games); let updateAttempts = 0;
  t.mock.method(f.store.games, 'updateOne', async (...args) => {
    if (args[1].$set?.dice && ++updateAttempts === 1) {
      const error = new MongoServerError({ message: 'Retry bot playoff', code: 112 }); error.addErrorLabel('TransientTransactionError'); throw error;
    }
    return originalUpdate(...args);
  });
  f.roll(1, 2, 5, 6, 6, 6);
  const moveId = crypto.randomUUID();
  response = await move(f, a, game, 1, moveId);
  assert.equal(response.status, 200); assert.equal(updateAttempts, 2); assert.equal(f.calls(), 5);
  game = response.data.game; assert.equal(game.status, 'completed'); assert.equal(game.winnerAccountId, 'BOT-2');
  assert.deepEqual(game.dice.history[1].rolls, { 'BOT-1': 2, 'BOT-2': 5 });
  assert.equal((await move(f, a, game, 1, moveId)).status, 200); assert.equal(f.calls(), 5);
  const saved = await savedGame(f, game);
  assert.equal(saved.moves.length, 5); assert.deepEqual(await balances(f, [a]), [90]);
});

test('concurrent final human rolls settle mixed bot awards once and preserve move receipts', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_bot_final_a'); const b = await player(f, 'dice_bot_final_b');
  let game = await create(f, a, { opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId], payoutMode: 'single-winner' });
  f.roll(1); game = await accept(f, b, game); game = await rolling(f, a, game, 2);
  const moveId = crypto.randomUUID(); f.roll(6, 6);
  const responses = await Promise.all([move(f, b, game, 1, moveId), move(f, b, game, 1, moveId)]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.ok(responses.every(response => response.data.game.status === 'completed'));
  assert.deepEqual(await balances(f, [a, b]), [90, 120]); assert.deepEqual(await reserves(f, [a, b]), [0, 0]);
  assert.equal((await savedGame(f, game)).moves.length, 3);
  assert.equal((await move(f, b, game, 2, moveId)).status, 409);
});

test('retried final mixed acceptance retains the opening bot dice and debits each real wallet once', async t => {
  const f = await fixture(t); const a = await player(f, 'db_accept_retry_a'); const b = await player(f, 'db_accept_retry_b');
  let game = await create(f, a, { opponentType: 'mixed', botCount: 2, recipientAccountIds: [b.accountId] });
  const originalUpdate = f.store.games.updateOne.bind(f.store.games); let attempts = 0;
  t.mock.method(f.store.games, 'updateOne', async (...args) => {
    if (args[1].$set?.dice && ++attempts === 1) {
      const error = new MongoServerError({ message: 'Retry mixed acceptance', code: 112 }); error.addErrorLabel('TransientTransactionError'); throw error;
    }
    return originalUpdate(...args);
  });
  f.roll(3, 4, 1, 1); game = await accept(f, b, game);
  assert.equal(attempts, 2); assert.equal(f.calls(), 2);
  assert.deepEqual(game.dice.rolls, { 'BOT-1': 3, 'BOT-2': 4 });
  assert.deepEqual(await balances(f, [a, b]), [90, 90]); assert.deepEqual(await reserves(f, [a, b]), [40, 40]);
  assert.equal((await savedGame(f, game)).moves.length, 2);
});

test('a broken die source cannot trap bot-only playoffs or partially record moves and payouts', async t => {
  const f = await fixture(t); const a = await player(f, 'db_endless_tie');
  f.roll(6, 6); let game = await create(f, a, { botCount: 2, payoutMode: 'single-winner' });
  const before = await savedGame(f, game); const moveId = crypto.randomUUID();
  f.roll(1, ...Array(110).fill(6));
  assert.equal((await move(f, a, game, 1, moveId)).status, 503);
  assert.deepEqual(await savedGame(f, game), before);
  assert.deepEqual(await balances(f, [a]), [90]); assert.deepEqual(await reserves(f, [a]), [30]);
  f.roll(1, 2, 5);
  const response = await move(f, a, game, 1, moveId);
  assert.equal(response.status, 200); game = response.data.game;
  assert.equal(game.status, 'completed'); assert.equal(game.winnerAccountId, 'BOT-2');
  assert.deepEqual(await balances(f, [a]), [90]); assert.deepEqual(await reserves(f, [a]), [0]);
});

test('full virtual pots reserve safe capacity, prevent oversized awards, and cannot overspend wallets', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_bot_capacity', Number.MAX_SAFE_INTEGER - 29);
  assert.equal((await f.api('/api/games', terms({ botCount: 3, payoutMode: 'single-winner' }), a.cookie)).status, 409);
  assert.equal(f.calls(), 0);
  await f.store.users.updateOne({ _id: a.id }, { $set: { balance: Number.MAX_SAFE_INTEGER - 30 } });
  f.roll(1, 2, 3);
  let game = await create(f, a, { botCount: 3, payoutMode: 'single-winner' });
  assert.deepEqual(await reserves(f, [a]), [40]);
  assert.equal((await f.api('/api/claim', { turnstileToken: 'fixture' }, a.cookie)).status, 409);
  game = await rolling(f, a, game, 6);
  assert.equal(game.winnerAccountId, a.accountId); assert.deepEqual(await balances(f, [a]), [Number.MAX_SAFE_INTEGER]);
  assert.deepEqual(await reserves(f, [a]), [0]);
  const b = await player(f, 'dice_bot_no_overspend', 10); f.roll(1, 2, 3, 4);
  const starts = await Promise.all([f.api('/api/games', terms(), b.cookie), f.api('/api/games', terms(), b.cookie)]);
  assert.deepEqual(starts.map(response => response.status).sort(), [201, 409]);
  assert.deepEqual(await balances(f, [b]), [0]); assert.deepEqual(await reserves(f, [b]), [20]);
});

test('mixed acceptance checks real balances and declines or cancellation leave bots without escrow', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_bot_funds_a'); const b = await player(f, 'dice_bot_funds_b', 9);
  let game = await create(f, a, { opponentType: 'mixed', botCount: 2, recipientAccountIds: [b.accountId] });
  assert.equal((await f.api(`/api/games/${game.id}/accept`, {}, b.cookie)).status, 409);
  assert.deepEqual(await balances(f, [a, b]), [100, 9]); assert.equal(f.calls(), 0);
  assert.equal((await f.api(`/api/games/${game.id}/decline`, {}, b.cookie)).data.game.status, 'declined');
  game = await create(f, a, { opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId] });
  assert.equal((await f.api(`/api/games/${game.id}/cancel`, {}, a.cookie)).data.game.status, 'cancelled');
  assert.deepEqual(await reserves(f, [a, b]), [0, 0]); assert.equal(f.calls(), 0);
});

test('pending mixed invitations expire without bot rolls and playing timeouts roll only missing humans', async t => {
  const f = await fixture(t); const a = await player(f, 'dice_bot_timeout_a'); const b = await player(f, 'dice_bot_timeout_b');
  let game = await create(f, a, { opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId] });
  f.advance(REQUEST_MS);
  assert.equal((await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game.status, 'expired');
  assert.equal(f.calls(), 0); assert.deepEqual(await balances(f, [a, b]), [100, 100]);
  f.roll(3, 2); game = await create(f, a, { botCount: 2 });
  const beforeCalls = f.calls(); f.roll(6, 6); f.advance(TURN_MS);
  await Promise.all([f.app.locals.games.expireGames(), f.app.locals.games.expireGames()]);
  game = (await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game;
  assert.equal(game.status, 'completed'); assert.equal(game.winnerAccountId, a.accountId);
  assert.equal(game.dice.history[0].rolls[a.accountId], 6);
  assert.ok([beforeCalls + 1, beforeCalls + 2].includes(f.calls()));
  assert.deepEqual(await balances(f, [a]), [110]); assert.deepEqual(await reserves(f, [a]), [0]);
  assert.equal((await savedGame(f, game)).moves.filter(receipt => receipt.automatic).length, 3);
  await f.app.locals.games.expireGames(); assert.deepEqual(await balances(f, [a]), [110]);
});

test('banning or deleting a real mixed participant refunds humans and preserves bot identities', async t => {
  const f = await fixture(t); const admin = await player(f, 'dice_bot_admin');
  await f.store.users.updateOne({ _id: admin.id }, { $set: { role: 'admin' } });
  for (const action of ['ban', 'delete']) {
    const a = await player(f, `db_remove_host_${action}`); const b = await player(f, `db_remove_guest_${action}`);
    let game = await create(f, a, { opponentType: 'mixed', botCount: 2, recipientAccountIds: [b.accountId] });
    f.roll(1, 2); game = await accept(f, b, game);
    const response = action === 'ban'
      ? await f.api(`/api/moderation/players/${b.accountId}`, { banned: true }, admin.cookie, 'PATCH')
      : await f.api('/api/account', { confirmation: 'DELETE', currentPassword: password }, b.cookie, 'DELETE');
    assert.equal(response.status, 200, JSON.stringify(response.data));
    game = (await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game;
    assert.equal(game.status, 'cancelled'); assert.equal(game.reason, action === 'ban' ? 'account-banned' : 'account-deleted');
    assert.deepEqual(game.players.filter(person => person.isBot).map(person => person.username), ['Bot #1', 'Bot #2']);
    assert.deepEqual(await balances(f, [a, b]), [100, action === 'ban' ? 100 : undefined]);
    assert.deepEqual(await reserves(f, [a]), [0]);
    const saved = await savedGame(f, game); assert.equal(saved.escrowed, false); assert.equal(saved.payoutReserved, false);
    if (action === 'delete') assert.equal(saved.players.find(person => person.accountId === b.accountId).username, 'Deleted player');
  }
  assert.equal(await f.store.users.countDocuments({ accountId: /^BOT/ }), 0);
});
