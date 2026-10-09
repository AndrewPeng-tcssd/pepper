const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MongoMemoryReplSet, MongoMemoryServer } = require('mongodb-memory-server');
const { ObjectId } = require('mongodb');
const { createApp, connectMongo } = require('../server');

let mongo;
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });

function serve(t, store, options = {}) {
  const server = createApp(store, { mailer: null, verifyTurnstile: async () => true, ...options }).listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route, body, cookie, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + route, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0], retryAfter: response.headers.get('retry-after') };
  };
}

async function fixture(t, options = {}) {
  const store = await connectMongo({ uri: mongo.getUri(), dbName: `session_${crypto.randomBytes(5).toString('hex')}` });
  t.after(() => store.client.close());
  return { store, api: serve(t, store, options) };
}

async function player(api, store, username, balance = 0) {
  const response = await api('/api/register', { username, password: 'trading-password' });
  assert.equal(response.status, 201);
  const saved = await store.users.findOne({ accountId: response.data.user.accountId });
  await store.users.updateOne({ _id: saved._id }, { $set: { balance } });
  return { ...response.data.user, id: saved._id, cookie: response.cookie };
}

function terms(recipient, offeredTokens = 0, extra = {}) {
  return { recipientAccountId: recipient.accountId, offeredTokens, clientOfferId: crypto.randomUUID(), ...extra };
}

async function create(api, sender, recipient) {
  const response = await api('/api/trades', terms(recipient), sender.cookie);
  assert.equal(response.status, 201);
  return response.data.trade;
}

async function join(api, recipient, trade) {
  const response = await api(`/api/trades/${trade.id}/join`, {}, recipient.cookie);
  assert.equal(response.status, 200);
  return response.data.trade;
}

async function contribute(api, actor, trade, tokens) {
  const response = await api(`/api/trades/${trade.id}/contribution`, { tokens, cardIds: [], version: trade.version }, actor.cookie);
  assert.equal(response.status, 200);
  return response.data.trade;
}

async function start(api, sender, recipient, tokens = 0) {
  let trade = await join(api, recipient, await create(api, sender, recipient));
  if (tokens) trade = await contribute(api, sender, trade, tokens);
  return trade;
}

async function confirm(api, actor, trade) {
  const response = await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, actor.cookie);
  assert.equal(response.status, 200);
  return response.data.trade;
}

async function balances(store, ...players) {
  return Promise.all(players.map(async account => (await store.users.findOne({ _id: account.id })).balance));
}

test('private chat rate limits report the wait and safely accept queued messages after it expires', async t => {
  let now = Date.now();
  const { api, store } = await fixture(t, { now: () => now });
  const sender = await player(api, store, 'limit_sender');
  const recipient = await player(api, store, 'limit_recipient');
  const trade = await start(api, sender, recipient);
  const route = `/api/trades/${trade.id}/messages`;
  const first = { body: 'First message.', clientMessageId: crypto.randomUUID() };
  const saved = await api(route, first, sender.cookie);
  assert.equal(saved.status, 201);
  for (let index = 1; index < 60; index += 1) {
    assert.deepEqual((await api(route, first, sender.cookie)).data, saved.data);
  }
  const queued = { body: 'Queued message.', clientMessageId: crypto.randomUUID() };
  now += 1250;
  const limited = await api(route, queued, sender.cookie);
  assert.equal(limited.status, 429);
  assert.equal(limited.data.retryAfterMs, 58750);
  assert.equal(limited.retryAfter, '59');
  assert.equal(await store.tradeMessages.countDocuments(), 1);
  now += limited.data.retryAfterMs;
  const resumed = await api(route, queued, sender.cookie);
  assert.equal(resumed.status, 201);
  assert.equal(resumed.data.message.clientMessageId, queued.clientMessageId);
  assert.deepEqual((await api(route, queued, sender.cookie)).data, resumed.data);
  assert.equal(await store.tradeMessages.countDocuments(), 2);
});

