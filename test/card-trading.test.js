const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { ObjectId } = require('mongodb');
const { createApp, connectMongo } = require('../server');
const { grantCards, upsertCardDefinition } = require('../cards');

let mongo;
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });

function serve(t, store) {
  const server = createApp(store, { mailer: null }).listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route, body, cookie, method) => {
    const response = await fetch(base + route, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
}

async function fixture(t) {
  const store = await connectMongo({ uri: mongo.getUri(), dbName: `card_session_${crypto.randomBytes(5).toString('hex')}` });
  t.after(() => store.client.close());
  await store.cardDefinitions.insertMany([
    { _id: 'test-jalapeno', name: 'Test Jalapeño', rarity: 'Common', setName: 'Test Harvest', imageUrl: null },
    { _id: 'test-habanero', name: 'Test Habanero', rarity: 'Rare', setName: 'Test Harvest', imageUrl: '/test-habanero.webp' }
  ]);
  return { store, api: serve(t, store) };
}

async function player(api, store, username, balance = 0) {
  const registered = await api('/api/register', { username, password: 'card-trading-password' });
  assert.equal(registered.status, 201);
  const saved = await store.users.findOne({ accountId: registered.data.user.accountId });
  await store.users.updateOne({ _id: saved._id }, { $set: { balance } });
  return { ...registered.data.user, id: saved._id, cookie: registered.cookie };
}

async function copy(store, owner, cardId = 'test-jalapeno', extra = {}) {
  const card = { _id: new ObjectId(), cardId, ownerUserId: owner.id, ownerAccountId: owner.accountId,
    tradable: true, createdAt: new Date(), acquiredAt: new Date(), grantId: crypto.randomUUID(), ...extra };
  await store.cardInstances.insertOne(card);
  return card._id.toString();
}

function terms(recipient, offeredCardIds = [], extra = {}) {
  return { recipientAccountId: recipient.accountId, offeredTokens: 0, offeredCardIds, clientOfferId: crypto.randomUUID(), ...extra };
}

async function offer(api, sender, payload) {
  const response = await api('/api/trades', payload, sender.cookie);
  assert.equal(response.status, 201);
  return response.data.trade;
}

async function join(api, recipient, trade) {
  const response = await api(`/api/trades/${trade.id}/join`, {}, recipient.cookie);
  assert.equal(response.status, 200);
  return response.data.trade;
}

async function contribute(api, actor, trade, cardIds, tokens = 0) {
  const response = await api(`/api/trades/${trade.id}/contribution`, { tokens, cardIds, version: trade.version }, actor.cookie);
  assert.equal(response.status, 200);
  return response.data.trade;
}

async function start(api, sender, recipient, cardIds = [], tokens = 0) {
  let trade = await join(api, recipient, await offer(api, sender, terms(recipient)));
  if (cardIds.length || tokens) trade = await contribute(api, sender, trade, cardIds, tokens);
  return trade;
}

async function settle(api, sender, recipient, original) {
  const trade = original.status === 'pending' ? await join(api, recipient, original) : original;
  const first = await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, sender.cookie);
  assert.equal(first.status, 200);
  const second = await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie);
  assert.equal(second.status, 200);
  return second.data.trade;
}

async function ownerOf(store, id) {
  const card = await store.cardInstances.findOne({ _id: new ObjectId(id) });
  return { userId: card.ownerUserId.toString(), accountId: card.ownerAccountId };
}

async function balances(store, ...players) {
  return Promise.all(players.map(async account => (await store.users.findOne({ _id: account.id })).balance));
}

