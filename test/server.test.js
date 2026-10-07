const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ObjectId } = require('mongodb');
const { createApp, connectMongo, CLAIM_INTERVAL_MS, PRESENCE_TIMEOUT_MS } = require('../server');
const { migrate } = require('../scripts/migrate-sqlite');

let mongo;
let store;
let server;
let base;
const sentEmails = [];
const accountIdPattern = /^PPR-[A-F0-9]{8}-[A-F0-9]{4}-4[A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}$/;
before(async () => {
  mongo = await MongoMemoryServer.create();
  store = await connectMongo({ uri: mongo.getUri(), dbName: 'pepper_test' });
  server = createApp(store, {
    emailSendingPaused: false,
    mailer: { sendVerification: async email => { sentEmails.push(email); } },
    publicUrl: 'http://localhost:3000',
    verifyTurnstile: async token => token === 'valid-test-token'
  }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server?.close(resolve));
  await store?.client.close();
  await mongo?.stop();
});

async function request(route, body, cookie, method = body === undefined ? 'GET' : 'POST', baseUrl = base) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

function accountApi(t, accountStore = store, options = {}) {
  const accountServer = createApp(accountStore, { mailer: null, ...options }).listen(0);
  t.after(() => new Promise(resolve => accountServer.close(resolve)));
  const accountBase = `http://127.0.0.1:${accountServer.address().port}`;
  return (route, body, cookie, method) => request(route, body, cookie, method, accountBase);
}

test('eight-character sign-up, MongoDB balance, and hourly claim', async () => {
  const username = `gardener_${crypto.randomBytes(3).toString('hex')}`;
  const short = await request('/api/register', { username, password: '1234567' });
  assert.equal(short.status, 400);
  const emailsBeforeSignup = sentEmails.length;
  const register = await request('/api/register', { username, password: '12345678' });
  assert.equal(register.status, 201);
  assert.ok(register.cookie);
  assert.equal(register.data.user.username, username);
  assert.match(register.data.user.accountId, accountIdPattern);
  assert.equal(register.data.user.email, null);
  assert.equal(sentEmails.length, emailsBeforeSignup);
  const stored = await store.users.findOne({ usernameKey: username.toLowerCase() });
  assert.ok(stored);
  assert.notEqual(stored.passwordHash, '12345678');
  assert.equal(stored.balance, 0);
  assert.equal(stored.accountId, register.data.user.accountId);
  assert.equal(stored.email, undefined);
  assert.equal((await request('/api/turnstile-config')).data.siteKey, '1x00000000000000000000AA');
  assert.equal((await request('/api/claim', { turnstileToken: 'valid-test-token' })).status, 401);
  assert.ok(Date.parse(register.data.user.createdAt));
  assert.equal(register.data.user.passwordHash, undefined);
  const cookie = register.cookie;

  const duplicate = await request('/api/register', { username: username.toUpperCase(), password: '12345678' });
  assert.equal(duplicate.status, 409);

  assert.equal((await request('/api/claim', {}, cookie)).status, 400);
  assert.equal((await request('/api/claim', { turnstileToken: 'invalid-token' }, cookie)).status, 400);
  const claim = await request('/api/claim', { turnstileToken: 'valid-test-token' }, cookie);
  assert.equal(claim.status, 200);
  assert.ok(Number.isInteger(claim.data.awarded));
  assert.ok(claim.data.awarded >= 10 && claim.data.awarded <= 20);
  assert.equal(claim.data.user.hourlyTokenMin, 10);
  assert.equal(claim.data.user.hourlyTokenMax, 20);
  assert.equal(claim.data.user.balance, claim.data.awarded);
  assert.ok(claim.data.user.nextClaimAt > Date.now());
  assert.equal((await store.users.findOne({ _id: stored._id })).balance, claim.data.awarded);

  const again = await request('/api/claim', { turnstileToken: 'valid-test-token' }, cookie);
  assert.equal(again.status, 429);
  assert.equal((await request('/api/me', undefined, cookie)).data.user.balance, claim.data.awarded);

  assert.equal((await request('/api/logout', {}, cookie)).status, 200);
  assert.equal((await request('/api/me', undefined, cookie)).data.user, null);
  const login = await request('/api/login', { identifier: username.toUpperCase(), password: '12345678' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.balance, claim.data.awarded);
  assert.equal(login.data.user.accountId, register.data.user.accountId);

  await store.users.updateOne({ _id: stored._id }, { $set: { email: `${username}@example.test`, emailVerifiedAt: new Date() } });
  const beforeEmailLogin = sentEmails.length;
  assert.equal((await request('/api/login', { identifier: `${username}@example.test`, password: 'wrongpass' })).status, 401);
  assert.equal(sentEmails.length, beforeEmailLogin);
  const emailLogin = await request('/api/login', { identifier: `${username}@example.test`, password: '12345678' });
  assert.equal(emailLogin.status, 200);
  assert.equal(emailLogin.data.pending, true);
  assert.equal(emailLogin.cookie, undefined);
  const loginToken = new URL(sentEmails.at(-1).url).searchParams.get('token');
  assert.equal(sentEmails.at(-1).purpose, 'login');
  assert.equal((await request('/api/verify-email', { purpose: 'signup', token: loginToken })).status, 400);
  const emailVerified = await request('/api/verify-email', { purpose: 'login', token: loginToken });
  assert.equal(emailVerified.status, 200);
  assert.equal(emailVerified.data.user.balance, claim.data.awarded);
  assert.ok(emailVerified.cookie);
  assert.equal((await request('/api/verify-email', { purpose: 'login', token: loginToken })).status, 400);
});

test('hourly rewards include both 10 and 20 and add to the stored balance', async t => {
  const rewards = [10, 20];
  const ranges = [];
  const api = accountApi(t, store, {
    verifyTurnstile: async token => token === 'valid-test-token',
    randomInt: (minimum, maximumExclusive) => {
      ranges.push([minimum, maximumExclusive]);
      return rewards.shift();
    }
  });
  const username = `reward_${crypto.randomBytes(3).toString('hex')}`;
  const register = await api('/api/register', { username, password: '12345678' });
  assert.equal(register.status, 201);
  const cookie = register.cookie;
  await store.users.updateOne({ usernameKey: username.toLowerCase() }, { $set: { balance: 37 } });

  assert.equal((await api('/api/claim', { turnstileToken: 'invalid-token' }, cookie)).status, 400);
  assert.equal(ranges.length, 0);
  const minimum = await api('/api/claim', { turnstileToken: 'valid-test-token' }, cookie);
  assert.equal(minimum.status, 200);
  assert.equal(minimum.data.awarded, 10);
  assert.equal(minimum.data.user.balance, 47);
  assert.equal((await api('/api/claim', { turnstileToken: 'valid-test-token' }, cookie)).status, 429);
  assert.equal(ranges.length, 1);

  await store.users.updateOne({ usernameKey: username.toLowerCase() }, {
    $set: { lastClaimAt: Date.now() - CLAIM_INTERVAL_MS }
  });
  const maximum = await api('/api/claim', { turnstileToken: 'valid-test-token' }, cookie);
  assert.equal(maximum.status, 200);
  assert.equal(maximum.data.awarded, 20);
  assert.equal(maximum.data.user.balance, 67);
  assert.deepEqual(ranges, [[10, 21], [10, 21]]);
  const stored = await store.users.findOne({ usernameKey: username.toLowerCase() });
  assert.equal(stored.balance, 67);
  assert.equal(stored.lastClaimAt, maximum.data.user.lastClaimAt);
});

test('simultaneous random claims award exactly one reward', { timeout: 10000 }, async t => {
  let verificationCalls = 0;
  let releaseVerification;
  const bothVerifying = new Promise(resolve => { releaseVerification = resolve; });
  const api = accountApi(t, store, {
    verifyTurnstile: async () => {
      verificationCalls += 1;
      if (verificationCalls === 2) releaseVerification();
      await bothVerifying;
      return true;
    }
  });
  const username = `claimrace_${crypto.randomBytes(3).toString('hex')}`;
  const register = await api('/api/register', { username, password: '12345678' });
  assert.equal(register.status, 201);
  const claims = await Promise.all([
    api('/api/claim', { turnstileToken: 'first-token' }, register.cookie),
    api('/api/claim', { turnstileToken: 'second-token' }, register.cookie)
  ]);
  assert.equal(verificationCalls, 2);
  assert.deepEqual(claims.map(claim => claim.status).sort(), [200, 429]);
  const winner = claims.find(claim => claim.status === 200);
  assert.ok(Number.isInteger(winner.data.awarded));
  assert.ok(winner.data.awarded >= 10 && winner.data.awarded <= 20);
  const stored = await store.users.findOne({ usernameKey: username.toLowerCase() });
  assert.equal(stored.balance, winner.data.awarded);
  assert.equal(stored.lastClaimAt, winner.data.user.lastClaimAt);
  assert.equal((await api('/api/me', undefined, register.cookie)).data.user.balance, winner.data.awarded);
});

test('sign-up does not depend on email delivery or save a supplied email', async () => {
  const failedServer = createApp(store, {
    emailSendingPaused: false,
    mailer: { sendVerification: async () => { throw Object.assign(new Error('SMTP failed'), { code: 'EAUTH' }); } }
  }).listen(0);
  const username = `noemail_${crypto.randomBytes(3).toString('hex')}`;
  try {
    const response = await fetch(`http://127.0.0.1:${failedServer.address().port}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email: `${username}@example.test`, password: '12345678' })
    });
    assert.equal(response.status, 201);
    assert.ok(response.headers.get('set-cookie'));
    assert.equal((await response.json()).user.email, null);
    assert.equal((await store.users.findOne({ usernameKey: username })).email, undefined);
  } finally {
    await new Promise(resolve => failedServer.close(resolve));
  }
});

test('paused email sending still allows sign-up and username login', async () => {
  let attempts = 0;
  const pausedServer = createApp(store, {
    emailSendingPaused: true,
    mailer: { sendVerification: async () => { attempts += 1; } }
  }).listen(0);
  const username = `paused_${crypto.randomBytes(3).toString('hex')}`;
  try {
    const response = await fetch(`http://127.0.0.1:${pausedServer.address().port}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: '12345678' })
    });
    assert.equal(response.status, 201);
    assert.equal(attempts, 0);
    const user = await store.users.findOne({ usernameKey: username });
    assert.ok(user);
    await store.users.updateOne({ _id: user._id }, { $set: { email: `${username}@example.test`, emailVerifiedAt: null } });
    const usernameLogin = await fetch(`http://127.0.0.1:${pausedServer.address().port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: username, password: '12345678' })
    });
    assert.equal(usernameLogin.status, 200);
    const emailLogin = await fetch(`http://127.0.0.1:${pausedServer.address().port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: `${username}@example.test`, password: '12345678' })
    });
    assert.equal(emailLogin.status, 503);
    assert.match((await emailLogin.json()).error, /temporarily paused/);
  } finally {
    await new Promise(resolve => pausedServer.close(resolve));
  }
});