test('a request joins into a session where each player chooses their own tokens and both must confirm', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'session_sender', 100);
  const recipient = await player(api, store, 'session_recipient', 80);
  let trade = await create(api, sender, recipient);
  assert.equal(trade.status, 'pending');
  assert.equal(trade.requestAccepted, false);
  assert.equal(trade.version, 1);
  assert.equal(trade.offeredTokens, 0);
  assert.equal(trade.requestedTokens, 0);
  assert.equal(trade.senderConfirmed, false);
  assert.equal(trade.recipientConfirmed, false);
  assert.deepEqual(trade.offeredCards, []);
  assert.deepEqual(trade.requestedCards, []);
  assert.deepEqual(await balances(store, sender, recipient), [100, 80]);
  trade = await join(api, recipient, trade);
  assert.equal(trade.status, 'negotiating');
  assert.equal(trade.requestAccepted, true);
  assert.equal(trade.version, 2);
  trade = await contribute(api, sender, trade, 30);
  assert.equal(trade.version, 3);
  trade = await contribute(api, recipient, trade, 12);
  assert.equal(trade.version, 4);
  assert.equal(trade.offeredTokens, 30);
  assert.equal(trade.requestedTokens, 12);
  trade = await confirm(api, sender, trade);
  assert.equal(trade.status, 'negotiating');
  assert.equal(trade.senderConfirmed, true);
  assert.equal(trade.recipientConfirmed, false);
  assert.deepEqual(await balances(store, sender, recipient), [100, 80]);
  trade = await confirm(api, recipient, trade);
  assert.equal(trade.status, 'accepted');
  assert.equal(trade.senderConfirmed, true);
  assert.equal(trade.recipientConfirmed, true);
  assert.deepEqual(await balances(store, sender, recipient), [82, 98]);
  assert.equal((await confirm(api, recipient, trade)).status, 'accepted');
  assert.equal((await confirm(api, sender, trade)).status, 'accepted');
  assert.deepEqual(await balances(store, sender, recipient), [82, 98]);
});

test('sessions and chat are private, joining and declining belong to the recipient, and players cannot edit another side', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'private_sender', 20);
  const recipient = await player(api, store, 'private_recipient', 20);
  const outsider = await player(api, store, 'private_outsider', 20);
  assert.equal((await api('/api/trades')).status, 401);
  assert.equal((await api('/api/trades', terms(recipient))).status, 401);
  let trade = await create(api, sender, recipient);
  assert.deepEqual((await api('/api/trades', undefined, outsider.cookie)).data.trades, []);
  for (const route of ['', '/messages']) {
    assert.equal((await api(`/api/trades/${trade.id}${route}`)).status, 401);
    assert.equal((await api(`/api/trades/${trade.id}${route}`, undefined, outsider.cookie)).status, 404);
  }
  for (const action of ['join', 'decline', 'cancel', 'confirm', 'contribution', 'messages']) {
    const body = { tokens: 1, cardIds: [], version: trade.version, body: 'Secret', clientMessageId: crypto.randomUUID() };
    assert.equal((await api(`/api/trades/${trade.id}/${action}`, body)).status, 401);
    assert.equal((await api(`/api/trades/${trade.id}/${action}`, body, outsider.cookie)).status, 404);
  }
  assert.equal((await api(`/api/trades/${trade.id}/join`, {}, sender.cookie)).status, 403);
  assert.equal((await api(`/api/trades/${trade.id}/decline`, {}, sender.cookie)).status, 403);
  assert.equal((await api(`/api/trades/${trade.id}/contribution`, { tokens: 5, cardIds: [], version: trade.version }, recipient.cookie)).status, 403);
  assert.equal((await api(`/api/trades/${trade.id}/contribution`, { tokens: 5, cardIds: [], version: trade.version }, sender.cookie)).status, 403);
  trade = await join(api, recipient, trade);
  trade = await contribute(api, recipient, trade, 5);
  const edited = await api(`/api/trades/${trade.id}/contribution`, {
    tokens: 3, cardIds: [], version: trade.version, side: 'recipient', requestedTokens: 999, recipientAccountId: outsider.accountId
  }, sender.cookie);
  assert.equal(edited.status, 200);
  assert.equal(edited.data.trade.offeredTokens, 3);
  assert.equal(edited.data.trade.requestedTokens, 5);
  assert.equal(edited.data.trade.recipient.accountId, recipient.accountId);
  assert.deepEqual(await balances(store, sender, recipient, outsider), [20, 20, 20]);
});

test('requests contain no assets and contributions stay unavailable until the recipient accepts the request', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'empty_sender');
  const recipient = await player(api, store, 'empty_recipient');
  const body = { recipientAccountId: recipient.accountId, clientOfferId: crypto.randomUUID() };
  const request = await api('/api/trades', body, sender.cookie);
  assert.equal(request.status, 201);
  assert.equal(request.data.trade.offeredTokens, 0);
  assert.deepEqual(request.data.trade.offeredCards, []);
  for (const change of [{ offeredTokens: 1 }, { offeredCardIds: [new ObjectId().toString()] }]) {
    assert.equal((await api('/api/trades', { ...terms(recipient), ...change }, sender.cookie)).status, 400);
  }
  const trade = await join(api, recipient, request.data.trade);
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, sender.cookie)).status, 400);
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 400);
  for (const change of [{ requestedTokens: 1 }, { requestedTokens: 0 }, { requestedCardIds: [] }, { requestedCardIds: [new ObjectId().toString()] }]) {
    assert.equal((await api('/api/trades', { ...terms(recipient), ...change }, sender.cookie)).status, 400);
  }
  assert.deepEqual(await balances(store, sender, recipient), [0, 0]);
});