test('own inventory requires login, lists genuine tradable copies, and cannot expose another player’s inventory', async t => {
  const { api, store } = await fixture(t);
  const owner = await player(api, store, 'inventory_owner', 10);
  const viewer = await player(api, store, 'inventory_viewer');
  const first = await copy(store, owner);
  const second = await copy(store, owner);
  await copy(store, owner, 'test-habanero', { tradable: false });
  await copy(store, owner, 'missing-definition');
  const other = await copy(store, viewer, 'test-habanero');
  assert.equal((await api('/api/trades/inventory')).status, 401);
  assert.equal((await api(`/api/trades/inventory/${owner.accountId}`)).status, 404);
  const mine = await api('/api/trades/inventory', undefined, owner.cookie);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.owner, { username: owner.username, accountId: owner.accountId });
  assert.deepEqual(new Set(mine.data.cards.map(card => card.id)), new Set([first, second]));
  for (const card of mine.data.cards) {
    assert.deepEqual(Object.keys(card).sort(), ['acquiredAt', 'cardId', 'id', 'imageUrl', 'name', 'rarity', 'setName', 'tradable']);
    assert.equal(card.cardId, 'test-jalapeno');
    assert.equal(card.name, 'Test Jalapeño');
    assert.equal(card.rarity, 'Common');
    assert.equal(card.setName, 'Test Harvest');
    assert.equal(card.imageUrl, null);
    assert.equal(card.tradable, true);
    assert.ok(Date.parse(card.acquiredAt));
  }
  const publicInventory = await api(`/api/trades/inventory/${owner.accountId}`, undefined, viewer.cookie);
  assert.equal(publicInventory.status, 404);
  assert.deepEqual((await api('/api/trades/inventory', undefined, viewer.cookie)).data.cards.map(card => card.id), [other]);
  assert.equal((await api('/api/trades/inventory/invalid', undefined, viewer.cookie)).status, 404);
  assert.equal((await api(`/api/trades/inventory/PPR-${crypto.randomUUID().toUpperCase()}`, undefined, viewer.cookie)).status, 404);
});


test('each player chooses their own concrete copies and both confirmations exchange cards without touching other copies', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'card_sender', 20);
  const recipient = await player(api, store, 'card_recipient', 30);
  const offered = await copy(store, sender);
  const sameDefinition = await copy(store, sender);
  const requested = await copy(store, recipient, 'test-habanero');
  let trade = await offer(api, sender, terms(recipient));
  assert.deepEqual(trade.offeredCards, []);
  assert.deepEqual(trade.requestedCards, []);
  trade = await join(api, recipient, trade);
  trade = await contribute(api, sender, trade, [offered]);
  assert.deepEqual(trade.offeredCards, [{ id: offered, cardId: 'test-jalapeno', name: 'Test Jalapeño', rarity: 'Common', setName: 'Test Harvest', imageUrl: null }]);
  trade = await contribute(api, recipient, trade, [requested]);
  assert.deepEqual(trade.requestedCards, [{ id: requested, cardId: 'test-habanero', name: 'Test Habanero', rarity: 'Rare', setName: 'Test Harvest', imageUrl: '/test-habanero.webp' }]);
  assert.equal((await ownerOf(store, offered)).accountId, sender.accountId);
  assert.equal((await ownerOf(store, requested)).accountId, recipient.accountId);
  const accepted = await settle(api, sender, recipient, trade);
  assert.equal(accepted.status, 'accepted');
  assert.equal((await ownerOf(store, offered)).accountId, recipient.accountId);
  assert.equal((await ownerOf(store, requested)).accountId, sender.accountId);
  assert.equal((await ownerOf(store, sameDefinition)).accountId, sender.accountId);
  assert.deepEqual(await balances(store, sender, recipient), [20, 30]);
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 200);
  assert.equal(await store.cardInstances.countDocuments(), 3);
});

test('players can agree to card for token sales and mixed card and token exchanges', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'mixed_sender', 40);
  const recipient = await player(api, store, 'mixed_recipient', 60);
  const sold = await copy(store, sender);
  let sale = await start(api, sender, recipient, [sold]);
  sale = await contribute(api, recipient, sale, [], 15);
  assert.equal((await settle(api, sender, recipient, sale)).status, 'accepted');
  assert.deepEqual(await balances(store, sender, recipient), [55, 45]);
  assert.equal((await ownerOf(store, sold)).accountId, recipient.accountId);
  const offered = await copy(store, sender);
  const requested = await copy(store, recipient, 'test-habanero');
  let mixed = await start(api, sender, recipient, [offered], 12);
  mixed = await contribute(api, recipient, mixed, [requested], 5);
  assert.equal((await settle(api, sender, recipient, mixed)).status, 'accepted');
  assert.deepEqual(await balances(store, sender, recipient), [48, 52]);
  assert.equal((await ownerOf(store, offered)).accountId, recipient.accountId);
  assert.equal((await ownerOf(store, requested)).accountId, sender.accountId);
});

