const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { ObjectId, MongoServerError } = require('mongodb');
const { createApp, connectMongo } = require('../server');
const { REQUEST_MS, TURN_MS } = require('../games');

let mongo;
const password = 'dice-test-password';
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });

async function fixture(t, { productionRng = false } = {}) {
  const store = await connectMongo({ uri: mongo.getUri(), dbName: `dice_${crypto.randomBytes(5).toString('hex')}` });
  t.after(() => store.client.close());
  let time = Date.now();
  let rolls = [];
  let randomCalls = 0;
  const app = createApp(store, { mailer: null, now: () => time, verifyTurnstile: async () => true,
    ...(!productionRng ? { randomDice: () => { randomCalls += 1; return rolls.shift() ?? 1; } } : {}) });
  const server = app.listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = async (route, body, cookie, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { store, api, app, advance: milliseconds => { time += milliseconds; }, roll: (...values) => { rolls = values; }, calls: () => randomCalls };
}
async function player(api, store, username, balance = 100) {
  const response = await api('/api/register', { username, password });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const saved = await store.users.findOne({ accountId: response.data.user.accountId });
  await store.users.updateOne({ _id: saved._id }, { $set: { balance } });
  return { ...response.data.user, id: saved._id, cookie: response.cookie };
}
async function players(f, count = 4, balance = 100) {
  return Promise.all(Array.from({ length: count }, (_, index) => player(f.api, f.store, `dice_player_${index}`, balance)));
}
const terms = (invitees, extra = {}) => ({ game: 'dice', stake: 10, recipientAccountIds: invitees.map(person => person.accountId),
  payoutMode: invitees.length > 1 ? 'shared' : 'single-winner', clientRequestId: crypto.randomUUID(), ...extra });
async function request(f, people, extra = {}) {
  const response = await f.api('/api/games', terms(people.slice(1), extra), people[0].cookie);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.game;
}
async function accept(f, person, game) {
  const response = await f.api(`/api/games/${game.id}/accept`, {}, person.cookie);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.game;
}
async function start(f, people, extra = {}) {
  let game = await request(f, people, extra);
  for (const person of people.slice(1)) game = await accept(f, person, game);
  assert.equal(game.status, 'playing');
  return game;
}
const move = (f, person, game, round = game.dice.round, clientMoveId = crypto.randomUUID(), extra = {}) =>
  f.api(`/api/games/${game.id}/move`, { round, clientMoveId, ...extra }, person.cookie);
async function rolling(f, game, moves) {
  for (const [person, value] of moves) {
    f.roll(value);
    const response = await move(f, person, game);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    game = response.data.game;
  }
  return game;
}
const balances = (f, people) => Promise.all(people.map(async person => (await f.store.users.findOne({ _id: person.id }))?.balance));
const reserves = (f, people) => Promise.all(people.map(async person => (await f.store.users.findOne({ _id: person.id }))?.gamePayoutReserve ?? 0));

test('dice invitations validate rosters and bets, remain private, and compare all immutable terms on replay', async t => {
  const f = await fixture(t); const people = await players(f, 4); const [a, b, c, d] = people;
  for (const extra of [{ stake: 0 }, { stake: -1 }, { stake: 1.2 }, { stake: Number.MAX_SAFE_INTEGER },
    { recipientAccountIds: [] }, { recipientAccountIds: [b.accountId, b.accountId] }, { recipientAccountIds: [a.accountId] },
    { recipientAccountIds: [b.accountId, c.accountId, d.accountId, crypto.randomUUID()] },
    { recipientAccountIds: ['invalid'] }, { recipientAccountIds: b.accountId }, { payoutMode: 'invalid' }]) {
    const response = await f.api('/api/games', terms([b], extra), a.cookie);
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  assert.equal(await f.store.games.countDocuments(), 0);
  const body = terms([b, c]);
  const responses = await Promise.all([f.api('/api/games', body, a.cookie), f.api('/api/games', { ...body, recipientAccountIds: [c.accountId, b.accountId] }, a.cookie)]);
  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  const game = responses[0].data.game;
  assert.equal(responses[1].data.game.id, game.id); assert.equal(await f.store.games.countDocuments(), 1);
  for (const extra of [{ stake: 11 }, { payoutMode: 'single-winner' }, { recipientAccountIds: [b.accountId, d.accountId] }]) {
    assert.equal((await f.api('/api/games', { ...body, ...extra }, a.cookie)).status, 409);
  }
  for (const actor of [b, c]) assert.equal((await f.api(`/api/games/${game.id}`, undefined, actor.cookie)).status, 200);
  assert.equal((await f.api(`/api/games/${game.id}`, undefined, d.cookie)).status, 404);
  for (const action of ['accept', 'decline', 'cancel', 'resign', 'move']) {
    assert.equal((await f.api(`/api/games/${game.id}/${action}`, { round: 1, clientMoveId: crypto.randomUUID() }, d.cookie)).status, 404);
  }
  assert.deepEqual((await f.api('/api/games', undefined, d.cookie)).data.games, []);
  assert.equal((await f.api('/api/games', undefined, c.cookie)).data.games[0].id, game.id);
  assert.deepEqual(await balances(f, people), [100, 100, 100, 100]);
  assert.deepEqual(game.players.map(person => person.accepted), [true, false, false]);
  assert.equal(JSON.stringify(game).includes('userId'), false);
});

test('every invitee must agree, then all four stakes and full pot reserves transfer exactly once', async t => {
  const f = await fixture(t); const people = await players(f); const [a, b, c, d] = people;
  let game = await request(f, people);
  assert.equal((await f.api(`/api/games/${game.id}/accept`, {}, a.cookie)).status, 403);
  game = await accept(f, b, game);
  game = await accept(f, c, game);
  assert.equal(game.status, 'pending'); assert.equal(game.players.filter(person => person.accepted).length, 3);
  assert.deepEqual(await balances(f, people), [100, 100, 100, 100]);
  assert.deepEqual(await reserves(f, people), [0, 0, 0, 0]);
  const final = await Promise.all([accept(f, d, game), accept(f, d, game), accept(f, b, game)]);
  assert.ok(final.some(match => match.status === 'playing'));
  game = (await f.api(`/api/games/${game.id}`, undefined, d.cookie)).data.game;
  assert.equal(game.status, 'playing'); assert.equal(game.pot, 40);
  assert.deepEqual(await balances(f, people), [90, 90, 90, 90]);
  assert.deepEqual(await reserves(f, people), [40, 40, 40, 40]);
  assert.equal(game.eligibleAccountIds.length, 4);
  assert.equal((await f.api(`/api/games/${game.id}/resign`, {}, c.cookie)).status, 409);
});

test('a third or fourth invitee can decline permanently and only the host can cancel', async t => {
  const f = await fixture(t); const people = await players(f); const [a, b, c, d] = people;
  for (const actor of [c, d]) {
    const game = await request(f, people);
    assert.equal((await f.api(`/api/games/${game.id}/cancel`, {}, actor.cookie)).status, 403);
    assert.equal((await f.api(`/api/games/${game.id}/decline`, {}, actor.cookie)).status, 200);
    assert.equal((await f.api(`/api/games/${game.id}/accept`, {}, b.cookie)).status, 409);
    assert.equal((await f.api(`/api/games/${game.id}/decline`, {}, actor.cookie)).data.game.status, 'declined');
  }
  const game = await request(f, people);
  assert.equal((await f.api(`/api/games/${game.id}/decline`, {}, a.cookie)).status, 403);
  assert.equal((await f.api(`/api/games/${game.id}/cancel`, {}, a.cookie)).data.game.status, 'cancelled');
  assert.deepEqual(await balances(f, people), [100, 100, 100, 100]);
});

test('two players roll independently; higher roll wins and equal rolls refund both', async t => {
  const f = await fixture(t); const people = await players(f, 2); const [a, b] = people;
  let game = await start(f, people);
  assert.equal(game.turnAccountId, null);
  game = await rolling(f, game, [[b, 6]]);
  assert.equal(game.status, 'playing'); assert.equal(game.dice.rolls[b.accountId], 6);
  assert.deepEqual(game.eligibleAccountIds, [a.accountId]);
  game = await rolling(f, game, [[a, 2]]);
  assert.equal(game.result, 'win'); assert.equal(game.winnerAccountId, b.accountId);
  assert.deepEqual(await balances(f, people), [90, 110]);
  assert.deepEqual(await reserves(f, people), [0, 0]);
  game = await start(f, people);
  game = await rolling(f, game, [[a, 4], [b, 4]]);
  assert.equal(game.result, 'draw'); assert.equal(game.winnerAccountId, null);
  assert.deepEqual(game.payouts, { [a.accountId]: 10, [b.accountId]: 10 });
  assert.deepEqual(await balances(f, people), [90, 110]);
});

test('shared three player ties reroll only their placement slots and keep the lone player ranked', async t => {
  const f = await fixture(t); const people = await players(f, 3); const [a, b, c] = people;
  let game = await start(f, people);
  game = await rolling(f, game, [[c, 2], [a, 5], [b, 5]]);
  assert.equal(game.dice.round, 2); assert.deepEqual(new Set(game.eligibleAccountIds), new Set([a.accountId, b.accountId]));
  assert.equal((await move(f, c, game)).status, 409);
  game = await rolling(f, game, [[b, 1], [a, 3]]);
  assert.equal(game.status, 'completed'); assert.equal(game.result, 'ranked');
  assert.deepEqual(game.placements.map(person => person.accountId), [a.accountId, b.accountId, c.accountId]);
  assert.deepEqual(game.placements.map(person => person.payout), [20, 10, 0]);
  assert.deepEqual(await balances(f, people), [110, 100, 90]);
  assert.equal(game.dice.history.length, 2);
  game = await start(f, people);
  game = await rolling(f, game, [[a, 6], [b, 1], [c, 1], [b, 1], [c, 6]]);
  assert.deepEqual(game.placements.map(person => person.accountId), [a.accountId, c.accountId, b.accountId]);
  assert.deepEqual(await balances(f, people), [120, 90, 90]);
});

test('shared four player nested and repeated ties resolve ranked slots with floored payouts', async t => {
  const f = await fixture(t); const people = await players(f); const [a, b, c, d] = people;
  let game = await start(f, people);
  game = await rolling(f, game, [[d, 1], [a, 5], [b, 5], [c, 5]]);
  assert.equal(game.dice.round, 2);
  game = await rolling(f, game, [[a, 4], [b, 4], [c, 2]]);
  assert.equal(game.dice.round, 3); assert.deepEqual(new Set(game.eligibleAccountIds), new Set([a.accountId, b.accountId]));
  game = await rolling(f, game, [[a, 3], [b, 3]]);
  assert.equal(game.dice.round, 4);
  game = await rolling(f, game, [[b, 6], [a, 1]]);
  assert.equal(game.status, 'completed');
  assert.deepEqual(game.placements.map(person => person.accountId), [b.accountId, a.accountId, c.accountId, d.accountId]);
  assert.deepEqual(game.placements.map(person => person.payout), [17, 13, 9, 0]);
  assert.deepEqual(await balances(f, people), [103, 107, 99, 90]);
  assert.deepEqual(await reserves(f, people), [0, 0, 0, 0]);
});

test('shared initial all-player ties refund everybody but single-winner leaders reroll until one wins', async t => {
  const f = await fixture(t); const people = await players(f); const [a, b, c, d] = people;
  for (const count of [3, 4]) {
    let game = await start(f, people.slice(0, count));
    game = await rolling(f, game, people.slice(0, count).map(person => [person, 3]));
    assert.equal(game.result, 'draw'); assert.deepEqual(await balances(f, people), [100, 100, 100, 100]);
  }
  let game = await start(f, people, { payoutMode: 'single-winner' });
  game = await rolling(f, game, [[a, 4], [b, 6], [c, 6], [d, 1]]);
  assert.equal(game.dice.round, 2); assert.deepEqual(new Set(game.eligibleAccountIds), new Set([b.accountId, c.accountId]));
  assert.equal((await move(f, a, game)).status, 409);
  game = await rolling(f, game, [[b, 2], [c, 2], [c, 1], [b, 5]]);
  assert.equal(game.winnerAccountId, b.accountId);
  assert.deepEqual(await balances(f, people), [90, 130, 90, 90]);
  assert.equal(Object.values(game.payouts).reduce((sum, amount) => sum + amount, 0), 40);
  game = await start(f, people.slice(0, 3), { payoutMode: 'single-winner' });
  game = await rolling(f, game, [[a, 1], [b, 1], [c, 1]]);
  assert.equal(game.status, 'playing'); assert.equal(game.dice.round, 2);
  game = await rolling(f, game, [[a, 6], [b, 1], [c, 2]]);
  assert.equal(game.winnerAccountId, a.accountId);
});

test('move receipts protect duplicate clicks, stale rounds, client-controlled rolls, and settlement replay', async t => {
  const f = await fixture(t); const people = await players(f, 3); const [a, b, c] = people;
  let game = await start(f, people);
  const moveId = crypto.randomUUID(); f.roll(5);
  const duplicate = await Promise.all([move(f, a, game, 1, moveId, { value: 6, roll: 6 }), move(f, a, game, 1, moveId)]);
  assert.deepEqual(duplicate.map(response => response.status), [200, 200]);
  game = duplicate[0].data.game;
  assert.equal(game.dice.rolls[a.accountId], 5);
  assert.equal((await move(f, a, game)).status, 409);
  assert.equal((await move(f, a, game, 2, moveId)).status, 409);
  for (const round of [0, -1, 1.2, '1', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await move(f, b, game, round)).status, 400);
  game = await rolling(f, game, [[b, 5], [c, 1]]);
  assert.equal(game.dice.round, 2);
  assert.equal((await move(f, b, game, 1)).status, 409);
  assert.equal((await move(f, a, game, 1, moveId)).status, 200);
  game = await rolling(f, game, [[a, 6]]); f.roll(1);
  const finalId = crypto.randomUUID();
  const finals = await Promise.all([move(f, b, game, 2, finalId), move(f, b, game, 2, finalId)]);
  assert.deepEqual(finals.map(response => response.status), [200, 200]);
  assert.equal(finals[0].data.game.status, 'completed');
  assert.deepEqual(await balances(f, people), [110, 100, 90]);
  assert.equal((await move(f, a, finals[0].data.game, 1, moveId)).status, 200);
  assert.deepEqual(await balances(f, people), [110, 100, 90]);
});

test('a transaction retry retains the original secure die sample', async t => {
  const f = await fixture(t); const people = await players(f, 2); const [a] = people;
  const game = await start(f, people); f.roll(6, 1);
  const originalUpdate = f.store.games.updateOne.bind(f.store.games);
  let attempts = 0;
  t.mock.method(f.store.games, 'updateOne', (...args) => {
    if (args[1].$set?.dice && attempts++ === 0) {
      const error = new MongoServerError({ message: 'Retry die roll', code: 112 });
      error.addErrorLabel('TransientTransactionError'); throw error;
    }
    return originalUpdate(...args);
  });
  const response = await move(f, a, game);
  assert.equal(response.status, 200); assert.equal(response.data.game.dice.rolls[a.accountId], 6);
  assert.equal(attempts, 2); assert.equal(f.calls(), 1);
});

test('production dice uses the unbiased six-sided cryptographic range for every face', async t => {
  const f = await fixture(t, { productionRng: true }); const people = await players(f, 2); const [a, b] = people;
  let face = 1;
  const random = t.mock.method(crypto, 'randomInt', (min, max) => { assert.equal(min, 1); assert.equal(max, 7); return face; });
  for (face = 1; face <= 6; face += 1) {
    let game = await start(f, people);
    game = await rolling(f, game, [[b, face], [a, face]]);
    assert.equal(game.dice.history[0].rolls[a.accountId], face);
    assert.equal(game.dice.history[0].rolls[b.accountId], face);
    assert.equal(game.result, 'draw');
  }
  assert.equal(random.mock.callCount(), 12);
  assert.deepEqual(await balances(f, people), [100, 100]);
});

test('final acceptance checks every balance and competing multiplayer games cannot overspend', async t => {
  const f = await fixture(t); const people = await players(f, 4, 10); const [a, b, c, d] = people;
  let first = await request(f, [a, b, c]); first = await accept(f, b, first);
  await f.store.users.updateOne({ _id: c.id }, { $set: { balance: 9 } });
  assert.equal((await f.api(`/api/games/${first.id}/accept`, {}, c.cookie)).status, 409);
  assert.deepEqual(await balances(f, people), [10, 10, 9, 10]);
  assert.deepEqual(await reserves(f, people), [0, 0, 0, 0]);
  await f.store.users.updateOne({ _id: c.id }, { $set: { balance: 10 } });
  let second = await request(f, [a, b, d]); second = await accept(f, b, second);
  const responses = await Promise.all([f.api(`/api/games/${first.id}/accept`, {}, c.cookie), f.api(`/api/games/${second.id}/accept`, {}, d.cookie)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal((await balances(f, people)).reduce((sum, balance) => sum + balance, 0), 10);
});

test('full-pot reserves guarantee safe four-player payouts and reject unsafe wallet capacity', async t => {
  const f = await fixture(t); const people = await players(f); const [a, b, c, d] = people;
  await f.store.users.updateOne({ _id: a.id }, { $set: { balance: Number.MAX_SAFE_INTEGER - 29 } });
  let game = await request(f, people, { payoutMode: 'single-winner' });
  game = await accept(f, b, game); game = await accept(f, c, game);
  assert.equal((await f.api(`/api/games/${game.id}/accept`, {}, d.cookie)).status, 409);
  assert.equal((await balances(f, people))[0], Number.MAX_SAFE_INTEGER - 29);
  assert.deepEqual(await reserves(f, people), [0, 0, 0, 0]);
  await f.store.users.updateOne({ _id: a.id }, { $set: { balance: Number.MAX_SAFE_INTEGER - 30 } });
  game = await accept(f, d, game);
  assert.equal((await f.api('/api/claim', { turnstileToken: 'fixture' }, a.cookie)).status, 409);
  game = await rolling(f, game, [[a, 6], [b, 1], [c, 2], [d, 3]]);
  assert.equal(game.winnerAccountId, a.accountId);
  assert.equal((await balances(f, people))[0], Number.MAX_SAFE_INTEGER);
  assert.deepEqual(await reserves(f, people), [0, 0, 0, 0]);
});

test('dice request timeouts expire while playing timeouts fairly roll every missing participant', async t => {
  const f = await fixture(t); const people = await players(f); const [a] = people;
  let game = await request(f, people); f.advance(REQUEST_MS);
  assert.equal((await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game.status, 'expired');
  game = await start(f, people); game = await rolling(f, game, [[a, 6]]);
  f.roll(1, 2, 3);
  f.advance(TURN_MS);
  await Promise.all([f.app.locals.games.expireGames(), f.app.locals.games.expireGames()]);
  game = (await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game;
  assert.equal(game.status, 'completed'); assert.equal(game.reason, 'rolls');
  assert.equal(game.dice.history[0].rolls[a.accountId], 6);
  assert.equal(Object.keys(game.dice.history[0].rolls).length, 4);
  assert.equal(game.placements[0].accountId, a.accountId);
  assert.equal(Object.values(game.payouts).reduce((sum, amount) => sum + amount, 0), 39);
  assert.deepEqual(await reserves(f, people), [0, 0, 0, 0]);
  const saved = await f.store.games.findOne({ _id: new ObjectId(game.id) });
  assert.equal(saved.moves.filter(receipt => receipt.automatic).length, 3);
  const after = await balances(f, people);
  await f.app.locals.games.expireGames();
  assert.deepEqual(await balances(f, people), after);
});

test('all missing dice timeout rolls can refund a shared tie and tied leaders get a fresh timeout round', async t => {
  const f = await fixture(t); const people = await players(f, 3); const [a] = people;
  let game = await start(f, people); f.roll(4, 4, 4); f.advance(TURN_MS);
  game = (await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game;
  assert.equal(game.result, 'draw'); assert.deepEqual(await balances(f, people), [100, 100, 100]);
  game = await start(f, people, { payoutMode: 'single-winner' });
  f.roll(6, 6, 1); f.advance(TURN_MS);
  game = (await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game;
  assert.equal(game.status, 'playing'); assert.equal(game.dice.round, 2); assert.equal(game.eligibleAccountIds.length, 2);
  assert.deepEqual(await balances(f, people), [90, 90, 90]);
  f.roll(2, 5); f.advance(TURN_MS);
  game = (await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game;
  assert.equal(game.status, 'completed'); assert.equal(Object.values(game.payouts).reduce((sum, amount) => sum + amount, 0), 30);
  assert.deepEqual((await balances(f, people)).sort((x, y) => x - y), [90, 90, 120]);
});

test('timeout transaction retries retain each automatic die and account removal still refunds overdue dice', async t => {
  const f = await fixture(t); const people = await players(f, 3); const [a, b, c] = people;
  let game = await start(f, people); f.roll(6, 2, 1); f.advance(TURN_MS);
  const originalUpdate = f.store.games.updateOne.bind(f.store.games);
  let attempts = 0;
  const mocked = t.mock.method(f.store.games, 'updateOne', (...args) => {
    if (args[1].$set?.dice && attempts++ === 0) {
      const error = new MongoServerError({ message: 'Retry automatic dice', code: 112 });
      error.addErrorLabel('TransientTransactionError'); throw error;
    }
    return originalUpdate(...args);
  });
  game = (await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game;
  assert.equal(game.status, 'completed'); assert.equal(attempts, 2); assert.equal(f.calls(), 3);
  mocked.mock.restore();
  game = await start(f, people); f.advance(TURN_MS);
  const before = await balances(f, people);
  const removed = await f.api('/api/account', { confirmation: 'DELETE', currentPassword: password }, c.cookie, 'DELETE');
  assert.equal(removed.status, 200);
  game = (await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game;
  assert.equal(game.status, 'cancelled'); assert.equal(game.reason, 'account-deleted');
  assert.deepEqual(await balances(f, [a, b]), before.slice(0, 2).map(balance => balance + 10));
});

test('banning a fourth participant cancels and refunds all stakes while keeping banned identity', async t => {
  const f = await fixture(t); const people = await players(f); const [a, b, c, d] = people;
  const admin = await player(f.api, f.store, 'dice_admin');
  await f.store.users.updateOne({ _id: admin.id }, { $set: { role: 'admin' } });
  const game = await start(f, people);
  const banned = await f.api(`/api/moderation/players/${d.accountId}`, { banned: true }, admin.cookie, 'PATCH');
  assert.equal(banned.status, 200, JSON.stringify(banned.data));
  const ended = (await f.api(`/api/games/${game.id}`, undefined, a.cookie)).data.game;
  assert.equal(ended.status, 'cancelled'); assert.equal(ended.reason, 'account-banned');
  assert.equal(ended.players.find(person => person.accountId === d.accountId).banned, true);
  assert.deepEqual(await balances(f, people), [100, 100, 100, 100]);
  assert.deepEqual(await reserves(f, people), [0, 0, 0, 0]);
  assert.equal((await f.api('/api/games', terms([b, c, d]), a.cookie)).status, 409);
});

test('deleting a third participant preserves history and refunds other players before account removal', async t => {
  const f = await fixture(t); const people = await players(f); const [a, b, c, d] = people;
  const game = await start(f, people);
  const removed = await f.api('/api/account', { confirmation: 'DELETE', currentPassword: password }, c.cookie, 'DELETE');
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  const ended = (await f.api(`/api/games/${game.id}`, undefined, d.cookie)).data.game;
  assert.equal(ended.status, 'cancelled'); assert.equal(ended.reason, 'account-deleted');
  assert.equal(ended.players.find(person => person.accountId === c.accountId).username, 'Deleted player');
  assert.deepEqual(await balances(f, people), [100, 100, undefined, 100]);
  assert.deepEqual(await reserves(f, [a, b, d]), [0, 0, 0]);
  const saved = await f.store.games.findOne({ _id: new ObjectId(game.id) });
  assert.equal(saved.players.find(person => person.accountId === c.accountId).username, 'Deleted player');
});

test('final acceptance racing a third participant ban or deletion cannot leave orphan escrow', async t => {
  for (const action of ['ban', 'delete']) {
    const f = await fixture(t); const people = await players(f); const [a, b, c, d] = people;
    const admin = await player(f.api, f.store, `race_admin_${action}`);
    await f.store.users.updateOne({ _id: admin.id }, { $set: { role: 'admin' } });
    let game = await request(f, people); game = await accept(f, b, game); game = await accept(f, c, game);
    const removal = action === 'ban'
      ? f.api(`/api/moderation/players/${c.accountId}`, { banned: true }, admin.cookie, 'PATCH')
      : f.api('/api/account', { confirmation: 'DELETE', currentPassword: password }, c.cookie, 'DELETE');
    const responses = await Promise.all([f.api(`/api/games/${game.id}/accept`, {}, d.cookie), removal]);
    assert.ok([200, 409].includes(responses[0].status), JSON.stringify(responses));
    assert.equal(responses[1].status, 200);
    const saved = await f.store.games.findOne({ _id: new ObjectId(game.id) });
    assert.equal(saved.status, 'cancelled'); assert.equal(saved.escrowed, false); assert.equal(saved.payoutReserved, false);
    assert.deepEqual(await balances(f, people), [100, 100, action === 'delete' ? undefined : 100, 100]);
    assert.deepEqual(await reserves(f, [a, b, d]), [0, 0, 0]);
  }
});

test('final roll racing a third participant ban or deletion settles or refunds exactly once', async t => {
  for (const action of ['ban', 'delete']) {
    const f = await fixture(t); const people = await players(f); const [a, b, c, d] = people;
    const admin = await player(f.api, f.store, `roll_admin_${action}`);
    await f.store.users.updateOne({ _id: admin.id }, { $set: { role: 'admin' } });
    let game = await start(f, people, { payoutMode: 'single-winner' });
    game = await rolling(f, game, [[b, 1], [c, 2], [d, 3]]); f.roll(6);
    const removal = action === 'ban'
      ? f.api(`/api/moderation/players/${c.accountId}`, { banned: true }, admin.cookie, 'PATCH')
      : f.api('/api/account', { confirmation: 'DELETE', currentPassword: password }, c.cookie, 'DELETE');
    const responses = await Promise.all([move(f, a, game), removal]);
    assert.ok([200, 409].includes(responses[0].status), JSON.stringify(responses));
    assert.equal(responses[1].status, 200);
    const saved = await f.store.games.findOne({ _id: new ObjectId(game.id) });
    assert.ok(['completed', 'cancelled'].includes(saved.status)); assert.equal(saved.escrowed, false); assert.equal(saved.payoutReserved, false);
    assert.deepEqual(await balances(f, [a, b, d]), saved.status === 'completed' ? [130, 90, 90] : [100, 100, 100]);
    assert.deepEqual(await reserves(f, [a, b, d]), [0, 0, 0]);
    await f.app.locals.games.expireGames();
    assert.deepEqual(await balances(f, [a, b, d]), saved.status === 'completed' ? [130, 90, 90] : [100, 100, 100]);
  }
});