test('changing contributions resets both confirmations, unchanged edits preserve version, and stale edits are rejected', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'version_sender', 30);
  const recipient = await player(api, store, 'version_recipient', 30);
  let trade = await start(api, sender, recipient, 10);
  trade = await confirm(api, sender, trade);
  const oldVersion = trade.version;
  const unchanged = await contribute(api, sender, trade, 10);
  assert.equal(unchanged.version, oldVersion);
  assert.equal(unchanged.senderConfirmed, true);
  trade = await contribute(api, recipient, trade, 4);
  assert.equal(trade.version, oldVersion + 1);
  assert.equal(trade.senderConfirmed, false);
  assert.equal(trade.recipientConfirmed, false);
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: oldVersion }, sender.cookie)).status, 409);
  assert.equal((await api(`/api/trades/${trade.id}/contribution`, { tokens: 29, cardIds: [], version: oldVersion }, sender.cookie)).status, 409);
  trade = await confirm(api, recipient, trade);
  trade = await contribute(api, sender, trade, 11);
  assert.equal(trade.recipientConfirmed, false);
  assert.equal(trade.senderConfirmed, false);
  assert.deepEqual(await balances(store, sender, recipient), [30, 30]);
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: oldVersion }, recipient.cookie)).status, 409);
});

test('simultaneous contribution edits with one version accept one change and preserve the other side', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'editrace_sender', 30);
  const recipient = await player(api, store, 'editrace_recipient', 30);
  const trade = await start(api, sender, recipient, 10);
  const results = await Promise.all([
    api(`/api/trades/${trade.id}/contribution`, { tokens: 11, cardIds: [], version: trade.version }, sender.cookie),
    api(`/api/trades/${trade.id}/contribution`, { tokens: 4, cardIds: [], version: trade.version }, recipient.cookie)
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const saved = (await api(`/api/trades/${trade.id}`, undefined, sender.cookie)).data.trade;
  assert.equal(saved.version, trade.version + 1);
  assert.ok((saved.offeredTokens === 11 && saved.requestedTokens === 0) || (saved.offeredTokens === 10 && saved.requestedTokens === 4));
});

test('request retry IDs identify the original request even after its contribution has changed', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'requestretry_sender', 30);
  const recipient = await player(api, store, 'requestretry_recipient');
  const payload = terms(recipient);
  const copies = await Promise.all(Array.from({ length: 5 }, () => api('/api/trades', payload, sender.cookie)));
  assert.deepEqual(copies.map(result => result.status), [201, 201, 201, 201, 201]);
  assert.equal(new Set(copies.map(result => result.data.trade.id)).size, 1);
  let trade = await join(api, recipient, copies[0].data.trade);
  trade = await contribute(api, sender, trade, 20);
  assert.equal(trade.version, 3);
  const replay = await api('/api/trades', payload, sender.cookie);
  assert.equal(replay.status, 201);
  assert.equal(replay.data.trade.id, trade.id);
  assert.equal(replay.data.trade.offeredTokens, 20);
  assert.equal((await api('/api/trades', { ...payload, offeredTokens: 20 }, sender.cookie)).status, 400);
  assert.equal((await api('/api/trades', { ...payload, recipientAccountId: sender.accountId }, sender.cookie)).status, 409);
  assert.equal(await store.trades.countDocuments(), 1);
});

test('concurrent confirmations settle only once and competing sessions cannot overspend', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'confirmrace_sender', 100);
  const recipient = await player(api, store, 'confirmrace_recipient');
  const trade = await start(api, sender, recipient, 10);
  const confirmations = await Promise.all([
    ...Array.from({ length: 3 }, () => api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, sender.cookie)),
    ...Array.from({ length: 3 }, () => api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie))
  ]);
  assert.deepEqual(confirmations.map(result => result.status), [200, 200, 200, 200, 200, 200]);
  assert.deepEqual(await balances(store, sender, recipient), [90, 10]);
  const sessions = [await start(api, sender, recipient, 60), await start(api, sender, recipient, 60)];
  for (const item of sessions) await confirm(api, sender, item);
  const competing = await Promise.all(sessions.map(item => api(`/api/trades/${item.id}/confirm`, { version: item.version }, recipient.cookie)));
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  assert.deepEqual(await balances(store, sender, recipient), [30, 70]);
  assert.deepEqual((await api('/api/trades', undefined, sender.cookie)).data.trades.map(item => item.status).sort(), ['accepted', 'accepted', 'negotiating']);
});