test('either player may contribute a card gift while cancellation keeps unconfirmed cards with their owners', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'giftcard_sender');
  const recipient = await player(api, store, 'giftcard_recipient');
  const gifted = await copy(store, sender);
  assert.equal((await settle(api, sender, recipient, await start(api, sender, recipient, [gifted]))).status, 'accepted');
  assert.equal((await ownerOf(store, gifted)).accountId, recipient.accountId);
  let giftBack = await join(api, recipient, await offer(api, sender, terms(recipient)));
  giftBack = await contribute(api, recipient, giftBack, [gifted]);
  assert.equal((await settle(api, sender, recipient, giftBack)).status, 'accepted');
  assert.equal((await ownerOf(store, gifted)).accountId, sender.accountId);
  for (const actor of [sender, recipient]) {
    const cancelled = await start(api, sender, recipient, [gifted]);
    assert.equal((await api(`/api/trades/${cancelled.id}/cancel`, {}, actor.cookie)).status, 200);
    assert.equal((await ownerOf(store, gifted)).accountId, sender.accountId);
  }
});

test('only joined participants can select their own unique bounded card copies', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'validatecard_sender');
  const recipient = await player(api, store, 'validatecard_recipient');
  const first = await copy(store, sender);
  const second = await copy(store, sender);
  const alien = await copy(store, recipient);
  const blocked = await copy(store, sender, 'test-jalapeno', { tradable: false });
  const unknown = await copy(store, sender, 'unknown-card');
  const inconsistent = await copy(store, sender, 'test-jalapeno', { ownerAccountId: recipient.accountId });
  const large = await Promise.all(Array.from({ length: 51 }, () => copy(store, sender)));
  let trade = await start(api, sender, recipient);
  for (const cardIds of [null, {}, first, [1], [false], ['invalid'], ['a'.repeat(23)], ['z'.repeat(24)], [first, first], [first, first.toUpperCase()], large]) {
    assert.equal((await api('/api/trades', terms(recipient, cardIds), sender.cookie)).status, 400);
    assert.equal((await api(`/api/trades/${trade.id}/contribution`, { tokens: 0, cardIds, version: trade.version }, sender.cookie)).status, 400);
  }
  for (const cardIds of [[first], [alien], [blocked], [unknown], [inconsistent], [new ObjectId().toString()]]) {
    assert.equal((await api('/api/trades', terms(recipient, cardIds), sender.cookie)).status, 400);
  }
  for (const cardIds of [[alien], [blocked], [unknown], [inconsistent], [new ObjectId().toString()]]) {
    assert.equal((await api(`/api/trades/${trade.id}/contribution`, { tokens: 0, cardIds, version: trade.version }, sender.cookie)).status, 409);
  }
  trade = await contribute(api, sender, trade, [first, second]);
  const canonical = await contribute(api, sender, trade, [second.toUpperCase(), first.toUpperCase()]);
  assert.equal(canonical.version, trade.version);
  assert.equal(canonical.offeredCards.length, 2);
  assert.equal((await api(`/api/trades/${trade.id}/contribution`, { tokens: 0, cardIds: [first], version: trade.version }, recipient.cookie)).status, 409);
  assert.equal((await api(`/api/trades/${trade.id}/contribution`, { tokens: 0, cardIds: [alien], version: trade.version }, sender.cookie)).status, 409);
  trade = await contribute(api, recipient, trade, [alien]);
  assert.equal(trade.requestedCards[0].id, alien);
  assert.equal(trade.offeredCards.length, 2);
});

test('each side may contribute 50 cards and final confirmation transfers all 100 copies together', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'limitcard_sender');
  const recipient = await player(api, store, 'limitcard_recipient');
  const offered = await Promise.all(Array.from({ length: 50 }, () => copy(store, sender)));
  const requested = await Promise.all(Array.from({ length: 50 }, () => copy(store, recipient, 'test-habanero')));
  let trade = await start(api, sender, recipient, offered);
  trade = await contribute(api, recipient, trade, requested);
  assert.equal((await settle(api, sender, recipient, trade)).status, 'accepted');
  assert.equal(await store.cardInstances.countDocuments({ ownerUserId: sender.id, cardId: 'test-habanero', ownerAccountId: sender.accountId }), 50);
  assert.equal(await store.cardInstances.countDocuments({ ownerUserId: recipient.id, cardId: 'test-jalapeno', ownerAccountId: recipient.accountId }), 50);
  assert.equal(await store.cardInstances.countDocuments(), 100);
});