test('existing email index is updated for accounts without email', async () => {
  const dbName = `legacy_index_${crypto.randomBytes(3).toString('hex')}`;
  const oldUsers = store.client.db(dbName).collection('users');
  await oldUsers.createIndex({ email: 1 }, { unique: true });
  await oldUsers.insertOne({ usernameKey: 'existing', email: 'existing@example.test' });
  const migrated = await connectMongo({ uri: mongo.getUri(), dbName });
  try {
    const emailIndex = (await migrated.users.indexes()).find(index => index.name === 'email_1');
    assert.deepEqual(emailIndex.partialFilterExpression, { email: { $type: 'string' } });
    await migrated.users.insertMany([{ usernameKey: 'first' }, { usernameKey: 'second' }]);
    assert.equal(await migrated.users.countDocuments(), 3);
  } finally { await migrated.client.close(); }
});

test('existing SQLite account migrates once with its balance and claim time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepper-migrate-test-'));
  const oldPath = path.join(dir, 'old.sqlite');
  const oldDb = new Database(oldPath);
  try {
    oldDb.exec('CREATE TABLE users (username TEXT, email TEXT, password_hash TEXT, balance INTEGER, last_claim_at INTEGER, created_at INTEGER)');
    oldDb.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
      .run('OldGardener', 'old@example.test', 'salt:hash', 25, 1700000000000, 1690000000000);
    oldDb.close();
    assert.deepEqual(await migrate(oldPath, store), { added: 1, skipped: 0 });
    assert.deepEqual(await migrate(oldPath, store), { added: 0, skipped: 1 });
    const user = await store.users.findOne({ usernameKey: 'oldgardener' });
    assert.equal(user.balance, 25);
    assert.equal(user.lastClaimAt, 1700000000000);
    assert.equal(user.passwordHash, 'salt:hash');
  } finally {
    if (oldDb.open) oldDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('public chat can be read, and only signed-in users can post', async () => {
  const username = `chatter_${crypto.randomBytes(3).toString('hex')}`;
  const signedUp = await request('/api/register', { username, password: '12345678' });
  assert.equal(signedUp.status, 201);
  assert.equal((await request('/api/chat', { text: 'hello' })).status, 401);
  const post = await request('/api/chat', { text: 'Hello, Pepper TCG!' }, signedUp.cookie);
  assert.equal(post.status, 201);
  assert.equal(post.data.message.username, username);
  assert.equal(post.data.message.text, 'Hello, Pepper TCG!');
  assert.equal(post.data.message.replyTo, null);
  assert.equal(post.data.message.clientMessageId, null);
  const messages = await request('/api/chat');
  assert.equal(messages.status, 200);
  assert.deepEqual(messages.data.messages.find(item => item.id === post.data.message.id), post.data.message);
  assert.equal((await request('/api/chat', { text: 'Too soon' }, signedUp.cookie)).status, 429);
});

test('chat reply targets require valid IDs and saved parent messages', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const writer = await api('/api/register', { username: 'reply_validation', password: '12345678' });
  assert.equal(writer.status, 201);
  assert.equal((await api('/api/chat', { text: 'A reply', replyToId: new ObjectId().toString() })).status, 401);
  for (const replyToId of ['', 'invalid', 'a'.repeat(23), 'a'.repeat(25), 'z'.repeat(24), 12, false, {}, []]) {
    assert.equal((await api('/api/chat', { text: 'Invalid reply', replyToId }, writer.cookie)).status, 400);
  }
  assert.equal((await api('/api/chat', { text: 'Missing reply', replyToId: new ObjectId().toString() }, writer.cookie)).status, 404);
  assert.equal(await isolated.messages.countDocuments(), 0);
  const noReply = await api('/api/chat', { text: 'A regular message', replyToId: null, replyTo: { text: 'Fake quote' } }, writer.cookie);
  assert.equal(noReply.status, 201);
  assert.equal(noReply.data.message.replyTo, null);
  assert.deepEqual((await api('/api/chat')).data.messages, [noReply.data.message]);
});

test('chat replies use authoritative shallow quotes and follow the parent account through renames and restarts', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const password = '12345678';
  const author = await api('/api/register', { username: 'quote_author', password });
  const writer = await api('/api/register', { username: 'quote_writer', password });
  const third = await api('/api/register', { username: 'quote_third', password });
  const parent = await api('/api/chat', { text: 'Original parent message.' }, author.cookie);
  assert.equal(parent.status, 201);
  const quote = { id: parent.data.message.id, username: 'quote_author', text: 'Original parent message.', available: true };
  const reply = await api('/api/chat', {
    text: 'My reply.', replyToId: parent.data.message.id.toUpperCase(),
    replyTo: { id: new ObjectId().toString(), username: '675', text: 'Forged quote.', available: false },
    replyToUsername: '675', replyToText: 'Another forged quote.'
  }, writer.cookie);
  assert.equal(reply.status, 201);
  assert.deepEqual(reply.data.message.replyTo, quote);
  assert.deepEqual(Object.keys(reply.data.message).sort(), ['clientMessageId', 'createdAt', 'id', 'replyTo', 'text', 'username']);
  const nested = await api('/api/chat', { text: 'Replying to that reply.', replyToId: reply.data.message.id }, third.cookie);
  assert.equal(nested.status, 201);
  assert.deepEqual(nested.data.message.replyTo, { id: reply.data.message.id, username: 'quote_writer', text: 'My reply.', available: true });
  assert.deepEqual(Object.keys(nested.data.message.replyTo).sort(), ['available', 'id', 'text', 'username']);
  const initial = (await api('/api/chat')).data.messages;
  assert.equal(initial.find(message => message.id === parent.data.message.id).replyTo, null);
  assert.deepEqual(initial.find(message => message.id === reply.data.message.id).replyTo, quote);
  const renamed = await api('/api/account/username', { username: 'renamed_quote_author', currentPassword: password }, author.cookie, 'PATCH');
  assert.equal(renamed.status, 200);
  const currentQuote = { ...quote, username: 'renamed_quote_author' };
  assert.deepEqual((await api('/api/chat')).data.messages.find(message => message.id === reply.data.message.id).replyTo, currentQuote);
  const reclaimedName = await api('/api/register', { username: 'quote_author', password });
  assert.equal(reclaimedName.status, 201);
  assert.notEqual(reclaimedName.data.user.accountId, author.data.user.accountId);

  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const persisted = (await accountApi(t, reconnected)('/api/chat')).data.messages;
  assert.equal(persisted.length, 3);
  assert.deepEqual(persisted.find(message => message.id === reply.data.message.id).replyTo, currentQuote);
  assert.deepEqual(persisted.find(message => message.id === nested.data.message.id).replyTo, nested.data.message.replyTo);
});