test('an edit racing the final confirmation cannot settle contributions that the other player has not confirmed', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'editconfirm_sender', 30);
  const recipient = await player(api, store, 'editconfirm_recipient', 30);
  let trade = await start(api, sender, recipient, 10);
  trade = await contribute(api, recipient, trade, 4);
  await confirm(api, sender, trade);
  const results = await Promise.all([
    api(`/api/trades/${trade.id}/contribution`, { tokens: 20, cardIds: [], version: trade.version }, sender.cookie),
    api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const saved = (await api(`/api/trades/${trade.id}`, undefined, sender.cookie)).data.trade;
  if (saved.status === 'accepted') {
    assert.equal(saved.version, trade.version);
    assert.equal(saved.offeredTokens, 10);
    assert.equal(saved.requestedTokens, 4);
    assert.deepEqual(await balances(store, sender, recipient), [24, 36]);
  } else {
    assert.equal(saved.status, 'negotiating');
    assert.equal(saved.version, trade.version + 1);
    assert.equal(saved.offeredTokens, 20);
    assert.equal(saved.senderConfirmed, false);
    assert.equal(saved.recipientConfirmed, false);
    assert.deepEqual(await balances(store, sender, recipient), [30, 30]);
  }
});

test('final confirmation checks each full contribution and keeps assets unchanged on insufficient funds or overflow', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'funds_sender', 20);
  const recipient = await player(api, store, 'funds_recipient', 20);
  let trade = await start(api, sender, recipient, 15);
  trade = await contribute(api, recipient, trade, 15);
  trade = await confirm(api, sender, trade);
  await store.users.updateOne({ _id: sender.id }, { $set: { balance: 10 } });
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 409);
  assert.deepEqual(await balances(store, sender, recipient), [10, 20]);
  await store.users.updateOne({ _id: sender.id }, { $set: { balance: 20 } });
  await store.users.updateOne({ _id: recipient.id }, { $set: { balance: 10 } });
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 409);
  assert.deepEqual(await balances(store, sender, recipient), [20, 10]);
  trade = await contribute(api, recipient, trade, 0);
  await store.users.updateOne({ _id: recipient.id }, { $set: { balance: Number.MAX_SAFE_INTEGER } });
  await confirm(api, sender, trade);
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 409);
  assert.deepEqual(await balances(store, sender, recipient), [20, Number.MAX_SAFE_INTEGER]);
  assert.equal((await api(`/api/trades/${trade.id}`, undefined, sender.cookie)).data.trade.status, 'negotiating');
});

test('final confirmation rolls back the first balance write and both session confirmations on settlement failure', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'rollback_sender', 40);
  const recipient = await player(api, store, 'rollback_recipient', 20);
  let trade = await start(api, sender, recipient, 15);
  trade = await contribute(api, recipient, trade, 3);
  trade = await confirm(api, sender, trade);
  const original = store.users.updateOne;
  let firstWrite = false;
  store.users.updateOne = async function (filter, update, options) {
    if (options?.session && filter._id.equals(recipient.id)) { assert.equal(firstWrite, true); throw new Error('Injected recipient balance failure'); }
    const result = await original.call(this, filter, update, options);
    if (options?.session && filter._id.equals(sender.id)) firstWrite = true;
    return result;
  };
  t.after(() => { store.users.updateOne = original; });
  t.mock.method(console, 'error', () => {});
  assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 500);
  assert.equal(firstWrite, true);
  assert.deepEqual(await balances(store, sender, recipient), [40, 20]);
  const saved = (await api(`/api/trades/${trade.id}`, undefined, sender.cookie)).data.trade;
  assert.equal(saved.status, 'negotiating');
  assert.equal(saved.senderConfirmed, true);
  assert.equal(saved.recipientConfirmed, false);
  store.users.updateOne = original;
  assert.equal((await confirm(api, recipient, trade)).status, 'accepted');
  assert.deepEqual(await balances(store, sender, recipient), [28, 32]);
});

test('decline and cancellation close sessions without settlement, including cancellation by either joined player', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'close_sender', 20);
  const recipient = await player(api, store, 'close_recipient', 20);
  const declined = await create(api, sender, recipient);
  assert.equal((await api(`/api/trades/${declined.id}/decline`, {}, recipient.cookie)).data.trade.status, 'declined');
  assert.equal((await api(`/api/trades/${declined.id}/decline`, {}, recipient.cookie)).status, 200);
  assert.equal((await api(`/api/trades/${declined.id}/join`, {}, recipient.cookie)).status, 409);
  for (const actor of [sender, recipient]) {
    const trade = await start(api, sender, recipient, 10);
    const cancelled = await api(`/api/trades/${trade.id}/cancel`, {}, actor.cookie);
    assert.equal(cancelled.data.trade.status, 'cancelled');
    assert.equal(cancelled.data.trade.requestAccepted, true);
    assert.equal(cancelled.data.trade.offeredTokens, 10);
    assert.equal((await api(`/api/trades/${trade.id}/cancel`, {}, actor.cookie)).status, 200);
    assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, sender.cookie)).status, 409);
  }
  assert.deepEqual(await balances(store, sender, recipient), [20, 20]);
});

