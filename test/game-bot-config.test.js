const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp, connectMongo } = require('../server');
const { TURN_MS } = require('../games');

let mongo;
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });

async function storeFixture(t) {
  const store = await connectMongo({ uri: mongo.getUri(), dbName: `bot_config_${crypto.randomBytes(5).toString('hex')}` });
  t.after(() => store.client.close()); return store;
}
function appApi(t, store, options = {}) {
  const server = createApp(store, { mailer: null, ...options }).listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (route, body, cookie) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
}
async function player(api, store, username) {
  const response = await api('/api/register', { username, password: 'bot-config-test-password' });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  await store.users.updateOne({ accountId: response.data.user.accountId }, { $set: { balance: 100 } });
  const saved = await store.users.findOne({ accountId: response.data.user.accountId });
  return { ...response.data.user, id: saved._id, cookie: response.cookie };
}
const terms = extra => ({ opponentType: 'bot', game: 'rock-paper-scissors', stake: 10, clientRequestId: crypto.randomUUID(), ...extra });
const wallets = store => store.users.find().sort({ _id: 1 }).toArray();
async function create(api, actor, payload) {
  const response = await api('/api/games', payload, actor.cookie);
  assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data.game;
}
function preserveEnv(t) {
  const previous = process.env.GAME_BOTS_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.GAME_BOTS_ENABLED;
    else process.env.GAME_BOTS_ENABLED = previous;
  });
}

test('bots default off and the environment opts in only with the literal true string', async t => {
  preserveEnv(t); const store = await storeFixture(t);
  const actor = await player(appApi(t, store, { gameBotsEnabled: false }), store, 'bot_env_config');
  for (const [value, expected] of [[undefined, false], ['', false], ['false', false], ['TRUE', false], ['True', false],
    ['1', false], ['yes', false], [' true', false], ['true ', false], ['true', true]]) {
    if (value === undefined) delete process.env.GAME_BOTS_ENABLED;
    else process.env.GAME_BOTS_ENABLED = value;
    const result = await appApi(t, store)('/api/games', undefined, actor.cookie);
    assert.equal(result.status, 200); assert.equal(result.data.botsEnabled, expected, `GAME_BOTS_ENABLED=${value}`);
    assert.equal(typeof result.data.botsEnabled, 'boolean'); assert.deepEqual(result.data.games, []);
  }
});

test('the explicit application option uses strict booleans and overrides the environment', async t => {
  preserveEnv(t); const store = await storeFixture(t);
  const actor = await player(appApi(t, store, { gameBotsEnabled: false }), store, 'bot_option_config');
  for (const [environment, option, expected] of [['false', true, true], ['true', false, false],
    ['true', 'true', false], ['true', 1, false], ['true', null, false], ['true', undefined, true]]) {
    process.env.GAME_BOTS_ENABLED = environment;
    const result = await appApi(t, store, { gameBotsEnabled: option })('/api/games', undefined, actor.cookie);
    assert.equal(result.status, 200); assert.equal(result.data.botsEnabled, expected, `${environment}/${String(option)}`);
  }
});

test('disabled bots reject direct bot and mixed requests without randomness, escrow, or storage', async t => {
  preserveEnv(t); delete process.env.GAME_BOTS_ENABLED;
  const store = await storeFixture(t); let randomCalls = 0;
  const api = appApi(t, store, { randomBot: () => { randomCalls++; return 0; }, randomDice: () => { randomCalls++; return 1; } });
  const a = await player(api, store, 'bot_off_host'); const b = await player(api, store, 'bot_off_guest');
  const before = await wallets(store);
  for (const extra of [{}, { game: 'dice' }, { game: 'dice', botCount: 3 },
    { game: 'dice', opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId] },
    { botsEnabled: true, gameBotsEnabled: true }]) {
    const payload = terms(extra);
    const responses = await Promise.all([api('/api/games', payload, a.cookie), api('/api/games', payload, a.cookie)]);
    for (const response of responses) { assert.equal(response.status, 403); assert.equal(response.data.error, 'Bots are disabled.'); }
  }
  const ttt = await api('/api/games', terms({ game: 'tic-tac-toe' }), a.cookie);
  assert.ok([400, 403].includes(ttt.status));
  assert.equal((await api('/api/games', terms({ game: 'dice', opponentType: 'player', botCount: 1, recipientAccountIds: [b.accountId] }), a.cookie)).status, 400);
  assert.equal(randomCalls, 0); assert.equal(await store.games.countDocuments(), 0); assert.deepEqual(await wallets(store), before);
  const list = await api('/api/games', undefined, a.cookie); assert.equal(list.data.botsEnabled, false);
  const human = await create(api, a, terms({ opponentType: 'player', recipientAccountId: b.accountId }));
  assert.equal(human.status, 'pending'); assert.equal(human.recipient.accountId, b.accountId);
  assert.equal((await store.users.findOne({ _id: a.id })).balance, 100);
});

