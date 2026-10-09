const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MongoMemoryReplSet, MongoMemoryServer } = require('mongodb-memory-server');
const { ObjectId } = require('mongodb');
const { createApp, connectMongo } = require('../server');
const { REQUEST_MS, TURN_MS } = require('../games');

let mongo;
const password = 'games-test-password';
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });

async function fixture(t, uri = mongo.getUri()) {
  const store = await connectMongo({ uri, dbName: `games_${crypto.randomBytes(5).toString('hex')}` });
  t.after(() => store.client.close());
  let time = Date.now();
  const app = createApp(store, { mailer: null, now: () => time, verifyTurnstile: async () => true, randomInt: () => 20 });
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
  assert.equal(response.status, 201);
  const saved = await store.users.findOne({ accountId: response.data.user.accountId });
  await store.users.updateOne({ _id: saved._id }, { $set: { balance } });
  return { ...response.data.user, id: saved._id, cookie: response.cookie };
}
const terms = (recipient, extra = {}) => ({ recipientAccountId: recipient.accountId, game: 'tic-tac-toe', stake: 10, clientRequestId: crypto.randomUUID(), ...extra });
async function request(api, sender, recipient, extra = {}) {
  const response = await api('/api/games', terms(recipient, extra), sender.cookie);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.game;
}
async function accept(api, recipient, game) {
  const response = await api(`/api/games/${game.id}/accept`, {}, recipient.cookie);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.game;
}
const move = (api, actor, game, value, clientMoveId = crypto.randomUUID()) => api(`/api/games/${game.id}/move`, {
  clientMoveId, ...(game.game === 'tic-tac-toe' ? { position: value } : { choice: value })
}, actor.cookie);
const balances = (store, ...people) => Promise.all(people.map(async person => (await store.users.findOne({ _id: person.id }))?.balance));

test('requests validate inputs, remain private, and save no stake before both players agree', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'game_sender');
  const b = await player(api, store, 'game_recipient');
  const c = await player(api, store, 'game_outsider');
  assert.equal((await api('/api/games')).status, 401);
  for (const extra of [{ stake: -1 }, { stake: 1.5 }, { stake: '10' }, { stake: Number.MAX_SAFE_INTEGER }, { game: 'poker' }, { clientRequestId: 'bad' }]) {
    assert.equal((await api('/api/games', terms(b, extra), a.cookie)).status, 400);
  }
  assert.equal((await api('/api/games', terms(a), a.cookie)).status, 400);
  const game = await request(api, a, b);
  assert.equal(game.status, 'pending'); assert.equal(game.stake, 10);
  assert.deepEqual(await balances(store, a, b), [100, 100]);
  assert.equal((await api(`/api/games/${game.id}`, undefined, c.cookie)).status, 404);
  for (const action of ['accept', 'decline', 'cancel', 'resign', 'move']) {
    assert.equal((await api(`/api/games/${game.id}/${action}`, { clientMoveId: crypto.randomUUID(), position: 0 }, c.cookie)).status, 404);
  }
  assert.equal((await api(`/api/games/${game.id}/accept`, {}, a.cookie)).status, 403);
  assert.equal((await api('/api/games', terms(b, { stake: 101 }), a.cookie)).status, 409);
  assert.deepEqual((await api('/api/games', undefined, c.cookie)).data.games, []);
  assert.equal((await api('/api/games', undefined, b.cookie)).data.games.length, 1);
});

test('both games reject zero and negative bets without creating requests or changing wallets', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'positive_bet_a'); const b = await player(api, store, 'positive_bet_b');
  const before = await store.users.find({ _id: { $in: [a.id, b.id] } }).sort({ _id: 1 }).toArray();
  for (const game of ['tic-tac-toe', 'rock-paper-scissors']) {
    for (const stake of [0, -0, -1, -10, 0.5]) {
      const response = await api('/api/games', terms(b, { game, stake }), a.cookie);
      assert.equal(response.status, 400, `${game}, ${stake}`);
    }
  }
  assert.equal(await store.games.countDocuments(), 0);
  assert.deepEqual(await store.users.find({ _id: { $in: [a.id, b.id] } }).sort({ _id: 1 }).toArray(), before);
});