test('cancel and final confirmation racing choose one final state and settle only if confirmation wins', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'cancelrace_sender', 20);
  const recipient = await player(api, store, 'cancelrace_recipient');
  let trade = await start(api, sender, recipient, 10);
  trade = await confirm(api, sender, trade);
  const results = await Promise.all([
    api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie),
    api(`/api/trades/${trade.id}/cancel`, {}, sender.cookie)
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const saved = (await api(`/api/trades/${trade.id}`, undefined, sender.cookie)).data.trade;
  assert.ok(['accepted', 'cancelled'].includes(saved.status));
  assert.deepEqual(await balances(store, sender, recipient), saved.status === 'accepted' ? [10, 10] : [20, 0]);
});

test('private session chat starts after joining, trims text, deduplicates retries, and persists across reconnects', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'chat_sender');
  const recipient = await player(api, store, 'chat_recipient');
  let trade = await create(api, sender, recipient);
  const payload = { body: '  Hello, trading partner!  ', clientMessageId: crypto.randomUUID() };
  assert.equal((await api(`/api/trades/${trade.id}/messages`, payload, sender.cookie)).status, 409);
  assert.equal((await api(`/api/trades/${trade.id}/messages`, undefined, sender.cookie)).status, 409);
  trade = await join(api, recipient, trade);
  const messages = await Promise.all(Array.from({ length: 5 }, () => api(`/api/trades/${trade.id}/messages`, payload, sender.cookie)));
  assert.deepEqual(messages.map(result => result.status), [201, 201, 201, 201, 201]);
  assert.equal(new Set(messages.map(result => result.data.message.id)).size, 1);
  const message = messages[0].data.message;
  assert.equal(message.body, 'Hello, trading partner!');
  assert.deepEqual(message.sender, { username: sender.username, accountId: sender.accountId, avatarUrl: '/favicon.svg', role: 'player', banned: false });
  assert.ok(Date.parse(message.createdAt));
  assert.equal((await api(`/api/trades/${trade.id}/messages`, { ...payload, body: 'Different body' }, sender.cookie)).status, 409);
  const answer = await api(`/api/trades/${trade.id}/messages`, { body: 'Hello back!', clientMessageId: payload.clientMessageId }, recipient.cookie);
  assert.equal(answer.status, 201);
  assert.notEqual(answer.data.message.id, message.id);
  const expected = [message, answer.data.message];
  assert.deepEqual((await api(`/api/trades/${trade.id}/messages`, undefined, recipient.cookie)).data.messages, expected);
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: store.db.databaseName });
  t.after(() => reconnected.client.close());
  const freshApi = serve(t, reconnected);
  assert.deepEqual((await freshApi(`/api/trades/${trade.id}/messages`, undefined, sender.cookie)).data.messages, expected);
  assert.equal((await freshApi(`/api/trades/${trade.id}/cancel`, {}, recipient.cookie)).status, 200);
  const savedRetry = await freshApi(`/api/trades/${trade.id}/messages`, payload, sender.cookie);
  assert.equal(savedRetry.status, 201);
  assert.deepEqual(savedRetry.data.message, message);
  assert.equal((await freshApi(`/api/trades/${trade.id}/messages`, { ...payload, body: 'Changed after closing' }, sender.cookie)).status, 409);
  assert.equal((await api(`/api/trades/${trade.id}/messages`, { body: 'After closing', clientMessageId: crypto.randomUUID() }, sender.cookie)).status, 409);
  assert.deepEqual((await api(`/api/trades/${trade.id}/messages`, undefined, recipient.cookie)).data.messages, expected);
  const secondSession = await join(api, recipient, await create(api, sender, recipient));
  const reusedId = await api(`/api/trades/${secondSession.id}/messages`, payload, sender.cookie);
  assert.equal(reusedId.status, 201);
  assert.notEqual(reusedId.data.message.id, message.id);
});