test('cards transferred in another session invalidate stale selections without moving the stale session’s tokens or partner cards', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'stale_sender', 20);
  const recipient = await player(api, store, 'stale_recipient', 10);
  const other = await player(api, store, 'stale_other');
  const offered = await copy(store, sender);
  const requested = await copy(store, recipient, 'test-habanero');
  let stale = await start(api, sender, recipient, [offered], 5);
  stale = await contribute(api, recipient, stale, [requested], 2);
  assert.equal((await api(`/api/trades/${stale.id}/confirm`, { version: stale.version }, sender.cookie)).status, 200);
  assert.equal((await settle(api, sender, other, await start(api, sender, other, [offered]))).status, 'accepted');
  assert.equal((await api(`/api/trades/${stale.id}/confirm`, { version: stale.version }, recipient.cookie)).status, 409);
  assert.deepEqual(await balances(store, sender, recipient, other), [20, 10, 0]);
  assert.equal((await ownerOf(store, offered)).accountId, other.accountId);
  assert.equal((await ownerOf(store, requested)).accountId, recipient.accountId);
  assert.equal((await api(`/api/trades/${stale.id}`, undefined, sender.cookie)).data.trade.status, 'negotiating');
});

test('final confirmation rechecks tradability, catalog existence, and the original copy’s catalog identity', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'recheckcard_sender', 20);
  const recipient = await player(api, store, 'recheckcard_recipient', 10);
  const id = await copy(store, sender);
  const trade = await start(api, sender, recipient, [id], 2);
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, sender.cookie)).status, 200);
  await store.cardInstances.updateOne({ _id: new ObjectId(id) }, { $set: { tradable: false } });
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 409);
  await store.cardInstances.updateOne({ _id: new ObjectId(id) }, { $set: { tradable: true, cardId: 'test-habanero' } });
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 409);
  await store.cardInstances.updateOne({ _id: new ObjectId(id) }, { $set: { cardId: 'test-jalapeno' } });
  await store.cardDefinitions.deleteOne({ _id: 'test-jalapeno' });
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 409);
  const saved = (await api(`/api/trades/${trade.id}`, undefined, sender.cookie)).data.trade;
  assert.deepEqual(saved.offeredCards, trade.offeredCards);
  assert.equal(saved.status, 'negotiating');
  assert.deepEqual(await balances(store, sender, recipient), [20, 10]);
  assert.equal((await ownerOf(store, id)).accountId, sender.accountId);
});

test('competing final confirmations for one card settle one session and leave the other session’s balances untouched', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'cardrace_sender', 20);
  const recipient = await player(api, store, 'cardrace_recipient', 10);
  const other = await player(api, store, 'cardrace_other', 10);
  const id = await copy(store, sender);
  let first = await start(api, sender, recipient, [id], 2);
  let second = await start(api, sender, other, [id], 2);
  first = await contribute(api, recipient, first, [], 5);
  second = await contribute(api, other, second, [], 5);
  for (const trade of [first, second]) assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, sender.cookie)).status, 200);
  const outcomes = await Promise.all([
    api(`/api/trades/${first.id}/confirm`, { version: first.version }, recipient.cookie),
    api(`/api/trades/${second.id}/confirm`, { version: second.version }, other.cookie)
  ]);
  assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 409]);
  const winner = outcomes[0].status === 200 ? recipient : other;
  assert.equal((await ownerOf(store, id)).accountId, winner.accountId);
  assert.deepEqual(await balances(store, sender, recipient, other), winner === recipient ? [23, 7, 10] : [23, 10, 7]);
  assert.equal(await store.cardInstances.countDocuments(), 1);
});