test('both games accept a one-token bet and reserve exactly one token per player', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'minimum_bet_a'); const b = await player(api, store, 'minimum_bet_b');
  for (const gameType of ['tic-tac-toe', 'rock-paper-scissors']) {
    const before = await balances(store, a, b);
    const invitation = await request(api, a, b, { game: gameType, stake: 1 });
    assert.deepEqual(await balances(store, a, b), before);
    const game = await accept(api, b, invitation);
    assert.equal(game.status, 'playing'); assert.equal(game.stake, 1);
    assert.deepEqual(await balances(store, a, b), before.map(balance => balance - 1));
    for (const actor of [a, b]) assert.equal((await store.users.findOne({ _id: actor.id })).gamePayoutReserve, 2);
    assert.equal((await api(`/api/games/${game.id}/resign`, {}, b.cookie)).status, 200);
    assert.deepEqual(await balances(store, a, b), [before[0] + 1, before[1] - 1]);
  }
});

test('legacy invitations with invalid bets cannot be accepted and can still be declined or cancelled', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'legacy_bet_a'); const b = await player(api, store, 'legacy_bet_b');
  for (const gameType of ['tic-tac-toe', 'rock-paper-scissors']) {
    for (const stake of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER]) {
      const game = await request(api, a, b, { game: gameType });
      const id = new ObjectId(game.id);
      await store.games.updateOne({ _id: id }, { $set: { stake } });
      const before = await store.games.findOne({ _id: id });
      const wallets = await store.users.find({ _id: { $in: [a.id, b.id] } }).sort({ _id: 1 }).toArray();
      const response = await api(`/api/games/${game.id}/accept`, {}, b.cookie);
      assert.equal(response.status, 409, `${gameType}, ${stake}`);
      assert.deepEqual(await store.games.findOne({ _id: id }), before);
      assert.deepEqual(await store.users.find({ _id: { $in: [a.id, b.id] } }).sort({ _id: 1 }).toArray(), wallets);
      const action = stake === 0 ? 'decline' : 'cancel';
      const closed = await api(`/api/games/${game.id}/${action}`, {}, (action === 'decline' ? b : a).cookie);
      assert.equal(closed.status, 200);
      assert.deepEqual(await balances(store, a, b), [100, 100]);
    }
  }
});

test('already active legacy zero-token games can still settle and close safely', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'legacy_active_a'); const b = await player(api, store, 'legacy_active_b');
  for (const gameType of ['tic-tac-toe', 'rock-paper-scissors']) {
    const game = await request(api, a, b, { game: gameType });
    await store.games.updateOne({ _id: new ObjectId(game.id) }, { $set: {
      stake: 0, status: 'playing', escrowed: true, payoutReserved: true,
      turnUserId: gameType === 'tic-tac-toe' ? a.id : null
    } });
    await store.users.updateMany({ _id: { $in: [a.id, b.id] } }, { $set: { gamePayoutReserve: 0 } });
    assert.equal((await api(`/api/games/${game.id}/accept`, {}, b.cookie)).status, 200);
    const response = await api(`/api/games/${game.id}/resign`, {}, b.cookie);
    assert.equal(response.status, 200); assert.equal(response.data.game.status, 'completed');
    assert.equal((await store.games.findOne({ _id: new ObjectId(game.id) })).escrowed, false);
    assert.deepEqual(await balances(store, a, b), [100, 100]);
  }
});

test('request retries and concurrent acceptance debit each equal stake exactly once', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'request_replay_a');
  const b = await player(api, store, 'request_replay_b');
  const payload = terms(b);
  const results = await Promise.all([api('/api/games', payload, a.cookie), api('/api/games', payload, a.cookie)]);
  assert.deepEqual(results.map(result => result.status), [201, 201]);
  assert.equal(results[0].data.game.id, results[1].data.game.id);
  assert.equal(await store.games.countDocuments(), 1);
  assert.equal((await api('/api/games', { ...payload, stake: 20 }, a.cookie)).status, 409);
  const game = results[0].data.game;
  const accepted = await Promise.all([accept(api, b, game), accept(api, b, game)]);
  assert.equal(accepted[0].status, 'playing');
  assert.equal(accepted[0].turnAccountId, a.accountId);
  assert.deepEqual(await balances(store, a, b), [90, 90]);
  assert.equal((await store.games.findOne({ _id: new ObjectId(game.id) })).escrowed, true);
});

test('acceptance checks both current balances atomically and competing matches cannot overspend', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'balance_a', 10);
  const b = await player(api, store, 'balance_b', 9);
  const c = await player(api, store, 'balance_c', 10);
  const first = await request(api, a, b);
  assert.equal((await api(`/api/games/${first.id}/accept`, {}, b.cookie)).status, 409);
  assert.deepEqual(await balances(store, a, b), [10, 9]);
  await store.users.updateOne({ _id: b.id }, { $set: { balance: 10 } });
  const second = await request(api, a, c);
  const results = await Promise.all([api(`/api/games/${first.id}/accept`, {}, b.cookie), api(`/api/games/${second.id}/accept`, {}, c.cookie)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await balances(store, a, b, c)).reduce((sum, value) => sum + value), 10);
});