test('chat reply quotes survive parent pruning while new replies cannot target removed history', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const password = '12345678';
  const author = await api('/api/register', { username: 'pruned_author', password });
  const writer = await api('/api/register', { username: 'pruned_writer', password });
  const third = await api('/api/register', { username: 'pruned_third', password });
  const parent = await api('/api/chat', { text: 'Remember this parent.' }, author.cookie);
  assert.equal(parent.status, 201);
  await isolated.messages.updateOne({ _id: new ObjectId(parent.data.message.id) }, { $set: { createdAt: new Date(Date.now() - 120000) } });
  const reply = await api('/api/chat', { text: 'A saved reply.', replyToId: parent.data.message.id }, writer.cookie);
  assert.equal(reply.status, 201);
  await isolated.messages.insertMany(Array.from({ length: 99 }, (_, index) => ({
    userId: new ObjectId(), username: 'older_history', text: `Older message ${index}`, createdAt: new Date(Date.now() - 60000)
  })));
  const newest = await api('/api/chat', { text: 'A fresh message.' }, third.cookie);
  assert.equal(newest.status, 201);
  assert.equal(await isolated.messages.countDocuments(), 100);
  assert.equal(await isolated.messages.findOne({ _id: new ObjectId(parent.data.message.id) }), null);
  const quote = { id: parent.data.message.id, username: 'pruned_author', text: 'Remember this parent.', available: false };
  const latest = (await api('/api/chat')).data.messages;
  assert.equal(latest.length, 100);
  assert.deepEqual(latest.find(message => message.id === reply.data.message.id).replyTo, quote);
  assert.equal((await api('/api/chat', { text: 'Reply to removed parent.', replyToId: parent.data.message.id }, author.cookie)).status, 404);
  assert.equal(await isolated.messages.countDocuments(), 100);
  const renamed = await api('/api/account/username', { username: 'renamed_pruned_author', currentPassword: password }, author.cookie, 'PATCH');
  assert.equal(renamed.status, 200);
  const currentQuote = { ...quote, username: 'renamed_pruned_author' };
  assert.deepEqual((await api('/api/chat')).data.messages.find(message => message.id === reply.data.message.id).replyTo, currentQuote);
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const persisted = (await accountApi(t, reconnected)('/api/chat')).data.messages;
  assert.equal(persisted.length, 100);
  assert.deepEqual(persisted.find(message => message.id === reply.data.message.id).replyTo, currentQuote);
});

test('chat validates optional client message IDs and keeps ordinary messages compatible', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const writer = await api('/api/register', { username: 'id_validation', password: '12345678' });
  assert.equal(writer.status, 201);
  const validId = crypto.randomUUID();
  assert.equal((await api('/api/chat', { text: 'A message', clientMessageId: validId })).status, 401);
  for (const clientMessageId of ['', 'not-a-uuid', crypto.randomBytes(16).toString('hex'), 'x'.repeat(36), 12, false, {}, [], `${validId.slice(0, 14)}3${validId.slice(15)}`]) {
    assert.equal((await api('/api/chat', { text: 'Invalid ID', clientMessageId }, writer.cookie)).status, 400);
  }
  assert.equal(await isolated.messages.countDocuments(), 0);
  const ordinary = await api('/api/chat', { text: 'An ordinary message', clientMessageId: null }, writer.cookie);
  assert.equal(ordinary.status, 201);
  assert.equal(ordinary.data.message.clientMessageId, null);
  assert.equal((await isolated.messages.findOne({ _id: new ObjectId(ordinary.data.message.id) })).clientMessageId, undefined);
  assert.deepEqual((await api('/api/chat')).data.messages, [ordinary.data.message]);
});

test('chat retries return the original saved message before cooldown or payload validation and IDs are scoped to each account', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const writer = await api('/api/register', { username: 'retry_writer', password: '12345678' });
  const other = await api('/api/register', { username: 'retry_other', password: '12345678' });
  const clientMessageId = crypto.randomUUID();
  const first = await api('/api/chat', { text: 'Save this once.', clientMessageId: clientMessageId.toUpperCase() }, writer.cookie);
  assert.equal(first.status, 201);
  assert.equal(first.data.message.clientMessageId, clientMessageId);
  const retry = await api('/api/chat', { text: 'A changed retry payload.', clientMessageId, replyToId: 'invalid' }, writer.cookie);
  assert.equal(retry.status, 201);
  assert.deepEqual(retry.data, first.data);
  const emptyRetry = await api('/api/chat', { text: '', clientMessageId }, writer.cookie);
  assert.equal(emptyRetry.status, 201);
  assert.deepEqual(emptyRetry.data, first.data);
  assert.equal(await isolated.messages.countDocuments(), 1);
  assert.deepEqual((await api('/api/chat')).data.messages, [first.data.message]);
  const otherMessage = await api('/api/chat', { text: 'Another account owns its own message.', clientMessageId, username: 'retry_writer', userId: writer.data.user.accountId }, other.cookie);
  assert.equal(otherMessage.status, 201);
  assert.notEqual(otherMessage.data.message.id, first.data.message.id);
  assert.equal(otherMessage.data.message.username, 'retry_other');
  assert.equal(otherMessage.data.message.clientMessageId, clientMessageId);
  assert.equal(await isolated.messages.countDocuments(), 2);
  assert.deepEqual((await api('/api/chat', { text: 'Other retry', clientMessageId }, other.cookie)).data, otherMessage.data);
  assert.equal((await api('/api/chat', { text: 'A genuinely new message.', clientMessageId: crypto.randomUUID() }, writer.cookie)).status, 429);
  assert.equal(await isolated.messages.countDocuments(), 2);
});

test('chat retries remain idempotent after a quoted parent is pruned and after reconnecting', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const author = await api('/api/register', { username: 'retry_parent', password: '12345678' });
  const writer = await api('/api/register', { username: 'retry_reply', password: '12345678' });
  const parent = await api('/api/chat', { text: 'An older parent.' }, author.cookie);
  assert.equal(parent.status, 201);
  await isolated.messages.updateOne({ _id: new ObjectId(parent.data.message.id) }, { $set: { createdAt: new Date(Date.now() - 120000) } });
  const clientMessageId = crypto.randomUUID();
  const first = await api('/api/chat', { text: 'The original reply.', replyToId: parent.data.message.id, clientMessageId }, writer.cookie);
  assert.equal(first.status, 201);
  assert.equal(first.data.message.replyTo.available, true);
  await isolated.messages.insertMany(Array.from({ length: 99 }, (_, index) => ({
    userId: new ObjectId(), username: 'older_retry_history', text: `Old message ${index}`, createdAt: new Date(Date.now() - 60000)
  })));
  assert.equal((await api('/api/chat', { text: 'Trim the old parent.' }, author.cookie)).status, 201);
  assert.equal(await isolated.messages.findOne({ _id: new ObjectId(parent.data.message.id) }), null);
  assert.equal(await isolated.messages.countDocuments(), 100);
  const expected = { ...first.data.message, replyTo: { ...first.data.message.replyTo, available: false } };
  const retry = await api('/api/chat', { text: 'The original reply.', replyToId: parent.data.message.id, clientMessageId }, writer.cookie);
  assert.equal(retry.status, 201);
  assert.deepEqual(retry.data, { message: expected });
  assert.equal(await isolated.messages.countDocuments(), 100);
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const freshApi = accountApi(t, reconnected);
  const persistedRetry = await freshApi('/api/chat', { text: '', replyToId: 'invalid', clientMessageId }, writer.cookie);
  assert.equal(persistedRetry.status, 201);
  assert.deepEqual(persistedRetry.data, { message: expected });
  assert.deepEqual((await freshApi('/api/chat')).data.messages.find(message => message.id === first.data.message.id), expected);
  assert.equal(await reconnected.messages.countDocuments(), 100);
});