test('explicit opt-in permits RPS and pure or mixed Dice while fresh Tic-Tac-Toe bots stay disabled', async t => {
  const store = await storeFixture(t); let botCalls = 0, diceCalls = 0;
  const api = appApi(t, store, { gameBotsEnabled: true,
    randomBot: () => { botCalls++; return 0; }, randomDice: () => { diceCalls++; return 1; } });
  const a = await player(api, store, 'bot_on_host'); const b = await player(api, store, 'bot_on_guest');
  assert.equal((await api('/api/games', undefined, a.cookie)).data.botsEnabled, true);
  const rps = await create(api, a, terms({ stake: 3 })); assert.equal(rps.status, 'playing');
  const dice = await create(api, a, terms({ game: 'dice', stake: 4 })); assert.equal(dice.status, 'playing');
  let mixed = await create(api, a, terms({ game: 'dice', stake: 5, opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId] }));
  assert.equal(mixed.status, 'pending');
  const accepted = await api(`/api/games/${mixed.id}/accept`, {}, b.cookie); assert.equal(accepted.status, 200); mixed = accepted.data.game;
  assert.equal(mixed.status, 'playing'); assert.equal(mixed.players.filter(entry => entry.isBot).length, 1);
  assert.equal((await api('/api/games', terms({ game: 'tic-tac-toe' }), a.cookie)).status, 400);
  assert.equal(await store.games.countDocuments(), 3); assert.equal(await store.users.countDocuments(), 2);
  assert.equal(botCalls, 1); assert.equal(diceCalls, 2);
  assert.equal((await store.users.findOne({ _id: a.id })).balance, 88);
  assert.equal((await store.users.findOne({ _id: b.id })).balance, 95);
});

