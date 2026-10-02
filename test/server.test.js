const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ObjectId } = require('mongodb');
const { createApp, connectMongo } = require('../server');
const { migrate } = require('../scripts/migrate-sqlite');

let mongo;
let store;
let server;
let base;
const sentEmails = [];
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

async function request(route, body, cookie) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
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
  assert.equal(register.data.user.email, null);
  assert.equal(sentEmails.length, emailsBeforeSignup);
  const stored = await store.users.findOne({ usernameKey: username.toLowerCase() });
  assert.ok(stored);
  assert.notEqual(stored.passwordHash, '12345678');
  assert.equal(stored.balance, 0);
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
  assert.equal(claim.data.awarded, 5);
  assert.equal(claim.data.user.balance, 5);
  assert.ok(claim.data.user.nextClaimAt > Date.now());
  assert.equal((await store.users.findOne({ _id: stored._id })).balance, 5);

  const again = await request('/api/claim', { turnstileToken: 'valid-test-token' }, cookie);
  assert.equal(again.status, 429);
  assert.equal((await request('/api/me', undefined, cookie)).data.user.balance, 5);

  assert.equal((await request('/api/logout', {}, cookie)).status, 200);
  assert.equal((await request('/api/me', undefined, cookie)).data.user, null);
  const login = await request('/api/login', { identifier: username.toUpperCase(), password: '12345678' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.balance, 5);

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
  assert.equal(emailVerified.data.user.balance, 5);
  assert.ok(emailVerified.cookie);
  assert.equal((await request('/api/verify-email', { purpose: 'login', token: loginToken })).status, 400);
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
  const messages = await request('/api/chat');
  assert.equal(messages.status, 200);
  assert.ok(messages.data.messages.some(item => item.id === post.data.message.id));
  assert.equal((await request('/api/chat', { text: 'Too soon' }, signedUp.cookie)).status, 429);
});

test('public profiles can be read anonymously and only include public account details', async () => {
  const username = `Profile_${crypto.randomBytes(3).toString('hex')}`;
  const createdAt = new Date('2024-04-05T12:00:00.000Z');
  await store.users.insertOne({
    username, usernameKey: username.toLowerCase(), createdAt,
    email: `${username.toLowerCase()}@example.test`, passwordHash: 'private-password-hash',
    balance: 25, lastClaimAt: Date.now(), emailVerifiedAt: new Date(), lastEmailAttemptAt: new Date()
  });

  const result = await request(`/api/profiles/${username.toUpperCase()}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { profile: { username, createdAt: createdAt.toISOString() } });

  const legacyUsername = `Legacy_${crypto.randomBytes(3).toString('hex')}`;
  await store.users.insertOne({ username: legacyUsername, usernameKey: legacyUsername.toLowerCase(), balance: 0 });
  const legacy = await request(`/api/profiles/${legacyUsername}`);
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.data, { profile: { username: legacyUsername, createdAt: null } });

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