test('a failure on the last card write rolls back earlier cards, token balances, and the second confirmation', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'rollbackcard_sender', 40);
  const recipient = await player(api, store, 'rollbackcard_recipient', 20);
  const offered = await copy(store, sender);
  const requested = await copy(store, recipient, 'test-habanero');
  let trade = await start(api, sender, recipient, [offered], 12);
  trade = await contribute(api, recipient, trade, [requested], 4);
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, sender.cookie)).status, 200);
  const original = store.cardInstances.updateOne;
  let earlierWrite = false;
  store.cardInstances.updateOne = async function (filter, update, options) {
    if (options?.session && filter._id.equals(new ObjectId(requested))) { assert.equal(earlierWrite, true); throw new Error('Injected final card transfer failure'); }
    const result = await original.call(this, filter, update, options);
    if (options?.session && filter._id.equals(new ObjectId(offered))) earlierWrite = true;
    return result;
  };
  t.after(() => { store.cardInstances.updateOne = original; });
  t.mock.method(console, 'error', () => {});
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 500);
  assert.equal(earlierWrite, true);
  assert.deepEqual(await balances(store, sender, recipient), [40, 20]);
  assert.equal((await ownerOf(store, offered)).accountId, sender.accountId);
  assert.equal((await ownerOf(store, requested)).accountId, recipient.accountId);
  const saved = (await api(`/api/trades/${trade.id}`, undefined, sender.cookie)).data.trade;
  assert.equal(saved.status, 'negotiating');
  assert.equal(saved.senderConfirmed, true);
  assert.equal(saved.recipientConfirmed, false);
  store.cardInstances.updateOne = original;
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 200);
  assert.deepEqual(await balances(store, sender, recipient), [32, 28]);
});

test('card contribution snapshots survive catalog renaming and reconnects while inventory shows current metadata', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'snapshot_sender');
  const recipient = await player(api, store, 'snapshot_recipient');
  const id = await copy(store, sender);
  const trade = await start(api, sender, recipient, [id]);
  await store.cardDefinitions.updateOne({ _id: 'test-jalapeno' }, { $set: { name: 'Renamed Jalapeño', rarity: 'Uncommon', setName: 'New Test Set', imageUrl: '/renamed.webp' } });
  assert.equal((await api('/api/trades/inventory', undefined, sender.cookie)).data.cards[0].name, 'Renamed Jalapeño');
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: store.db.databaseName });
  t.after(() => reconnected.client.close());
  const freshApi = serve(t, reconnected);
  assert.deepEqual((await freshApi(`/api/trades/${trade.id}`, undefined, sender.cookie)).data.trade.offeredCards, trade.offeredCards);
  assert.equal((await settle(freshApi, sender, recipient, trade)).status, 'accepted');
  assert.equal((await api('/api/trades/inventory', undefined, recipient.cookie)).data.cards[0].name, 'Renamed Jalapeño');
  assert.deepEqual((await api(`/api/trades/${trade.id}`, undefined, recipient.cookie)).data.trade.offeredCards, trade.offeredCards);
});

test('original card request retries remain idempotent after replacing contributions and transferring the original copy elsewhere', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'retrycard_sender');
  const recipient = await player(api, store, 'retrycard_recipient');
  const other = await player(api, store, 'retrycard_other');
  const first = await copy(store, sender);
  const second = await copy(store, sender);
  const payload = terms(recipient);
  let trade = await join(api, recipient, await offer(api, sender, payload));
  trade = await contribute(api, sender, trade, [first]);
  trade = await contribute(api, sender, trade, [second]);
  assert.equal((await settle(api, sender, other, await start(api, sender, other, [first]))).status, 'accepted');
  const replay = await api('/api/trades', payload, sender.cookie);
  assert.equal(replay.status, 201);
  assert.equal(replay.data.trade.id, trade.id);
  assert.equal(replay.data.trade.offeredCards[0].id, second);
  assert.equal((await api('/api/trades', { ...payload, offeredCardIds: [second] }, sender.cookie)).status, 400);
});