test('decline and cancel close invitations permanently without moving tokens', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'decline_a'); const b = await player(api, store, 'decline_b');
  for (const action of ['decline', 'cancel']) {
    const game = await request(api, a, b);
    const actor = action === 'decline' ? b : a;
    const response = await api(`/api/games/${game.id}/${action}`, {}, actor.cookie);
    assert.equal(response.status, 200);
    assert.equal(response.data.game.status, action === 'decline' ? 'declined' : 'cancelled');
    assert.equal((await api(`/api/games/${game.id}/accept`, {}, b.cookie)).status, 409);
    assert.equal((await api(`/api/games/${game.id}/${action}`, {}, actor.cookie)).status, 200);
  }
  assert.deepEqual(await balances(store, a, b), [100, 100]);
});

test('tic tac toe enforces turns and empty squares, pays winners once, and replays moves after completion', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'ttt_a'); const b = await player(api, store, 'ttt_b');
  let game = await accept(api, b, await request(api, a, b));
  assert.equal((await move(api, b, game, 0)).status, 409);
  assert.equal((await move(api, a, game, 9)).status, 400);
  const firstId = crypto.randomUUID();
  const first = await move(api, a, game, 0, firstId);
  assert.equal(first.status, 200);
  assert.deepEqual((await move(api, a, game, 0, firstId)).data.game, first.data.game);
  assert.equal((await move(api, a, game, 1, firstId)).status, 409);
  assert.equal((await move(api, b, game, 0)).status, 409);
  for (const [actor, position] of [[b, 3], [a, 1], [b, 4]]) assert.equal((await move(api, actor, game, position)).status, 200);
  const winningId = crypto.randomUUID();
  const final = await Promise.all([move(api, a, game, 2, winningId), move(api, a, game, 2, winningId)]);
  assert.deepEqual(final.map(result => result.status), [200, 200]);
  game = final[0].data.game;
  assert.equal(game.status, 'completed'); assert.equal(game.winnerAccountId, a.accountId); assert.equal(game.result, 'win');
  assert.deepEqual(game.board, ['X', 'X', 'X', 'O', 'O', null, null, null, null]);
  assert.deepEqual(await balances(store, a, b), [110, 90]);
  assert.equal((await move(api, b, game, 8)).status, 409);
  assert.equal((await move(api, a, game, 0, firstId)).data.game.status, 'completed');
  assert.deepEqual(await balances(store, a, b), [110, 90]);
});

test('tic tac toe draw refunds each stake, including one-token games', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'draw_a'); const b = await player(api, store, 'draw_b');
  for (const stake of [10, 1]) {
    let game = await accept(api, b, await request(api, a, b, { stake }));
    const positions = [0, 1, 2, 4, 3, 5, 7, 6, 8];
    for (const [index, position] of positions.entries()) {
      const response = await move(api, index % 2 ? b : a, game, position);
      assert.equal(response.status, 200); game = response.data.game;
    }
    assert.equal(game.result, 'draw'); assert.equal(game.winnerAccountId, null);
    assert.deepEqual(await balances(store, a, b), [100, 100]);
  }
});

test('rock paper scissors keeps choices private until both submit, locks choices, and settles concurrent moves', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'rps_a'); const b = await player(api, store, 'rps_b');
  let game = await accept(api, b, await request(api, a, b, { game: 'rock-paper-scissors' }));
  const firstId = crypto.randomUUID();
  const first = await move(api, a, game, 'rock', firstId);
  assert.equal(first.data.game.yourChoice, 'rock'); assert.equal(first.data.game.choices, null);
  const other = (await api(`/api/games/${game.id}`, undefined, b.cookie)).data.game;
  assert.equal(other.yourChoice, null); assert.equal(other.opponentChosen, true); assert.equal(other.choices, null);
  assert.ok(!JSON.stringify(other).includes('"rock"'));
  assert.ok(!JSON.stringify((await api('/api/games', undefined, b.cookie)).data.games).includes('"rock"'));
  assert.equal((await move(api, a, game, 'paper')).status, 409);
  assert.equal((await move(api, a, game, 'paper', firstId)).status, 409);
  const finished = await move(api, b, game, 'scissors');
  assert.equal(finished.data.game.winnerAccountId, a.accountId);
  assert.deepEqual(finished.data.game.choices, { sender: 'rock', recipient: 'scissors' });
  assert.deepEqual(await balances(store, a, b), [110, 90]);
  game = await accept(api, b, await request(api, a, b, { game: 'rock-paper-scissors' }));
  const simultaneous = await Promise.all([move(api, a, game, 'paper'), move(api, b, game, 'scissors')]);
  assert.deepEqual(simultaneous.map(result => result.status), [200, 200]);
  assert.equal((await api(`/api/games/${game.id}`, undefined, a.cookie)).data.game.winnerAccountId, b.accountId);
  assert.deepEqual(await balances(store, a, b), [100, 100]);
});