test('concurrent chat requests with one client message ID recover the same message from the unique insert race', { timeout: 10000 }, async t => {
  const isolated = await changelogStore(t);
  const writer = await accountApi(t, isolated)('/api/register', { username: 'concurrent_retry', password: '12345678' });
  assert.equal(writer.status, 201);
  const clientMessageId = crypto.randomUUID();
  let insertAttempts = 0;
  let releaseInsert;
  const bothInserting = new Promise(resolve => { releaseInsert = resolve; });
  const gateTimeout = setTimeout(releaseInsert, 2000);
  gateTimeout.unref();
  t.after(() => clearTimeout(gateTimeout));
  const raceMessages = new Proxy(isolated.messages, { get(target, property) {
    if (property === 'insertOne') return async (message, options) => {
      if (message.clientMessageId === clientMessageId) {
        insertAttempts += 1;
        if (insertAttempts === 2) releaseInsert();
        await bothInserting;
      }
      return target.insertOne(message, options);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const api = accountApi(t, { ...isolated, messages: raceMessages });
  const results = await Promise.all([
    api('/api/chat', { text: 'One simultaneous message.', clientMessageId }, writer.cookie),
    api('/api/chat', { text: 'One simultaneous message.', clientMessageId }, writer.cookie)
  ]);
  assert.equal(insertAttempts, 2);
  assert.deepEqual(results.map(result => result.status), [201, 201]);
  assert.deepEqual(results[0].data, results[1].data);
  assert.equal(results[0].data.message.clientMessageId, clientMessageId);
  assert.equal(await isolated.messages.countDocuments(), 1);
  assert.deepEqual((await api('/api/chat')).data.messages, [results[0].data.message]);
});

test('leaderboard exposes public saved balances with tied ranks and reflects claims and renames', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated, { verifyTurnstile: async () => true, randomInt: () => 20 });
  assert.deepEqual((await api('/api/leaderboard')).data, { entries: [], totalPlayers: 0 });
  const password = '12345678';
  const players = {};
  for (const username of ['bravo', 'Alpha', 'zero_player', 'claim_player']) {
    const registered = await api('/api/register', { username, password });
    assert.equal(registered.status, 201);
    players[username] = registered;
    await isolated.users.updateOne({ usernameKey: username.toLowerCase() }, { $set: {
      balance: username === 'zero_player' ? 0 : username === 'claim_player' ? 5 : 20,
      email: `${username.toLowerCase()}@example.test`, lastEmailAttemptAt: new Date()
    } });
  }
  const row = (username, rank, balance) => ({ rank, username, accountId: players[username].data.user.accountId, balance });
  const initial = await api('/api/leaderboard');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data, { entries: [row('Alpha', 1, 20), row('bravo', 1, 20), row('claim_player', 3, 5), row('zero_player', 4, 0)], totalPlayers: 4 });
  for (const entry of initial.data.entries) assert.deepEqual(Object.keys(entry).sort(), ['accountId', 'balance', 'rank', 'username']);
  const claim = await api('/api/claim', { turnstileToken: 'test-token' }, players.claim_player.cookie);
  assert.equal(claim.status, 200);
  assert.equal(claim.data.awarded, 20);
  assert.equal(claim.data.user.balance, 25);
  assert.deepEqual((await api('/api/leaderboard')).data, {
    entries: [row('claim_player', 1, 25), row('Alpha', 2, 20), row('bravo', 2, 20), row('zero_player', 4, 0)], totalPlayers: 4
  });
  const renamed = await api('/api/account/username', { username: 'zeta', currentPassword: password }, players.Alpha.cookie, 'PATCH');
  assert.equal(renamed.status, 200);
  assert.deepEqual((await api('/api/leaderboard')).data, {
    entries: [row('claim_player', 1, 25), row('bravo', 2, 20), { ...row('Alpha', 2, 20), username: 'zeta' }, row('zero_player', 4, 0)], totalPlayers: 4
  });
});

test('leaderboard retains deterministic competition ranks, limits results to 100, and persists after reconnecting', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const players = Array.from({ length: 105 }, (_, index) => ({
    _id: new ObjectId(index.toString(16).padStart(24, '0')),
    username: `player_${index.toString().padStart(3, '0')}`,
    usernameKey: `player_${index.toString().padStart(3, '0')}`,
    accountId: `PPR-${crypto.randomUUID().toUpperCase()}`,
    balance: Math.floor(index / 3), passwordHash: 'private-password-hash'
  }));
  await isolated.users.insertMany([...players].reverse());
  const sorted = [...players].sort((first, second) => second.balance - first.balance || first.usernameKey.localeCompare(second.usernameKey));
  const expectedEntries = sorted.slice(0, 100).map((player, index) => ({
    rank: sorted.findIndex(candidate => candidate.balance === player.balance) + 1,
    username: player.username, accountId: player.accountId, balance: player.balance
  }));
  const expected = { entries: expectedEntries, totalPlayers: 105 };
  const leaderboard = await api('/api/leaderboard');
  assert.equal(leaderboard.status, 200);
  assert.deepEqual(leaderboard.data, expected);
  assert.deepEqual(leaderboard.data.entries.slice(0, 4).map(entry => entry.rank), [1, 1, 1, 4]);
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  assert.deepEqual((await accountApi(t, reconnected)('/api/leaderboard')).data, expected);
  assert.equal(await reconnected.users.countDocuments(), 105);
});

test('leaderboard URLs serve the website directly', async () => {
  for (const route of ['/leaderboard', '/leaderboard/']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /Pepper TCG/i);
  }
});

test('public profiles can be read anonymously and only include public account details', async () => {
  const username = `Profile_${crypto.randomBytes(3).toString('hex')}`;
  const createdAt = new Date('2024-04-05T12:00:00.000Z');
  const lastClaimAt = 1700000000000;
  await store.users.insertOne({
    username, usernameKey: username.toLowerCase(), createdAt,
    email: `${username.toLowerCase()}@example.test`, passwordHash: 'private-password-hash',
    balance: 25, lastClaimAt, emailVerifiedAt: new Date(), lastEmailAttemptAt: new Date()
  });

  const result = await request(`/api/profiles/${username.toUpperCase()}`);
  assert.equal(result.status, 200);
  assert.match(result.data.profile.accountId, accountIdPattern);
  assert.equal(result.data.profile.accountId, (await store.users.findOne({ usernameKey: username.toLowerCase() })).accountId);
  assert.deepEqual(result.data, { profile: {
    username, accountId: result.data.profile.accountId, createdAt: createdAt.toISOString(), balance: 25,
    lastClaimAt, nextClaimAt: lastClaimAt + CLAIM_INTERVAL_MS
  } });

  const legacyUsername = `Legacy_${crypto.randomBytes(3).toString('hex')}`;
  await store.users.insertOne({ username: legacyUsername, usernameKey: legacyUsername.toLowerCase() });
  const legacy = await request(`/api/profiles/${legacyUsername}`);
  assert.equal(legacy.status, 200);
  assert.match(legacy.data.profile.accountId, accountIdPattern);
  assert.deepEqual(legacy.data, { profile: {
    username: legacyUsername, accountId: legacy.data.profile.accountId, createdAt: null, balance: 0, lastClaimAt: null, nextClaimAt: null
  } });

  const noClaimUsername = `NoClaim_${crypto.randomBytes(3).toString('hex')}`;
  await store.users.insertOne({ username: noClaimUsername, usernameKey: noClaimUsername.toLowerCase(), balance: 15, lastClaimAt: null });
  const noClaim = await request(`/api/profiles/${noClaimUsername}`);
  assert.equal(noClaim.status, 200);
  assert.deepEqual(noClaim.data, { profile: {
    username: noClaimUsername, accountId: noClaim.data.profile.accountId, createdAt: null, balance: 15, lastClaimAt: null, nextClaimAt: null
  } });

  for (const name of [`missing_${crypto.randomBytes(3).toString('hex')}`, 'ab', 'a'.repeat(25), 'invalid-name', 'invalid%20name']) {
    const missing = await request(`/api/profiles/${name}`);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.data, { error: 'Profile not found.' });
  }
});

test('profile URLs serve the profile page directly', async () => {
  for (const route of ['/profile', '/profile/OtherGardener']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /id="profileIntro"/);
  }
});