test('trusted card grant receipts survive trading and account deletion without issuing replacement copies', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'grant_sender');
  const recipient = await player(api, store, 'grant_recipient');
  const payload = {
    ownerAccountId: sender.accountId,
    cardIds: ['test-jalapeno', 'test-habanero', 'test-jalapeno'], grantId: crypto.randomUUID()
  };
  const granted = await grantCards(store, payload);
  assert.equal(granted.grantId, payload.grantId);
  assert.equal(granted.ownerAccountId, sender.accountId);
  assert.equal(new Set(granted.cardInstanceIds).size, 3);
  assert.ok(Date.parse(granted.createdAt));
  assert.equal(await store.cardInstances.countDocuments({ ownerAccountId: sender.accountId, cardId: 'test-jalapeno' }), 2);
  assert.equal(await store.cardGrants.countDocuments(), 1);
  const trade = await start(api, sender, recipient, granted.cardInstanceIds);
  assert.equal((await settle(api, sender, recipient, trade)).status, 'accepted');
  const deleted = await api('/api/account', { currentPassword: 'card-trading-password', confirmation: 'DELETE' }, sender.cookie, 'DELETE');
  assert.equal(deleted.status, 200);
  await store.cardDefinitions.deleteMany({});
  const replayed = await grantCards(store, { ...payload, cardIds: [...payload.cardIds].reverse(), grantId: payload.grantId.toUpperCase() });
  assert.deepEqual(replayed, granted);
  assert.equal(await store.cardInstances.countDocuments(), 3);
  assert.equal(await store.cardInstances.countDocuments({ ownerAccountId: recipient.accountId }), 3);
  assert.equal(await store.cardInstances.countDocuments({ ownerAccountId: sender.accountId }), 0);
  for (const change of [{ ownerAccountId: recipient.accountId }, { cardIds: ['different-catalog-entry'] }, { cardIds: ['test-jalapeno'] }]) {
    await assert.rejects(grantCards(store, { ...payload, ...change }), error => error.status === 409);
  }
  assert.equal(await store.cardGrants.countDocuments(), 1);
});