test('session chat validates bodies and UUIDs and its latest 100 messages are returned chronologically', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'chatvalidate_sender');
  const recipient = await player(api, store, 'chatvalidate_recipient');
  const trade = await join(api, recipient, await create(api, sender, recipient));
  for (const body of ['', '  ', 'a'.repeat(1001), 12, {}, null]) {
    assert.equal((await api(`/api/trades/${trade.id}/messages`, { body, clientMessageId: crypto.randomUUID() }, sender.cookie)).status, 400);
  }
  for (const clientMessageId of ['', 'invalid', null, [], '00000000-0000-1000-8000-000000000000']) {
    assert.equal((await api(`/api/trades/${trade.id}/messages`, { body: 'Hello', clientMessageId }, sender.cookie)).status, 400);
  }
  // Separate server instances avoid using the per-instance abuse limit as a history fixture.
  const apis = [api, ...Array.from({ length: 3 }, () => serve(t, store))];
  const saved = [];
  for (let index = 0; index < 105; index += 1) {
    const sent = await apis[Math.floor(index / 30)](`/api/trades/${trade.id}/messages`, { body: `message ${index}`, clientMessageId: crypto.randomUUID() }, sender.cookie);
    assert.equal(sent.status, 201);
    saved.push(sent.data.message);
  }
  assert.deepEqual((await api(`/api/trades/${trade.id}/messages`, undefined, recipient.cookie)).data.messages, saved.slice(5));
});

test('session IDs, contribution amounts, versions, and permanent recipients are validated without balance changes', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'validate_sender', 100);
  const recipient = await player(api, store, 'validate_recipient');
  for (const change of [
    { offeredTokens: -1 }, { offeredTokens: 1.5 }, { offeredTokens: '1' }, { offeredTokens: null },
    { offeredTokens: Number.MAX_SAFE_INTEGER + 1 }, { offeredCardIds: null },
    { clientOfferId: 'invalid' }, { clientOfferId: null }, { recipientAccountId: '' }, { recipientAccountId: recipient.username }
  ]) assert.equal((await api('/api/trades', { ...terms(recipient), ...change }, sender.cookie)).status, 400);
  assert.equal((await api('/api/trades', terms(sender), sender.cookie)).status, 400);
  assert.equal((await api('/api/trades', terms({ accountId: `PPR-${crypto.randomUUID().toUpperCase()}` }), sender.cookie)).status, 404);
  assert.equal((await api('/api/trades', terms(recipient, 101), sender.cookie)).status, 400);
  const trade = await join(api, recipient, await create(api, sender, recipient));
  for (const tokens of [-1, 1.2, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await api(`/api/trades/${trade.id}/contribution`, { tokens, cardIds: [], version: trade.version }, sender.cookie)).status, 400);
  }
  for (const version of [null, '2', -1, 1.5]) {
    assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version }, sender.cookie)).status, 400);
  }
  for (const id of ['invalid', 'a'.repeat(23), 'z'.repeat(24)]) assert.equal((await api(`/api/trades/${id}`, undefined, sender.cookie)).status, 400);
  assert.equal((await api(`/api/trades/${new ObjectId()}`, undefined, sender.cookie)).status, 404);
  assert.deepEqual(await balances(store, sender, recipient), [100, 0]);
});

test('claims and final confirmations preserve simultaneous rewards on the same accounts', async t => {
  const { api, store } = await fixture(t, { randomInt: () => 10 });
  const sender = await player(api, store, 'claimsession_sender', 50);
  const recipient = await player(api, store, 'claimsession_recipient', 20);
  let trade = await start(api, sender, recipient, 20);
  trade = await contribute(api, recipient, trade, 5);
  await confirm(api, sender, trade);
  const results = await Promise.all([
    api('/api/claim', { turnstileToken: 'valid' }, sender.cookie), api('/api/claim', { turnstileToken: 'valid' }, recipient.cookie),
    api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)
  ]);
  assert.deepEqual(results.map(result => result.status), [200, 200, 200]);
  assert.deepEqual(await balances(store, sender, recipient), [45, 45]);
});

test('session participants and private chat authors follow permanent identities through renamed and reclaimed usernames', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'rename_sender', 20);
  const recipient = await player(api, store, 'rename_recipient');
  const outsider = await player(api, store, 'rename_outsider');
  const trade = await start(api, sender, recipient, 5);
  const message = await api(`/api/trades/${trade.id}/messages`, { body: 'Original author', clientMessageId: crypto.randomUUID() }, recipient.cookie);
  assert.equal(message.status, 201);
  for (const [account, username] of [[sender, 'renamed_sender'], [recipient, 'renamed_recipient'], [outsider, 'rename_recipient']]) {
    assert.equal((await api('/api/account/username', { username, currentPassword: 'trading-password' }, account.cookie, 'PATCH')).status, 200);
  }
  const saved = (await api(`/api/trades/${trade.id}`, undefined, sender.cookie)).data.trade;
  assert.deepEqual(saved.sender, { username: 'renamed_sender', accountId: sender.accountId, avatarUrl: '/favicon.svg', role: 'player', banned: false });
  assert.deepEqual(saved.recipient, { username: 'renamed_recipient', accountId: recipient.accountId, avatarUrl: '/favicon.svg', role: 'player', banned: false });
  assert.equal((await api(`/api/trades/${trade.id}`, undefined, outsider.cookie)).status, 404);
  const current = (await api(`/api/trades/${trade.id}/messages`, undefined, sender.cookie)).data.messages[0];
  assert.deepEqual(current.sender, { username: 'renamed_recipient', accountId: recipient.accountId, avatarUrl: '/favicon.svg', role: 'player', banned: false });
  assert.equal(current.id, message.data.message.id);
});