test('rock paper scissors equal choices refund stakes and all winning pairs follow the rules', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'pairs_a'); const b = await player(api, store, 'pairs_b');
  for (const [first, second] of [['paper', 'rock'], ['scissors', 'paper'], ['rock', 'scissors'], ['rock', 'rock']]) {
    const game = await accept(api, b, await request(api, a, b, { game: 'rock-paper-scissors', stake: 1 }));
    await move(api, a, game, first);
    const response = await move(api, b, game, second);
    assert.equal(response.data.game.result, first === second ? 'draw' : 'win');
    assert.equal(response.data.game.winnerAccountId, first === second ? null : a.accountId);
  }
  assert.deepEqual(await balances(store, a, b), [103, 97]);
});

test('timeouts expire requests, forfeit delayed turns, and refund unanswered simultaneous games', async t => {
  const { api, store, advance, app } = await fixture(t);
  const a = await player(api, store, 'timeout_a'); const b = await player(api, store, 'timeout_b');
  const pending = await request(api, a, b);
  advance(REQUEST_MS);
  assert.equal((await api(`/api/games/${pending.id}/accept`, {}, b.cookie)).status, 409);
  assert.equal((await api(`/api/games/${pending.id}`, undefined, a.cookie)).data.game.status, 'expired');
  const ttt = await accept(api, b, await request(api, a, b));
  advance(TURN_MS);
  await Promise.all([app.locals.games.expireGames(), app.locals.games.expireGames()]);
  assert.equal((await api(`/api/games/${ttt.id}`, undefined, a.cookie)).data.game.winnerAccountId, b.accountId);
  assert.deepEqual(await balances(store, a, b), [90, 110]);
  const idle = await accept(api, b, await request(api, a, b, { game: 'rock-paper-scissors' }));
  advance(TURN_MS);
  assert.equal((await api(`/api/games/${idle.id}`, undefined, a.cookie)).data.game.result, 'draw');
  assert.deepEqual(await balances(store, a, b), [90, 110]);
  const single = await accept(api, b, await request(api, a, b, { game: 'rock-paper-scissors' }));
  await move(api, a, single, 'paper');
  advance(TURN_MS);
  const ended = (await api(`/api/games/${single.id}`, undefined, b.cookie)).data.game;
  assert.equal(ended.winnerAccountId, a.accountId); assert.equal(ended.reason, 'timeout');
  assert.deepEqual(await balances(store, a, b), [100, 100]);
});

test('resigning settles exactly once and account deletion refunds active matches atomically', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'remove_a'); const b = await player(api, store, 'remove_b');
  const resigned = await accept(api, b, await request(api, a, b));
  const route = `/api/games/${resigned.id}/resign`;
  assert.equal((await api(route, {}, a.cookie)).data.game.winnerAccountId, b.accountId);
  assert.equal((await api(route, {}, a.cookie)).status, 200);
  assert.deepEqual(await balances(store, a, b), [90, 110]);
  const active = await accept(api, b, await request(api, a, b));
  const pending = await request(api, b, a);
  assert.deepEqual(await balances(store, a, b), [80, 100]);
  const removed = await api('/api/account', { confirmation: 'DELETE', currentPassword: password }, a.cookie, 'DELETE');
  assert.equal(removed.status, 200);
  assert.deepEqual(await balances(store, a, b), [undefined, 110]);
  for (const game of [active, pending]) {
    const saved = (await api(`/api/games/${game.id}`, undefined, b.cookie)).data.game;
    assert.equal(saved.status, 'cancelled'); assert.equal(saved.reason, 'account-deleted');
    assert.ok(saved.sender.username === 'Deleted player' || saved.recipient.username === 'Deleted player');
    assert.equal((await store.games.findOne({ _id: new ObjectId(game.id) })).escrowed, false);
  }
});

test('deletion racing acceptance never leaves escrow or orphan active games', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'race_delete_a'); const b = await player(api, store, 'race_delete_b');
  const game = await request(api, a, b);
  const results = await Promise.all([
    api(`/api/games/${game.id}/accept`, {}, b.cookie),
    api('/api/account', { confirmation: 'DELETE', currentPassword: password }, a.cookie, 'DELETE')
  ]);
  assert.equal(results[1].status, 200);
  assert.ok([200, 409].includes(results[0].status));
  const final = await store.games.findOne({ _id: new ObjectId(game.id) });
  assert.equal(final.status, 'cancelled'); assert.equal(final.escrowed, false);
  assert.deepEqual(await balances(store, a, b), [undefined, 100]);
});