test('concurrent trusted grants with one receipt ID issue only one set of copies', async t => {
  const { api, store } = await fixture(t);
  const owner = await player(api, store, 'grantrace_owner');
  const payload = { ownerAccountId: owner.accountId, cardIds: ['test-jalapeno', 'test-jalapeno'], grantId: crypto.randomUUID() };
  const results = await Promise.all(Array.from({ length: 4 }, () => grantCards(store, payload)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(await store.cardGrants.countDocuments(), 1);
  assert.equal(await store.cardInstances.countDocuments(), 2);
});

test('a grant whose owner is deleted after its read cannot create orphan cards or a receipt', async t => {
  const { api, store } = await fixture(t);
  const owner = await player(api, store, 'grant_deleted_owner');
  const payload = { ownerAccountId: owner.accountId, cardIds: ['test-jalapeno'], grantId: crypto.randomUUID() };
  let ownerRead;
  const ownerWasRead = new Promise(resolve => { ownerRead = resolve; });
  let releaseRead;
  const resume = new Promise(resolve => { releaseRead = resolve; });
  const findOne = store.users.findOne.bind(store.users);
  let paused = false;
  store.users.findOne = async (filter, options) => {
    const result = await findOne(filter, options);
    if (!paused && filter.accountId === owner.accountId && options?.session) {
      paused = true;
      ownerRead();
      await resume;
    }
    return result;
  };
  t.after(() => { releaseRead(); store.users.findOne = findOne; });
  const issuance = assert.rejects(grantCards(store, payload), error => error.status === 404);
  await ownerWasRead;
  try {
    const deleted = await api('/api/account', { currentPassword: 'card-trading-password', confirmation: 'DELETE' }, owner.cookie, 'DELETE');
    assert.equal(deleted.status, 200);
  } finally { releaseRead(); }
  await issuance;
  assert.equal(await store.users.countDocuments({ _id: owner.id }), 0);
  assert.equal(await store.cardInstances.countDocuments({ ownerUserId: owner.id }), 0);
  assert.equal(await store.cardGrants.countDocuments({ _id: payload.grantId }), 0);
});

test('one global grant ID cannot concurrently issue cards to two different owners', async t => {
  const { api, store } = await fixture(t);
  const first = await player(api, store, 'globalgrant_first');
  const second = await player(api, store, 'globalgrant_second');
  const grantId = crypto.randomUUID();
  const attempts = await Promise.allSettled([first, second].map(owner => grantCards(store, {
    ownerAccountId: owner.accountId, cardIds: ['test-jalapeno'], grantId
  })));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
  const winner = attempts.find(result => result.status === 'fulfilled').value;
  assert.equal(await store.cardGrants.countDocuments(), 1);
  assert.equal(await store.cardInstances.countDocuments(), 1);
  assert.equal((await ownerOf(store, winner.cardInstanceIds[0])).accountId, winner.ownerAccountId);
});

test('trusted grant and catalog validation cannot issue fabricated cards or accept unsafe definitions', async t => {
  const { api, store } = await fixture(t);
  const owner = await player(api, store, 'grantvalidate_owner');
  const payload = { ownerAccountId: owner.accountId, cardIds: ['test-jalapeno'], grantId: crypto.randomUUID() };
  for (const change of [
    { cardIds: [] }, { cardIds: ['test-jalapeno', 'missing-card'] }, { cardIds: [1] },
    { cardIds: ['invalid card id'] }, { cardIds: Array(101).fill('test-jalapeno') },
    { ownerAccountId: owner.username }, { grantId: 'invalid' }
  ]) {
    await assert.rejects(grantCards(store, { ...payload, ...change }), error => error.status === 400);
  }
  await assert.rejects(grantCards(store, { ...payload, ownerAccountId: `PPR-${crypto.randomUUID().toUpperCase()}` }), error => error.status === 404);
  for (const change of [{ id: '../unsafe' }, { name: '' }, { imageUrl: 'javascript:alert(1)' }, { imageUrl: '//untrusted.example/card.png' }]) {
    await assert.rejects(upsertCardDefinition(store, { id: 'valid-card', name: 'Valid card', ...change }), error => error.status === 400);
  }
  assert.equal(await store.cardInstances.countDocuments(), 0);
  assert.equal(await store.cardGrants.countDocuments(), 0);
  const defined = await upsertCardDefinition(store, { id: 'new-test-card', name: ' New Test Card ', rarity: ' Rare ', setName: ' Test Set ', imageUrl: '/test-card.webp' });
  assert.equal(defined.name, 'New Test Card');
  const granted = await grantCards(store, { ...payload, cardIds: ['new-test-card'] });
  assert.equal(granted.cardInstanceIds.length, 1);
  assert.equal((await api('/api/trades/inventory', undefined, owner.cookie)).data.cards[0].name, 'New Test Card');
});

test('failed card issuance rolls back its receipt and honors a containing transaction rollback', async t => {
  const { api, store } = await fixture(t);
  const owner = await player(api, store, 'grantrollback_owner');
  const payload = { ownerAccountId: owner.accountId, cardIds: ['test-jalapeno'], grantId: crypto.randomUUID() };
  const originalInsert = store.cardInstances.insertMany;
  store.cardInstances.insertMany = async function (cards, options) {
    assert.ok(options?.session);
    throw new Error('Injected issuance failure after receipt write');
  };
  t.after(() => { store.cardInstances.insertMany = originalInsert; });
  await assert.rejects(grantCards(store, payload), /Injected issuance failure/);
  assert.equal(await store.cardInstances.countDocuments(), 0);
  assert.equal(await store.cardGrants.countDocuments(), 0);
  store.cardInstances.insertMany = originalInsert;
  await store.client.withSession(async session => {
    await assert.rejects(grantCards(store, payload, { session }), error => error.status === 400);
  });
  assert.equal(await store.cardInstances.countDocuments(), 0);
  assert.equal(await store.cardGrants.countDocuments(), 0);
  await assert.rejects(store.client.withSession(session => session.withTransaction(async () => {
    await grantCards(store, payload, { session });
    throw new Error('Abort enclosing pack reward transaction');
  })), /Abort enclosing pack reward transaction/);
  assert.equal(await store.cardInstances.countDocuments(), 0);
  assert.equal(await store.cardGrants.countDocuments(), 0);
  const retried = await grantCards(store, payload);
  assert.equal(retried.cardInstanceIds.length, 1);
  assert.equal(await store.cardInstances.countDocuments(), 1);
  assert.equal(await store.cardGrants.countDocuments(), 1);
});