test('startup upgrades old pending offers without partner terms while preserving completed history and later session edits', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'legacy_sender', 30);
  const recipient = await player(api, store, 'legacy_recipient', 20);
  const legacy = {
    senderUserId: sender.id, senderAccountId: sender.accountId, senderUsername: sender.username,
    recipientUserId: recipient.id, recipientAccountId: recipient.accountId, recipientUsername: recipient.username,
    clientOfferId: crypto.randomUUID(), offeredTokens: 10, requestedTokens: 9,
    offeredCards: [], requestedCards: [{ id: new ObjectId().toString(), cardId: 'legacy-card', name: 'Legacy Card', rarity: 'Rare', setName: 'Legacy', imageUrl: null }],
    status: 'pending', createdAt: new Date(), updatedAt: new Date()
  };
  const pendingId = (await store.trades.insertOne({ ...legacy })).insertedId.toString();
  const completedId = (await store.trades.insertOne({ ...legacy, clientOfferId: crypto.randomUUID(), status: 'accepted' })).insertedId.toString();
  const tokenOnlyLegacy = { ...legacy, clientOfferId: crypto.randomUUID() };
  delete tokenOnlyLegacy.offeredCards;
  delete tokenOnlyLegacy.requestedCards;
  const tokenOnlyId = (await store.trades.insertOne(tokenOnlyLegacy)).insertedId.toString();
  const restarted = await connectMongo({ uri: mongo.getUri(), dbName: store.db.databaseName });
  t.after(() => restarted.client.close());
  const freshApi = serve(t, restarted);
  let pending = (await freshApi(`/api/trades/${pendingId}`, undefined, recipient.cookie)).data.trade;
  assert.equal(pending.status, 'pending');
  assert.equal(pending.version, 1);
  assert.equal(pending.offeredTokens, 0);
  assert.equal(pending.requestedTokens, 0);
  assert.deepEqual(pending.requestedCards, []);
  assert.equal(pending.senderConfirmed, false);
  assert.equal(pending.recipientConfirmed, false);
  const completed = (await freshApi(`/api/trades/${completedId}`, undefined, sender.cookie)).data.trade;
  assert.equal(completed.status, 'accepted');
  assert.equal(completed.requestedTokens, 9);
  assert.deepEqual(completed.requestedCards, legacy.requestedCards);
  pending = await join(freshApi, recipient, pending);
  assert.equal(pending.offeredTokens, 10);
  pending = await contribute(freshApi, recipient, pending, 4);
  const secondRestart = await connectMongo({ uri: mongo.getUri(), dbName: store.db.databaseName });
  t.after(() => secondRestart.client.close());
  const secondApi = serve(t, secondRestart);
  assert.deepEqual((await secondApi(`/api/trades/${pendingId}`, undefined, sender.cookie)).data.trade, pending);
  assert.deepEqual(await balances(store, sender, recipient), [30, 20]);
  let tokenOnly = (await secondApi(`/api/trades/${tokenOnlyId}`, undefined, sender.cookie)).data.trade;
  assert.deepEqual(tokenOnly.offeredCards, []);
  assert.deepEqual(tokenOnly.requestedCards, []);
  tokenOnly = await join(secondApi, recipient, tokenOnly);
  tokenOnly = await contribute(secondApi, recipient, tokenOnly, 3);
  await confirm(secondApi, sender, tokenOnly);
  assert.equal((await confirm(secondApi, recipient, tokenOnly)).status, 'accepted');
  assert.deepEqual(await balances(store, sender, recipient), [23, 27]);
});