test('account deletion preserves an earned timeout result instead of refunding the losing stake', async t => {
  const { api, store, advance } = await fixture(t);
  const a = await player(api, store, 'expired_delete_a'); const b = await player(api, store, 'expired_delete_b');
  const game = await accept(api, b, await request(api, a, b));
  advance(TURN_MS + 1);
  const removed = await api('/api/account', { confirmation: 'DELETE', currentPassword: password }, a.cookie, 'DELETE');
  assert.equal(removed.status, 200);
  const result = (await api(`/api/games/${game.id}`, undefined, b.cookie)).data.game;
  assert.equal(result.status, 'completed'); assert.equal(result.reason, 'timeout'); assert.equal(result.winnerAccountId, b.accountId);
  assert.deepEqual(await balances(store, a, b), [undefined, 110]);
});

test('reserved payout capacity blocks unsafe claims and trades while guaranteeing settlement', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'capacity_a', Number.MAX_SAFE_INTEGER - 10);
  const b = await player(api, store, 'capacity_b');
  const c = await player(api, store, 'capacity_c');
  const game = await accept(api, b, await request(api, a, b));
  assert.equal((await store.users.findOne({ _id: a.id })).gamePayoutReserve, 20);
  assert.ok(!JSON.stringify((await api('/api/me', undefined, a.cookie)).data).includes('gamePayoutReserve'));
  const created = await api('/api/trades', { recipientAccountId: a.accountId, clientOfferId: crypto.randomUUID() }, c.cookie);
  let trade = (await api(`/api/trades/${created.data.trade.id}/join`, {}, a.cookie)).data.trade;
  trade = (await api(`/api/trades/${trade.id}/contribution`, { version: trade.version, tokens: 1, cardIds: [] }, c.cookie)).data.trade;
  await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, c.cookie);
  const results = await Promise.all([
    api('/api/claim', { turnstileToken: 'fixture' }, a.cookie),
    api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, a.cookie),
    api(`/api/games/${game.id}/resign`, {}, b.cookie)
  ]);
  assert.deepEqual(results.map(result => result.status), [409, 409, 200]);
  assert.deepEqual(await balances(store, a, b, c), [Number.MAX_SAFE_INTEGER, 90, 100]);
  assert.equal((await store.users.findOne({ _id: a.id })).gamePayoutReserve, 0);
  assert.equal((await store.users.findOne({ _id: b.id })).gamePayoutReserve, 0);
  const blocked = await request(api, a, b);
  assert.equal((await api(`/api/games/${blocked.id}/accept`, {}, b.cookie)).status, 409);
  assert.deepEqual(await balances(store, a, b), [Number.MAX_SAFE_INTEGER, 90]);
});

test('overlapping game reserves release independently and do not restrict ordinary token claims', async t => {
  const { api, store } = await fixture(t);
  const a = await player(api, store, 'reserve_a'); const b = await player(api, store, 'reserve_b');
  const c = await player(api, store, 'reserve_c');
  const first = await accept(api, b, await request(api, a, b));
  const second = await accept(api, c, await request(api, a, c));
  assert.equal((await store.users.findOne({ _id: a.id })).gamePayoutReserve, 40);
  const results = await Promise.all([
    api('/api/claim', { turnstileToken: 'fixture' }, a.cookie),
    api(`/api/games/${first.id}/resign`, {}, b.cookie),
    api(`/api/games/${second.id}/resign`, {}, c.cookie)
  ]);
  assert.deepEqual(results.map(result => result.status), [200, 200, 200]);
  assert.deepEqual(await balances(store, a, b, c), [140, 90, 90]);
  assert.equal((await store.users.findOne({ _id: a.id })).gamePayoutReserve, 0);
});

test('standalone databases reject game stakes without changing wallets or records', async t => {
  const standalone = await MongoMemoryServer.create();
  t.after(() => standalone.stop());
  const { api, store } = await fixture(t, standalone.getUri());
  const a = await player(api, store, 'standalone_game_a'); const b = await player(api, store, 'standalone_game_b');
  const response = await api('/api/games', terms(b), a.cookie);
  assert.equal(response.status, 503);
  assert.equal(await store.games.countDocuments(), 0);
  assert.deepEqual(await balances(store, a, b), [100, 100]);
});