test('turning bots off preserves exact request replay and existing RPS moves and mixed Dice acceptance', async t => {
  const store = await storeFixture(t);
  const enabled = appApi(t, store, { gameBotsEnabled: true, randomBot: () => 0 });
  const a = await player(enabled, store, 'bot_restart_host'); const b = await player(enabled, store, 'bot_restart_guest');
  const rpsTerms = terms(); const mixedTerms = terms({ game: 'dice', opponentType: 'mixed', botCount: 1, recipientAccountIds: [b.accountId] });
  const rps = await create(enabled, a, rpsTerms); const mixed = await create(enabled, a, mixedTerms);
  const before = await wallets(store); let randomCalls = 0; const rolls = [1, 6, 2];
  const disabled = appApi(t, store, { gameBotsEnabled: false,
    randomBot: () => { randomCalls++; return 2; }, randomDice: () => rolls.shift() });
  assert.equal((await disabled('/api/games', undefined, a.cookie)).data.botsEnabled, false);
  assert.equal((await create(disabled, a, rpsTerms)).id, rps.id);
  assert.equal((await create(disabled, a, mixedTerms)).id, mixed.id);
  assert.deepEqual(await wallets(store), before); assert.equal(await store.games.countDocuments(), 2); assert.equal(randomCalls, 0);
  assert.equal((await disabled('/api/games', { ...rpsTerms, clientRequestId: crypto.randomUUID() }, a.cookie)).status, 403);
  assert.equal((await disabled('/api/games', { ...mixedTerms, clientRequestId: crypto.randomUUID() }, a.cookie)).status, 403);
  assert.equal((await disabled('/api/games', { ...rpsTerms, stake: 11 }, a.cookie)).status, 409);
  const win = await disabled(`/api/games/${rps.id}/move`, { choice: 'paper', clientMoveId: crypto.randomUUID() }, a.cookie);
  assert.equal(win.status, 200); assert.equal(win.data.game.winnerAccountId, a.accountId);
  const accepted = await disabled(`/api/games/${mixed.id}/accept`, {}, b.cookie);
  assert.equal(accepted.status, 200); assert.equal(accepted.data.game.status, 'playing');
  assert.deepEqual(accepted.data.game.dice.rolls, { 'BOT-1': 1 });
  const first = await disabled(`/api/games/${mixed.id}/move`, { round: 1, clientMoveId: crypto.randomUUID() }, a.cookie); assert.equal(first.status, 200);
  const second = await disabled(`/api/games/${mixed.id}/move`, { round: 1, clientMoveId: crypto.randomUUID() }, b.cookie);
  assert.equal(second.status, 200); assert.equal(second.data.game.status, 'completed');
  assert.equal((await store.users.findOne({ _id: a.id })).balance, 120);
  assert.equal((await store.users.findOne({ _id: b.id })).balance, 100);
  assert.equal((await store.users.findOne({ _id: a.id })).gamePayoutReserve, 0);
  assert.equal((await store.users.findOne({ _id: b.id })).gamePayoutReserve, 0);
  assert.equal((await create(disabled, a, rpsTerms)).status, 'completed');
  assert.equal(await store.games.countDocuments(), 2); assert.equal(await store.users.countDocuments(), 2);
});

test('disabled bots keep historical Tic-Tac-Toe escrow replayable and safely settled', async t => {
  const store = await storeFixture(t); let randomCalls = 0;
  const api = appApi(t, store, { gameBotsEnabled: false, randomBot: () => { randomCalls++; return 0; } });
  const a = await player(api, store, 'bot_legacy_off'); const at = new Date();
  const saved = { _id: new ObjectId(), clientRequestId: crypto.randomUUID(), game: 'tic-tac-toe', opponentType: 'bot', stake: 10,
    status: 'playing', version: 1, senderUserId: a.id, senderAccountId: a.accountId, senderUsername: a.username,
    recipientUserId: 'bot', recipientAccountId: 'BOT', recipientUsername: 'Bot', board: Array(9).fill(null), choices: null,
    xUserId: a.id, turnUserId: a.id, winnerUserId: null, escrowed: true, payoutReserved: true, moves: [],
    createdAt: at, updatedAt: at, acceptedAt: at, expiresAt: new Date(at.getTime() + TURN_MS) };
  await store.users.updateOne({ _id: a.id }, { $inc: { balance: -10, gamePayoutReserve: 20 } });
  await store.games.insertOne(saved); const before = await wallets(store);
  const replay = await create(api, a, terms({ game: 'tic-tac-toe', clientRequestId: saved.clientRequestId }));
  assert.equal(replay.id, saved._id.toString()); assert.deepEqual(await wallets(store), before); assert.equal(randomCalls, 0);
  const move = await api(`/api/games/${replay.id}/move`, { position: 0, clientMoveId: crypto.randomUUID() }, a.cookie);
  assert.equal(move.status, 200); assert.deepEqual(move.data.game.board, ['X', 'O', null, null, null, null, null, null, null]);
  const ended = await api(`/api/games/${replay.id}/resign`, {}, a.cookie); assert.equal(ended.status, 200);
  assert.equal(ended.data.game.status, 'completed'); assert.equal((await store.users.findOne({ _id: a.id })).balance, 90);
  assert.equal((await store.users.findOne({ _id: a.id })).gamePayoutReserve, 0);
  assert.equal(await store.users.countDocuments(), 1); assert.equal(await store.games.countDocuments(), 1);
});