test('legacy sender assets stay hidden on request lists, details, and pre-acceptance decline or cancellation', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'hidden_sender', 30);
  const recipient = await player(api, store, 'hidden_recipient', 20);
  const cardId = new ObjectId();
  const snapshot = { id: cardId.toString(), cardId: 'legacy-hidden-card', name: 'Hidden Card', rarity: 'Rare', setName: 'Legacy', imageUrl: null };
  await store.cardDefinitions.insertOne({ _id: snapshot.cardId, name: snapshot.name, rarity: snapshot.rarity, setName: snapshot.setName, imageUrl: null });
  await store.cardInstances.insertOne({ _id: cardId, cardId: snapshot.cardId, ownerUserId: sender.id, ownerAccountId: sender.accountId, tradable: true, createdAt: new Date(), acquiredAt: new Date() });
  const hidden = trade => {
    assert.equal(trade.requestAccepted, false);
    assert.equal(trade.offeredTokens, 0);
    assert.equal(trade.requestedTokens, 0);
    assert.deepEqual(trade.offeredCards, []);
    assert.deepEqual(trade.requestedCards, []);
  };
  for (const action of ['join', 'decline', 'cancel']) {
    const legacy = {
      senderUserId: sender.id, senderAccountId: sender.accountId, senderUsername: sender.username,
      recipientUserId: recipient.id, recipientAccountId: recipient.accountId, recipientUsername: recipient.username,
      clientOfferId: crypto.randomUUID(), offeredTokens: 7, offeredCards: [snapshot], requestedTokens: 9, requestedCards: [],
      status: 'pending', createdAt: new Date(), updatedAt: new Date()
    };
    const id = (await store.trades.insertOne(legacy)).insertedId.toString();
    for (const actor of [sender, recipient]) {
      const detail = await api(`/api/trades/${id}`, undefined, actor.cookie);
      assert.equal(detail.status, 200);
      hidden(detail.data.trade);
      hidden((await api('/api/trades', undefined, actor.cookie)).data.trades.find(trade => trade.id === id));
      assert.equal((await api(`/api/trades/${id}/contribution`, { tokens: 1, cardIds: [], version: detail.data.trade.version }, actor.cookie)).status, 403);
    }
    const stored = await store.trades.findOne({ _id: new ObjectId(id) });
    assert.equal(stored.offeredTokens, 7);
    assert.deepEqual(stored.offeredCards, [snapshot]);
    const result = await api(`/api/trades/${id}/${action}`, {}, recipient.cookie);
    assert.equal(result.status, 200);
    if (action === 'join') {
      assert.equal(result.data.trade.requestAccepted, true);
      assert.equal(result.data.trade.offeredTokens, 7);
      assert.deepEqual(result.data.trade.offeredCards, [snapshot]);
      assert.equal(result.data.trade.requestedTokens, 0);
      assert.deepEqual(result.data.trade.requestedCards, []);
    } else {
      hidden(result.data.trade);
      hidden((await api(`/api/trades/${id}`, undefined, sender.cookie)).data.trade);
      hidden((await api('/api/trades', undefined, recipient.cookie)).data.trades.find(trade => trade.id === id));
    }
  }
  assert.deepEqual(await balances(store, sender, recipient), [30, 20]);
  assert.equal((await store.cardInstances.findOne({ _id: cardId })).ownerAccountId, sender.accountId);
});

test('session lists keep older active sessions reachable beyond the newest 100 completed sessions', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'history_sender');
  const recipient = await player(api, store, 'history_recipient');
  const trade = await create(api, sender, recipient);
  const saved = await store.trades.findOne({ _id: new ObjectId(trade.id) });
  await store.trades.deleteMany({});
  const entries = Array.from({ length: 120 }, (_, index) => ({
    ...saved, _id: new ObjectId(index.toString(16).padStart(24, '0')), clientOfferId: crypto.randomUUID(),
    status: index < 3 ? ['pending', 'negotiating', 'pending'][index] : ['accepted', 'declined', 'cancelled'][index % 3],
    updatedAt: new Date(index < 85 ? index * 1000 : 85000)
  }));
  await store.trades.insertMany(entries);
  const listed = (await api('/api/trades', undefined, sender.cookie)).data.trades;
  assert.equal(listed.length, 103);
  assert.deepEqual(listed.map(item => item.id), [...entries.slice(20).reverse(), ...entries.slice(0, 3).reverse()].map(item => item._id.toString()));
  assert.equal(await store.trades.countDocuments(), 120);
});

test('standalone MongoDB refuses final confirmation and never moves tokens', async t => {
  const standalone = await MongoMemoryServer.create();
  t.after(() => standalone.stop());
  const store = await connectMongo({ uri: standalone.getUri(), dbName: 'session_standalone' });
  t.after(() => store.client.close());
  const api = serve(t, store);
  const sender = await player(api, store, 'standalone_sender', 20);
  const recipient = await player(api, store, 'standalone_recipient');
  const trade = await start(api, sender, recipient, 5);
  const first = await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, sender.cookie);
  assert.ok([200, 503].includes(first.status));
  if (first.status === 200) assert.equal((await api(`/api/trades/${trade.id}/confirm`, { version: trade.version }, recipient.cookie)).status, 503);
  assert.deepEqual(await balances(store, sender, recipient), [20, 0]);
  assert.equal((await api(`/api/trades/${trade.id}`, undefined, sender.cookie)).data.trade.status, 'negotiating');
});