test('account username changes preserve the account and refresh historical chat names', async t => {
  const api = accountApi(t);
  const username = `rename_${crypto.randomBytes(3).toString('hex')}`;
  const password = 'original-password';
  const register = await api('/api/register', { username, password });
  assert.equal(register.status, 201);
  const original = await store.users.findOne({ usernameKey: username });
  const lastClaimAt = 1700000000000;
  await store.users.updateOne({ _id: original._id }, { $set: { balance: 42, lastClaimAt } });
  const posted = await api('/api/chat', { text: 'My name can change.' }, register.cookie);
  assert.equal(posted.status, 201);

  const taken = `taken_${crypto.randomBytes(3).toString('hex')}`;
  assert.equal((await api('/api/register', { username: taken, password })).status, 201);
  const route = '/api/account/username';
  assert.equal((await api(route, { username: 'NewGardener', currentPassword: password }, undefined, 'PATCH')).status, 401);
  assert.equal((await api(route, { username: 'NewGardener', currentPassword: 'wrong-password' }, register.cookie, 'PATCH')).status, 403);
  for (const invalid of ['ab', 'invalid-name', 'a'.repeat(25)]) {
    assert.equal((await api(route, { username: invalid, currentPassword: password }, register.cookie, 'PATCH')).status, 400);
  }
  const duplicate = await api(route, { username: taken.toUpperCase(), currentPassword: password }, register.cookie, 'PATCH');
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error, 'That username is already in use.');
  assert.equal((await api('/api/me', undefined, register.cookie)).data.user.username, username);

  const caseOnly = await api(route, { username: `  ${username.toUpperCase()}  `, currentPassword: password }, register.cookie, 'PATCH');
  assert.equal(caseOnly.status, 200);
  assert.equal(caseOnly.data.user.username, username.toUpperCase());
  assert.equal(caseOnly.data.user.balance, 42);
  assert.equal(caseOnly.data.user.passwordHash, undefined);

  const renamed = `Changed_${crypto.randomBytes(3).toString('hex')}`;
  const changed = await api(route, { username: renamed, currentPassword: password }, register.cookie, 'PATCH');
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.username, renamed);
  assert.equal(changed.data.user.createdAt, original.createdAt.toISOString());
  assert.equal(changed.data.user.accountId, original.accountId);
  assert.equal(changed.data.user.balance, 42);
  assert.equal(changed.data.user.lastClaimAt, lastClaimAt);
  assert.equal(changed.data.user.nextClaimAt, lastClaimAt + CLAIM_INTERVAL_MS);
  assert.equal(changed.data.user.passwordHash, undefined);
  const saved = await store.users.findOne({ usernameKey: renamed.toLowerCase() });
  assert.ok(saved._id.equals(original._id));
  assert.equal(saved.accountId, original.accountId);
  assert.equal(saved.passwordHash, original.passwordHash);
  assert.equal((await api('/api/me', undefined, register.cookie)).data.user.username, renamed);
  assert.equal((await api(`/api/profiles/${username}`)).status, 404);
  const profile = await api(`/api/profiles/${renamed}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.data.profile.balance, 42);
  const history = await api('/api/chat');
  assert.equal(history.data.messages.find(item => item.id === posted.data.message.id).username, renamed);
  assert.equal((await store.messages.findOne({ _id: new ObjectId(posted.data.message.id) })).username, username);
  assert.equal((await api('/api/login', { identifier: username, password })).status, 401);
  assert.equal((await api('/api/login', { identifier: renamed.toUpperCase(), password })).status, 200);
});

test('account password changes require the current password and revoke other sessions', async t => {
  const api = accountApi(t);
  const username = `password_${crypto.randomBytes(3).toString('hex')}`;
  const currentPassword = 'original-password';
  const newPassword = 'replacement-password';
  const register = await api('/api/register', { username, password: currentPassword });
  assert.equal(register.status, 201);
  const original = await store.users.findOne({ usernameKey: username });
  const otherSession = await api('/api/login', { identifier: username, password: currentPassword });
  assert.equal(otherSession.status, 200);
  const pendingLoginToken = crypto.randomBytes(32).toString('hex');
  await store.verificationTokens.insertOne({
    _id: crypto.createHash('sha256').update(pendingLoginToken).digest('hex'),
    userId: original._id, purpose: 'login', expiresAt: new Date(Date.now() + 60000)
  });
  const route = '/api/account/password';
  assert.equal((await api(route, { currentPassword, newPassword }, undefined, 'PATCH')).status, 401);
  assert.equal((await api(route, { currentPassword: 'wrong-password', newPassword }, register.cookie, 'PATCH')).status, 403);
  for (const invalid of ['1234567', 'a'.repeat(129)]) {
    assert.equal((await api(route, { currentPassword, newPassword: invalid }, register.cookie, 'PATCH')).status, 400);
  }
  assert.equal((await api('/api/me', undefined, otherSession.cookie)).data.user.username, username);
  assert.equal((await store.users.findOne({ _id: original._id })).passwordHash, original.passwordHash);

  const changed = await api(route, { currentPassword, newPassword }, register.cookie, 'PATCH');
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.data, { ok: true });
  const saved = await store.users.findOne({ _id: original._id });
  assert.equal(saved.accountId, original.accountId);
  assert.notEqual(saved.passwordHash, original.passwordHash);
  assert.notEqual(saved.passwordHash, newPassword);
  assert.equal((await api('/api/me', undefined, register.cookie)).data.user.username, username);
  assert.equal((await api('/api/me', undefined, otherSession.cookie)).data.user, null);
  assert.equal(await store.sessions.countDocuments({ userId: original._id }), 1);
  assert.equal((await api('/api/verify-email', { purpose: 'login', token: pendingLoginToken })).status, 400);
  assert.equal((await api('/api/login', { identifier: username, password: currentPassword })).status, 401);
  const newLogin = await api('/api/login', { identifier: username, password: newPassword });
  assert.equal(newLogin.status, 200);
  assert.ok(newLogin.cookie);
  assert.equal(newLogin.data.user.passwordHash, undefined);
});

test('account updates reject a password changed after the current password check', async t => {
  let changePasswordDuringUpdate = false;
  const raceUsers = new Proxy(store.users, { get(target, property) {
    if (property === 'findOneAndUpdate') return async (filter, update, options) => {
      if (changePasswordDuringUpdate) {
        await target.updateOne({ _id: filter._id }, { $set: { passwordHash: 'concurrently-changed-hash' } });
      }
      return target.findOneAndUpdate(filter, update, options);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const api = accountApi(t, { ...store, users: raceUsers });
  const username = `race_${crypto.randomBytes(3).toString('hex')}`;
  const currentPassword = 'original-password';
  const register = await api('/api/register', { username, password: currentPassword });
  assert.equal(register.status, 201);
  const original = await store.users.findOne({ usernameKey: username });
  changePasswordDuringUpdate = true;
  for (const [route, body] of [
    ['/api/account/username', { username: 'ChangedGardener', currentPassword }],
    ['/api/account/password', { currentPassword, newPassword: 'replacement-password' }]
  ]) {
    await store.users.updateOne({ _id: original._id }, { $set: { passwordHash: original.passwordHash } });
    const result = await api(route, body, register.cookie, 'PATCH');
    assert.equal(result.status, 409);
    assert.equal(result.data.error, 'Your account changed. Please try again.');
    const saved = await store.users.findOne({ _id: original._id });
    assert.equal(saved.username, username);
    assert.equal(saved.passwordHash, 'concurrently-changed-hash');
    assert.equal(await store.sessions.countDocuments({ userId: original._id }), 1);
  }
});

test('settings URLs serve the settings page directly', async () => {
  for (const route of ['/settings', '/settings/']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /id="settingsPage"/);
    assert.match(html, /<script\b[^>]*\bsrc="\/theme\.js(?:\?[^\"]*)?"[^>]*>/);
  }
});

async function changelogStore(t) {
  const isolated = await connectMongo({ uri: mongo.getUri(), dbName: `changelog_${crypto.randomBytes(3).toString('hex')}` });
  t.after(() => isolated.client.close());
  return isolated;
}

test('changelog publishing is private, dates are automatic, and latest entries persist publicly', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  assert.deepEqual((await api('/api/changelog')).data, { entries: [], latestVersion: '0.4.0' });
  const payload = { title: 'First update', description: 'A new beginning.', version: 'v1.0.0', createdAt: '1970-01-01T00:00:00Z' };
  assert.equal((await api('/api/changelog', payload)).status, 401);
  const member = await api('/api/register', { username: 'ordinary_member', password: '12345678' });
  assert.equal(member.data.user.canManageChangelog, false);
  assert.equal((await api('/api/changelog', { ...payload, canManageChangelog: true }, member.cookie)).status, 403);
  const owner = await api('/api/register', { username: '675', password: '12345678' });
  assert.equal(owner.data.user.canManageChangelog, true);
  assert.equal((await api('/api/me', undefined, owner.cookie)).data.user.canManageChangelog, true);
  assert.equal((await api('/api/login', { identifier: '675', password: '12345678' })).data.user.canManageChangelog, true);
  const beforePublish = Date.now();
  const first = await api('/api/changelog', payload, owner.cookie);
  assert.equal(first.status, 201);
  assert.equal(first.data.latestVersion, '1.0.0');
  assert.equal(first.data.entry.version, '1.0.0');
  assert.ok(Date.parse(first.data.entry.createdAt) >= beforePublish);
  assert.ok(Date.parse(first.data.entry.createdAt) <= Date.now());
  assert.match(first.data.entry.createdAt, /Z$/);
  assert.deepEqual(Object.keys(first.data.entry).sort(), ['createdAt', 'description', 'id', 'title', 'version']);
  const storedFirst = await isolated.changelog.findOne({ _id: new ObjectId(first.data.entry.id) });
  assert.ok(storedFirst.createdAt instanceof Date);
  assert.ok(storedFirst.authorId.equals((await isolated.users.findOne({ usernameKey: '675' }))._id));

  const second = await api('/api/changelog', { title: '  Second update  ', description: '  Line one\nLine two  ', version: '  0.8.2  ' }, owner.cookie);
  assert.equal(second.status, 201);
  assert.equal(second.data.latestVersion, '0.8.2');
  assert.equal(second.data.entry.title, 'Second update');
  assert.equal(second.data.entry.description, 'Line one\nLine two');
  const list = await api('/api/changelog');
  assert.equal(list.data.latestVersion, '0.8.2');
  assert.deepEqual(list.data.entries.map(entry => entry.id), [second.data.entry.id, first.data.entry.id]);

  const identicalTime = new Date();
  await isolated.changelog.updateMany({}, { $set: { createdAt: identicalTime } });
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const freshApi = accountApi(t, reconnected);
  const persisted = await freshApi('/api/changelog');
  assert.equal(persisted.data.latestVersion, '0.8.2');
  assert.deepEqual(persisted.data.entries.map(entry => entry.id), [second.data.entry.id, first.data.entry.id]);
});

test('changelog owner permission follows the original account ID across renames and restarts', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const password = '12345678';
  const member = await api('/api/register', { username: 'name_changer', password });
  assert.equal((await api('/api/account/username', { username: '675', currentPassword: password }, member.cookie, 'PATCH')).status, 403);
  const owner = await api('/api/register', { username: '675', password });
  const boundId = (await isolated.siteSettings.findOne({ _id: 'changelog' })).ownerUserId;
  const boundAccountId = (await isolated.siteSettings.findOne({ _id: 'changelog' })).ownerAccountId;
  assert.equal(boundAccountId, owner.data.user.accountId);
  assert.ok(boundId.equals((await isolated.users.findOne({ usernameKey: '675' }))._id));
  const changedOwner = await api('/api/account/username', { username: 'original_owner', currentPassword: password }, owner.cookie, 'PATCH');
  assert.equal(changedOwner.status, 200);
  assert.equal(changedOwner.data.user.canManageChangelog, true);
  assert.equal(changedOwner.data.user.accountId, boundAccountId);
  const changedMember = await api('/api/account/username', { username: '675', currentPassword: password }, member.cookie, 'PATCH');
  assert.equal(changedMember.status, 200);
  assert.equal(changedMember.data.user.canManageChangelog, false);
  assert.notEqual(changedMember.data.user.accountId, boundAccountId);
  const payload = { title: 'Owner update', description: 'Permissions stay with the account.', version: '0.5.0' };
  assert.equal((await api('/api/changelog', payload, member.cookie)).status, 403);
  assert.equal((await api('/api/changelog', payload, owner.cookie)).status, 201);
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const freshApi = accountApi(t, reconnected);
  assert.equal((await freshApi('/api/me', undefined, owner.cookie)).data.user.canManageChangelog, true);
  assert.equal((await freshApi('/api/me', undefined, member.cookie)).data.user.canManageChangelog, false);
  assert.ok((await reconnected.siteSettings.findOne({ _id: 'changelog' })).ownerUserId.equals(boundId));
  assert.equal((await reconnected.siteSettings.findOne({ _id: 'changelog' })).ownerAccountId, boundAccountId);
});

test('changelog deletion requires the permanent owner and rejects invalid or missing entries without changes', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const password = '12345678';
  const owner = await api('/api/register', { username: '675', password });
  const member = await api('/api/register', { username: 'ordinary_deleter', password });
  const published = await api('/api/changelog', { title: 'Keep this update', description: 'Only its owner can delete it.', version: '0.5.0' }, owner.cookie);
  const route = `/api/changelog/${published.data.entry.id}`;
  const original = (await api('/api/changelog')).data;
  assert.equal((await api(route, undefined, undefined, 'DELETE')).status, 401);
  assert.equal((await api(route, { canManageChangelog: true, accountId: owner.data.user.accountId }, member.cookie, 'DELETE')).status, 403);
  for (const invalid of ['invalid', 'a'.repeat(23), 'a'.repeat(25), 'z'.repeat(24), '123456789012']) {
    assert.equal((await api(`/api/changelog/${invalid}`, undefined, owner.cookie, 'DELETE')).status, 400);
  }
  assert.equal((await api(`/api/changelog/${new ObjectId()}`, undefined, owner.cookie, 'DELETE')).status, 404);
  assert.deepEqual((await api('/api/changelog')).data, original);
  assert.equal(await isolated.changelog.countDocuments(), 1);

  const renamedOwner = await api('/api/account/username', { username: 'renamed_deletion_owner', currentPassword: password }, owner.cookie, 'PATCH');
  assert.equal(renamedOwner.status, 200);
  assert.equal(renamedOwner.data.user.accountId, owner.data.user.accountId);
  assert.equal(renamedOwner.data.user.canManageChangelog, true);
  const impostor = await api('/api/account/username', { username: '675', currentPassword: password }, member.cookie, 'PATCH');
  assert.equal(impostor.status, 200);
  assert.equal(impostor.data.user.canManageChangelog, false);
  assert.equal((await api(route, undefined, member.cookie, 'DELETE')).status, 403);
  assert.deepEqual((await api('/api/changelog')).data, original);
  const deleted = await api(`/api/changelog/${published.data.entry.id.toUpperCase()}`, undefined, owner.cookie, 'DELETE');
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data, { entries: [], latestVersion: '0.4.0' });
  assert.equal((await api(route, undefined, owner.cookie, 'DELETE')).status, 404);
});

test('deleting older, newest, and final changelog entries updates the public version and persists', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const owner = await api('/api/register', { username: '675', password: '12345678' });
  const entries = [];
  for (const version of ['0.5.0', '0.6.0', '0.7.0']) {
    const published = await api('/api/changelog', { title: `Update ${version}`, description: 'A saved release note.', version }, owner.cookie);
    assert.equal(published.status, 201);
    entries.push(published.data.entry);
  }
  const deleteEntry = (entry, requestApi = api) => requestApi(`/api/changelog/${entry.id}`, undefined, owner.cookie, 'DELETE');
  const older = await deleteEntry(entries[0]);
  assert.equal(older.status, 200);
  assert.equal(older.data.latestVersion, '0.7.0');
  assert.deepEqual(older.data.entries, [entries[2], entries[1]]);
  assert.equal(await isolated.changelog.findOne({ _id: new ObjectId(entries[0].id) }), null);
  assert.equal(await isolated.changelog.countDocuments(), 2);

  const newest = await deleteEntry(entries[2]);
  assert.equal(newest.status, 200);
  assert.deepEqual(newest.data, { entries: [entries[1]], latestVersion: '0.6.0' });
  assert.deepEqual((await api('/api/changelog')).data, newest.data);
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const freshApi = accountApi(t, reconnected);
  assert.deepEqual((await freshApi('/api/changelog')).data, newest.data);

  const final = await deleteEntry(entries[1], freshApi);
  assert.equal(final.status, 200);
  assert.deepEqual(final.data, { entries: [], latestVersion: '0.4.0' });
  assert.deepEqual((await api('/api/changelog')).data, final.data);
  assert.equal(await isolated.changelog.countDocuments(), 0);
  const restarted = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => restarted.client.close());
  assert.deepEqual((await accountApi(t, restarted)('/api/changelog')).data, final.data);
});

test('new account IDs are random, unique, public, immutable, and ignore supplied IDs', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const first = await api('/api/register', { username: 'first_id', password: '12345678', accountId: '675' });
  const second = await api('/api/register', { username: 'second_id', password: '12345678', accountId: first.data.user.accountId });
  assert.match(first.data.user.accountId, accountIdPattern);
  assert.match(second.data.user.accountId, accountIdPattern);
  assert.notEqual(first.data.user.accountId, second.data.user.accountId);
  const original = await isolated.users.findOne({ usernameKey: 'first_id' });
  assert.equal(original.accountId, first.data.user.accountId);
  const renamed = await api('/api/account/username', { username: 'renamed_id', currentPassword: '12345678', accountId: second.data.user.accountId }, first.cookie, 'PATCH');
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.user.accountId, first.data.user.accountId);
  const publicProfile = await api('/api/profiles/renamed_id');
  assert.equal(publicProfile.data.profile.accountId, first.data.user.accountId);
  assert.equal((await api('/api/me', undefined, first.cookie)).data.user.accountId, first.data.user.accountId);
  assert.ok((await isolated.users.findOne({ usernameKey: 'renamed_id' }))._id.equals(original._id));
  await assert.rejects(
    isolated.users.insertOne({ username: 'duplicate_id', usernameKey: 'duplicate_id', accountId: first.data.user.accountId }),
    error => error.code === 11000 && error.keyPattern.accountId === 1
  );
});

test('startup backfills legacy account IDs once safely across concurrent connections', async t => {
  const isolated = await changelogStore(t);
  const preservedId = `PPR-${crypto.randomUUID().toUpperCase()}`;
  const createdAt = new Date('2024-01-01T00:00:00Z');
  await isolated.users.insertMany([
    { username: 'legacy_a', usernameKey: 'legacy_a', balance: 37, createdAt, lastClaimAt: 1700000000000, passwordHash: 'preserved-password-hash' },
    { username: 'legacy_b', usernameKey: 'legacy_b', balance: 12, accountId: null },
    { username: 'legacy_c', usernameKey: 'legacy_c', balance: 0, accountId: '' },
    { username: 'already_assigned', usernameKey: 'already_assigned', accountId: preservedId }
  ]);
  const original = await isolated.users.findOne({ usernameKey: 'legacy_a' });
  const reconnects = await Promise.all(Array.from({ length: 2 }, () => connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName })));
  for (const connected of reconnects) t.after(() => connected.client.close());
  const assigned = await isolated.users.find().sort({ usernameKey: 1 }).toArray();
  assert.equal(new Set(assigned.map(user => user.accountId)).size, 4);
  for (const user of assigned) assert.match(user.accountId, accountIdPattern);
  assert.equal(assigned.find(user => user.usernameKey === 'already_assigned').accountId, preservedId);
  const legacy = assigned.find(user => user.usernameKey === 'legacy_a');
  assert.ok(legacy._id.equals(original._id));
  assert.equal(legacy.balance, 37);
  assert.equal(legacy.passwordHash, 'preserved-password-hash');
  assert.equal(legacy.lastClaimAt, 1700000000000);
  assert.equal(legacy.createdAt.toISOString(), createdAt.toISOString());
  const restarted = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => restarted.client.close());
  const stable = await restarted.users.find().sort({ usernameKey: 1 }).toArray();
  assert.deepEqual(stable.map(user => user.accountId), assigned.map(user => user.accountId));
});

test('legacy changelog ownership migrates through its stored account after a username change', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const original = await api('/api/register', { username: 'former_675', password: '12345678' });
  const ownerDocument = await isolated.users.findOne({ usernameKey: 'former_675' });
  const impostor = await api('/api/register', { username: 'current_impostor', password: '12345678' });
  await isolated.users.updateOne({ usernameKey: 'current_impostor' }, { $set: { username: '675', usernameKey: '675' } });
  await isolated.siteSettings.updateOne({ _id: 'changelog' }, {
    $set: { ownerUserId: ownerDocument._id }, $unset: { ownerAccountId: '' }
  });
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const settings = await reconnected.siteSettings.findOne({ _id: 'changelog' });
  assert.equal(settings.ownerAccountId, original.data.user.accountId);
  assert.ok(settings.ownerUserId.equals(ownerDocument._id));
  const freshApi = accountApi(t, reconnected);
  assert.equal((await freshApi('/api/me', undefined, original.cookie)).data.user.canManageChangelog, true);
  assert.equal((await freshApi('/api/me', undefined, impostor.cookie)).data.user.canManageChangelog, false);
  assert.equal((await freshApi('/api/changelog', { title: 'Preserved owner', description: 'The name has changed.', version: '0.6.0' }, original.cookie)).status, 201);
});

test('missing legacy changelog owners never transfer permission to the current 675 name', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const impostor = await api('/api/register', { username: 'future_675', password: '12345678' });
  await isolated.users.updateOne({ usernameKey: 'future_675' }, { $set: { username: '675', usernameKey: '675' } });
  const missingOwnerId = new ObjectId();
  await isolated.siteSettings.updateOne({ _id: 'changelog' }, {
    $set: { ownerUserId: missingOwnerId, ownerAccountId: null }
  });
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const settings = await reconnected.siteSettings.findOne({ _id: 'changelog' });
  assert.equal(settings.ownerAccountId, null);
  assert.ok(settings.ownerUserId.equals(missingOwnerId));
  const freshApi = accountApi(t, reconnected);
  assert.equal((await freshApi('/api/me', undefined, impostor.cookie)).data.user.canManageChangelog, false);
  assert.equal((await freshApi('/api/changelog', { title: 'Forbidden', description: 'An old owner is missing.', version: '0.6.0' }, impostor.cookie)).status, 403);
});

test('connecting binds the existing 675 account and changelog input is validated', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const register = await api('/api/register', { username: 'existing_owner', password: '12345678' });
  const original = await isolated.users.findOne({ usernameKey: 'existing_owner' });
  // Simulate an account named 675 that predates the changelog feature.
  await isolated.users.updateOne({ _id: original._id }, { $set: { username: '675', usernameKey: '675' } });
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  assert.ok((await reconnected.siteSettings.findOne({ _id: 'changelog' })).ownerUserId.equals(original._id));
  const freshApi = accountApi(t, reconnected);
  assert.equal((await freshApi('/api/me', undefined, register.cookie)).data.user.canManageChangelog, true);
  const valid = { title: 'A title', description: 'A description', version: '0.5.0' };
  for (const change of [
    { title: '  ' }, { title: 'a'.repeat(121) }, { title: { value: 'A title' } },
    { description: '' }, { description: 'a'.repeat(5001) }, { description: 12 },
    ...['1', '1.2', '1.2.3.4', '01.2.3', '1.2.3-beta', '-1.2.3', 'a.2.3', '1'.repeat(33)].map(version => ({ version }))
  ]) {
    assert.equal((await freshApi('/api/changelog', { ...valid, ...change }, register.cookie)).status, 400);
  }
  assert.equal(await isolated.changelog.countDocuments(), 0);
  const largest = await freshApi('/api/changelog', { title: 'a'.repeat(120), description: '椒'.repeat(5000), version: 'V12.3.4' }, register.cookie);
  assert.equal(largest.status, 201);
  assert.equal(largest.data.entry.version, '12.3.4');
  assert.equal(largest.data.entry.description.length, 5000);
});

test('changelog URLs serve the website directly', async () => {
  for (const route of ['/changelog', '/changelog/']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /Pepper TCG/i);
  }
});

test('announcements are public, only the owner can publish, and their dates and saved ordering are automatic', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  assert.deepEqual((await api('/api/announcements')).data, { entries: [] });
  const payload = { title: 'Welcome players', description: 'A new announcement.', createdAt: '1970-01-01T00:00:00Z', version: '99.0.0' };
  assert.equal((await api('/api/announcements', payload)).status, 401);
  const member = await api('/api/register', { username: 'announcement_member', password: '12345678', canManageAnnouncements: true });
  assert.equal(member.data.user.canManageAnnouncements, false);
  const owner = await api('/api/register', { username: '675', password: '12345678' });
  assert.equal(owner.data.user.canManageAnnouncements, true);
  assert.equal((await api('/api/me', undefined, owner.cookie)).data.user.canManageAnnouncements, true);
  assert.equal((await api('/api/login', { identifier: '675', password: '12345678' })).data.user.canManageAnnouncements, true);
  assert.equal((await api('/api/announcements', {
    ...payload, username: '675', accountId: owner.data.user.accountId, canManageAnnouncements: true
  }, member.cookie)).status, 403);
  const release = await api('/api/changelog', { title: 'A release', description: 'The current release.', version: '0.6.0' }, owner.cookie);
  assert.equal(release.status, 201);
  const changelog = (await api('/api/changelog')).data;

  const beforePublish = Date.now();
  const first = await api('/api/announcements', payload, owner.cookie);
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.data), ['entry']);
  assert.deepEqual(Object.keys(first.data.entry).sort(), ['createdAt', 'description', 'id', 'title']);
  assert.ok(Date.parse(first.data.entry.createdAt) >= beforePublish);
  assert.ok(Date.parse(first.data.entry.createdAt) <= Date.now());
  const storedFirst = await isolated.announcements.findOne({ _id: new ObjectId(first.data.entry.id) });
  assert.ok(storedFirst.createdAt instanceof Date);
  assert.equal(storedFirst.authorAccountId, owner.data.user.accountId);
  assert.equal(storedFirst.version, undefined);
  const second = await api('/api/announcements', { title: '  Another announcement  ', description: '  Line one\nLine two  ' }, owner.cookie);
  assert.equal(second.status, 201);
  assert.equal(second.data.entry.title, 'Another announcement');
  assert.equal(second.data.entry.description, 'Line one\nLine two');
  assert.deepEqual((await api('/api/announcements')).data.entries, [second.data.entry, first.data.entry]);
  assert.deepEqual((await api('/api/changelog')).data, changelog);

  const identicalTime = new Date();
  await isolated.announcements.updateMany({}, { $set: { createdAt: identicalTime } });
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const freshApi = accountApi(t, reconnected);
  const persisted = await freshApi('/api/announcements');
  assert.equal(persisted.status, 200);
  assert.deepEqual(persisted.data.entries.map(entry => entry.id), [second.data.entry.id, first.data.entry.id]);
  assert.deepEqual((await freshApi('/api/changelog')).data, changelog);
});

test('announcement permission stays with the original owner through renaming, reclaimed names, and restarts', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const password = '12345678';
  const owner = await api('/api/register', { username: '675', password });
  const member = await api('/api/register', { username: 'announcement_impostor', password });
  const published = await api('/api/announcements', { title: 'Owner news', description: 'Only its owner can remove it.' }, owner.cookie);
  assert.equal(published.status, 201);
  const route = `/api/announcements/${published.data.entry.id}`;
  const original = (await api('/api/announcements')).data;
  assert.equal((await api(route, undefined, undefined, 'DELETE')).status, 401);
  assert.equal((await api(route, { canManageAnnouncements: true, accountId: owner.data.user.accountId }, member.cookie, 'DELETE')).status, 403);
  const renamedOwner = await api('/api/account/username', { username: 'announcement_owner', currentPassword: password }, owner.cookie, 'PATCH');
  assert.equal(renamedOwner.status, 200);
  assert.equal(renamedOwner.data.user.canManageAnnouncements, true);
  assert.equal(renamedOwner.data.user.accountId, owner.data.user.accountId);
  const renamedMember = await api('/api/account/username', { username: '675', currentPassword: password }, member.cookie, 'PATCH');
  assert.equal(renamedMember.status, 200);
  assert.equal(renamedMember.data.user.canManageAnnouncements, false);
  assert.equal((await api('/api/announcements', { title: 'Forbidden', description: 'A reclaimed name gives no permission.' }, member.cookie)).status, 403);
  assert.equal((await api(route, undefined, member.cookie, 'DELETE')).status, 403);
  assert.deepEqual((await api('/api/announcements')).data, original);

  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const freshApi = accountApi(t, reconnected);
  assert.equal((await freshApi('/api/me', undefined, owner.cookie)).data.user.canManageAnnouncements, true);
  assert.equal((await freshApi('/api/me', undefined, member.cookie)).data.user.canManageAnnouncements, false);
  assert.deepEqual((await freshApi('/api/announcements')).data, original);
  const second = await freshApi('/api/announcements', { title: 'Still the owner', description: 'Ownership remains after restart.' }, owner.cookie);
  assert.equal(second.status, 201);
  const deleted = await freshApi(`/api/announcements/${published.data.entry.id.toUpperCase()}`, undefined, owner.cookie, 'DELETE');
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data, { entries: [second.data.entry] });
  assert.equal((await freshApi(route, undefined, owner.cookie, 'DELETE')).status, 404);
  assert.deepEqual((await api('/api/announcements')).data, deleted.data);
  assert.deepEqual((await freshApi(`/api/announcements/${second.data.entry.id}`, undefined, owner.cookie, 'DELETE')).data, { entries: [] });
  const restarted = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => restarted.client.close());
  assert.deepEqual((await accountApi(t, restarted)('/api/announcements')).data, { entries: [] });
});

test('announcements validate titles, descriptions, and deletion IDs without changing saved entries', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const owner = await api('/api/register', { username: '675', password: '12345678' });
  const valid = { title: 'A title', description: 'A description' };
  for (const change of [
    { title: '' }, { title: '  ' }, { title: 'a'.repeat(121) }, { title: { value: 'A title' } },
    { description: '' }, { description: '  ' }, { description: 'a'.repeat(5001) }, { description: 12 }
  ]) {
    assert.equal((await api('/api/announcements', { ...valid, ...change }, owner.cookie)).status, 400);
  }
  assert.equal(await isolated.announcements.countDocuments(), 0);
  const largest = await api('/api/announcements', { title: 'a'.repeat(120), description: '椒'.repeat(5000) }, owner.cookie);
  assert.equal(largest.status, 201);
  assert.equal(largest.data.entry.description.length, 5000);
  const original = (await api('/api/announcements')).data;
  for (const invalid of ['invalid', 'a'.repeat(23), 'a'.repeat(25), 'z'.repeat(24), '123456789012']) {
    assert.equal((await api(`/api/announcements/${invalid}`, undefined, owner.cookie, 'DELETE')).status, 400);
  }
  assert.equal((await api(`/api/announcements/${new ObjectId()}`, undefined, owner.cookie, 'DELETE')).status, 404);
  assert.deepEqual((await api('/api/announcements')).data, original);
  assert.equal(await isolated.announcements.countDocuments(), 1);
});

test('presence counts signed-in players only after heartbeats and deduplicates their active sessions', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  assert.deepEqual((await api('/api/presence')).data, { count: 0 });
  const first = await api('/api/register', { username: 'presence_first', password: '12345678' });
  assert.equal(first.status, 201);
  const firstUser = await isolated.users.findOne({ usernameKey: 'presence_first' });
  assert.deepEqual((await api('/api/presence', undefined, first.cookie)).data, { count: 0 });
  const anonymous = await api('/api/presence', { userId: firstUser._id.toString(), accountId: first.data.user.accountId, count: 200 });
  assert.equal(anonymous.status, 200);
  assert.deepEqual(anonymous.data, { count: 0 });
  assert.equal(await isolated.sessions.countDocuments({ lastSeenAt: { $exists: true } }), 0);
  const beforeHeartbeat = Date.now();
  const heartbeat = await api('/api/presence', {}, first.cookie);
  assert.equal(heartbeat.status, 200);
  assert.deepEqual(heartbeat.data, { count: 1 });
  const active = await isolated.sessions.findOne({ userId: firstUser._id });
  assert.ok(active.lastSeenAt instanceof Date);
  assert.ok(active.lastSeenAt.getTime() >= beforeHeartbeat);
  assert.ok(active.lastSeenAt.getTime() <= Date.now());
  const anotherSession = await api('/api/login', { identifier: 'presence_first', password: '12345678' });
  assert.equal(anotherSession.status, 200);
  assert.deepEqual((await api('/api/presence', {}, anotherSession.cookie)).data, { count: 1 });
  const second = await api('/api/register', { username: 'presence_second', password: '12345678' });
  assert.equal(second.status, 201);
  assert.deepEqual((await api('/api/presence')).data, { count: 1 });
  assert.deepEqual((await api('/api/presence', {}, second.cookie)).data, { count: 2 });
  assert.deepEqual((await api('/api/presence', {}, `pepper_session=${'a'.repeat(64)}`)).data, { count: 2 });
  assert.equal((await api('/api/logout', {}, first.cookie)).status, 200);
  assert.deepEqual((await api('/api/presence')).data, { count: 2 });
  assert.equal((await api('/api/logout', {}, anotherSession.cookie)).status, 200);
  assert.deepEqual((await api('/api/presence')).data, { count: 1 });
  assert.equal((await api('/api/logout', {}, second.cookie)).status, 200);
  assert.deepEqual((await api('/api/presence', {}, second.cookie)).data, { count: 0 });
});

test('presence stops counting stale and expired sessions while valid players can become active again', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  assert.equal(PRESENCE_TIMEOUT_MS, 75000);
  const player = await api('/api/register', { username: 'presence_timeout', password: '12345678' });
  assert.equal(player.status, 201);
  assert.deepEqual((await api('/api/presence', {}, player.cookie)).data, { count: 1 });
  const user = await isolated.users.findOne({ usernameKey: 'presence_timeout' });
  await isolated.sessions.updateMany({ userId: user._id }, { $set: { lastSeenAt: new Date(Date.now() - PRESENCE_TIMEOUT_MS - 1000) } });
  assert.deepEqual((await api('/api/presence', undefined, player.cookie)).data, { count: 0 });
  assert.deepEqual((await api('/api/presence', {})).data, { count: 0 });
  assert.deepEqual((await api('/api/presence', {}, player.cookie)).data, { count: 1 });
  const refreshed = await isolated.sessions.findOne({ userId: user._id });
  await isolated.sessions.updateMany({ userId: user._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.deepEqual((await api('/api/presence')).data, { count: 0 });
  assert.deepEqual((await api('/api/presence', {}, player.cookie)).data, { count: 0 });
  const expired = await isolated.sessions.findOne({ _id: refreshed._id });
  if (expired) assert.deepEqual(expired.lastSeenAt, refreshed.lastSeenAt);
});

test('presence is shared across app instances and password changes immediately remove revoked sessions', async t => {
  const isolated = await changelogStore(t);
  const api = accountApi(t, isolated);
  const password = 'original-password';
  const player = await api('/api/register', { username: 'presence_shared', password });
  assert.equal(player.status, 201);
  const otherSession = await api('/api/login', { identifier: 'presence_shared', password });
  assert.equal(otherSession.status, 200);
  assert.deepEqual((await api('/api/presence', {}, otherSession.cookie)).data, { count: 1 });
  const reconnected = await connectMongo({ uri: mongo.getUri(), dbName: isolated.db.databaseName });
  t.after(() => reconnected.client.close());
  const freshApi = accountApi(t, reconnected);
  assert.deepEqual((await freshApi('/api/presence')).data, { count: 1 });
  const changed = await api('/api/account/password', { currentPassword: password, newPassword: 'replacement-password' }, player.cookie, 'PATCH');
  assert.equal(changed.status, 200);
  assert.deepEqual((await freshApi('/api/presence')).data, { count: 0 });
  assert.deepEqual((await freshApi('/api/presence', {}, otherSession.cookie)).data, { count: 0 });
  assert.deepEqual((await freshApi('/api/presence', {}, player.cookie)).data, { count: 1 });
  const second = await freshApi('/api/register', { username: 'presence_other_app', password: '12345678' });
  assert.equal(second.status, 201);
  assert.deepEqual((await freshApi('/api/presence', {}, second.cookie)).data, { count: 2 });
  assert.deepEqual((await api('/api/presence')).data, { count: 2 });
  const firstUser = await isolated.users.findOne({ usernameKey: 'presence_shared' });
  await isolated.sessions.updateMany({ userId: firstUser._id }, { $set: { lastSeenAt: new Date(Date.now() - PRESENCE_TIMEOUT_MS - 1000) } });
  assert.deepEqual((await freshApi('/api/presence')).data, { count: 1 });
  assert.equal((await api('/api/logout', {}, second.cookie)).status, 200);
  assert.deepEqual((await freshApi('/api/presence')).data, { count: 0 });
});

test('announcement URLs serve the website directly', async () => {
  for (const route of ['/announcements', '/announcements/']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /Pepper TCG/i);
  }
});

test('chat keeps the newest 100 messages when sends overlap, with stable ordering for matching times', async () => {
  const chatStore = await connectMongo({ uri: mongo.getUri(), dbName: `chat_${crypto.randomBytes(3).toString('hex')}` });
  const chatServer = createApp(chatStore, { mailer: null }).listen(0);
  const chatUrl = `http://127.0.0.1:${chatServer.address().port}/api/chat`;
  try {
    const createdAt = new Date(Date.now() - 60000);
    const seedUserId = new ObjectId();
    await chatStore.messages.insertMany(Array.from({ length: 120 }, (_, index) => ({
      _id: new ObjectId(index.toString(16).padStart(24, '0')),
      userId: seedUserId, username: 'history', text: `message ${index}`, createdAt
    })));
    const initial = await (await fetch(chatUrl)).json();
    assert.equal(initial.messages.length, 100);
    assert.deepEqual(initial.messages.map(message => message.text),
      Array.from({ length: 100 }, (_, index) => `message ${index + 20}`));

    const cookies = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const userId = new ObjectId();
      await chatStore.users.insertOne({ _id: userId, username: `sender_${index}`, usernameKey: `sender_${index}` });
      const token = crypto.randomBytes(32).toString('hex');
      await chatStore.sessions.insertOne({
        _id: crypto.createHash('sha256').update(token).digest('hex'),
        userId, expiresAt: new Date(Date.now() + 60000)
      });
      return `pepper_session=${token}`;
    }));
    const sends = await Promise.all(cookies.map((cookie, index) => fetch(chatUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: `new message ${index}` })
    })));
    for (const response of sends) assert.equal(response.status, 201);

    const stored = await chatStore.messages.find().sort({ createdAt: 1, _id: 1 }).toArray();
    assert.equal(stored.length, 100);
    assert.deepEqual(stored.slice(0, 92).map(message => message.text),
      Array.from({ length: 92 }, (_, index) => `message ${index + 28}`));
    assert.deepEqual(new Set(stored.slice(92).map(message => message.text)),
      new Set(Array.from({ length: 8 }, (_, index) => `new message ${index}`)));
    const latest = await (await fetch(chatUrl)).json();
    assert.deepEqual(latest.messages.map(message => message.id), stored.map(message => message._id.toString()));
  } finally {
    await new Promise(resolve => chatServer.close(resolve));
    await chatStore.client.close();
  }
});

test('connecting to an existing database trims chat history to the newest 100', async () => {
  const dbName = `chat_startup_${crypto.randomBytes(3).toString('hex')}`;
  const messages = store.client.db(dbName).collection('messages');
  await messages.insertMany(Array.from({ length: 105 }, (_, index) => ({
    _id: new ObjectId(index.toString(16).padStart(24, '0')),
    username: 'history', text: `message ${index}`,
    createdAt: new Date(index < 55 ? 1000 : 2000)
  })));
  const restarted = await connectMongo({ uri: mongo.getUri(), dbName });
  try {
    const remaining = await restarted.messages.find().sort({ createdAt: 1, _id: 1 }).toArray();
    assert.equal(remaining.length, 100);
    assert.deepEqual(remaining.map(message => message.text),
      Array.from({ length: 100 }, (_, index) => `message ${index + 5}`));
  } finally { await restarted.client.close(); }
});
