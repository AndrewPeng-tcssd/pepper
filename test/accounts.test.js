const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { ObjectId } = require('mongodb');
const { MongoMemoryReplSet, MongoMemoryServer } = require('mongodb-memory-server');
const { createApp, connectMongo } = require('../server');
const { grantCards, upsertCardDefinition } = require('../cards');

let mongo;
const password = 'account-password';
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });

async function fixture(t, uri = mongo.getUri()) {
  const store = await connectMongo({ uri, dbName: `accounts_${crypto.randomBytes(5).toString('hex')}` });
  t.after(() => store.client.close());
  const server = createApp(store, { mailer: null, verifyTurnstile: async () => true }).listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, body, cookie, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + route, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, raw,
      data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw.toString()) : null,
      cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { store, api };
}

async function player(api, store, username, balance = 0) {
  const response = await api('/api/register', { username, password });
  assert.equal(response.status, 201);
  const user = await store.users.findOne({ accountId: response.data.user.accountId });
  await store.users.updateOne({ _id: user._id }, { $set: { balance } });
  return { ...response.data.user, id: user._id, cookie: response.cookie };
}
const removeAccount = (api, user) => api('/api/account', { currentPassword: password, confirmation: 'DELETE' }, user.cookie, 'DELETE');
async function image(format = 'png', width = 400, height = 200) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: '#b93828' } }).toFormat(format).toBuffer();
  return `data:image/${format};base64,${bytes.toString('base64')}`;
}
async function trade(api, sender, recipient, joined = true) {
  const created = await api('/api/trades', { recipientAccountId: recipient.accountId, clientOfferId: crypto.randomUUID() }, sender.cookie);
  assert.equal(created.status, 201);
  if (!joined) return created.data.trade;
  const accepted = await api(`/api/trades/${created.data.trade.id}/join`, {}, recipient.cookie);
  assert.equal(accepted.status, 200);
  return accepted.data.trade;
}

test('avatars are sanitized, persisted, public by account ID, and reflected in chat and presence', async t => {
  const { api, store } = await fixture(t);
  const owner = await player(api, store, 'avatar_owner');
  const other = await player(api, store, 'avatar_partner');
  assert.equal(owner.avatarUrl, '/favicon.svg');
  assert.equal((await api('/api/account/avatar', { imageDataUrl: await image() }, null, 'PUT')).status, 401);
  const uploaded = await api('/api/account/avatar', { imageDataUrl: await image() }, owner.cookie, 'PUT');
  assert.equal(uploaded.status, 200);
  const url = uploaded.data.user.avatarUrl;
  assert.match(url, /^\/api\/avatars\/PPR-.*\?v=/);
  assert.ok(!JSON.stringify(uploaded.data).includes('avatarData'));
  const picture = await api(url);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/webp');
  assert.equal(picture.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(picture.headers.get('cache-control'), 'no-store');
  const metadata = await sharp(picture.raw).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height, metadata.exif], ['webp', 256, 256, undefined]);
  const saved = await store.users.findOne({ _id: owner.id });
  assert.ok(saved.avatarData);
  assert.equal((await api('/api/me', undefined, owner.cookie)).data.user.avatarUrl, url);
  assert.equal((await api(`/api/profiles/${owner.username}`)).data.profile.avatarUrl, url);
  const sent = await api('/api/chat', { text: 'Avatar message' }, owner.cookie);
  assert.equal(sent.data.message.avatarUrl, url);
  const reply = await api('/api/chat', { text: 'Avatar reply', replyToId: sent.data.message.id }, other.cookie);
  assert.equal(reply.data.message.replyTo.avatarUrl, url);
  const active = await api('/api/presence', {}, owner.cookie);
  assert.deepEqual(active.data, { count: 1, players: [{ accountId: owner.accountId, username: owner.username, avatarUrl: url, role: 'player', banned: false, protectedAdmin: false }] });
  const room = await trade(api, owner, other);
  const privateMessage = await api(`/api/trades/${room.id}/messages`, { body: 'Private avatar', clientMessageId: crypto.randomUUID() }, owner.cookie);
  assert.equal(privateMessage.data.message.sender.avatarUrl, url);
  assert.equal((await api(`/api/trades/${room.id}`, undefined, other.cookie)).data.trade.sender.avatarUrl, url);
  for (const format of ['jpeg', 'webp']) {
    const changed = await api('/api/account/avatar', { imageDataUrl: await image(format) }, owner.cookie, 'PUT');
    assert.equal(changed.status, 200); assert.notEqual(changed.data.user.avatarUrl, url);
  }
  const reset = await api('/api/account/avatar', {}, owner.cookie, 'DELETE');
  assert.equal(reset.status, 200); assert.equal(reset.data.user.avatarUrl, '/favicon.svg');
  assert.equal((await api(url)).status, 404);
  assert.equal((await api('/api/chat')).data.messages[0].avatarUrl, '/favicon.svg');
});

test('avatar uploads reject spoofed, malformed, animated, huge, and unsupported images without replacing the picture', async t => {
  const { api, store } = await fixture(t);
  const owner = await player(api, store, 'avatar_validation');
  const good = await api('/api/account/avatar', { imageDataUrl: await image() }, owner.cookie, 'PUT');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>').toString('base64');
  const png = await image();
  const frames = await Promise.all(['#ff0000', '#0000ff'].map(background =>
    sharp({ create: { width: 4, height: 4, channels: 3, background } }).png().toBuffer()));
  const animation = await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  const invalid = [null, 'https://example.com/picture.png', `data:image/svg+xml;base64,${svg}`, `data:image/png;base64,${svg}`,
    'data:image/png;base64,not-base64!', png.replace('image/png', 'image/jpeg'),
    `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}`, await image('png', 5000, 4000),
    `data:image/webp;base64,${animation.toString('base64')}`];
  for (const imageDataUrl of invalid) assert.equal((await api('/api/account/avatar', { imageDataUrl }, owner.cookie, 'PUT')).status, 400);
  assert.equal((await api('/api/account/avatar', { imageDataUrl: 'x'.repeat(3 * 1024 * 1024) }, owner.cookie, 'PUT')).status, 413);
  assert.equal((await api('/api/me', undefined, owner.cookie)).data.user.avatarUrl, good.data.user.avatarUrl);
  assert.equal((await api('/api/avatars/invalid')).status, 404);
});

test('presence exposes only distinct current players and excludes orphan sessions', async t => {
  const { api, store } = await fixture(t);
  const zed = await player(api, store, 'Zed_player');
  const alpha = await player(api, store, 'alpha_player');
  const extra = await api('/api/login', { identifier: zed.username, password });
  await api('/api/presence', {}, zed.cookie); await api('/api/presence', {}, extra.cookie); await api('/api/presence', {}, alpha.cookie);
  await store.sessions.insertOne({ _id: crypto.randomBytes(32).toString('hex'), userId: new ObjectId(), expiresAt: new Date(Date.now() + 60000), lastSeenAt: new Date() });
  const online = (await api('/api/presence')).data;
  assert.equal(online.count, 2);
  assert.deepEqual(online.players.map(user => user.username), ['alpha_player', 'Zed_player']);
  for (const user of online.players) assert.deepEqual(Object.keys(user).sort(), ['accountId', 'avatarUrl', 'banned', 'protectedAdmin', 'role', 'username']);
});

test('deletion requires authentication, password, and explicit confirmation before changing anything', async t => {
  const { api, store } = await fixture(t);
  const owner = await player(api, store, 'delete_password');
  assert.equal((await api('/api/account', { currentPassword: password, confirmation: 'DELETE' }, null, 'DELETE')).status, 401);
  assert.equal((await api('/api/account', { currentPassword: password }, owner.cookie, 'DELETE')).status, 400);
  assert.equal((await api('/api/account', { currentPassword: 'wrong-password', confirmation: 'DELETE' }, owner.cookie, 'DELETE')).status, 403);
  assert.equal((await api('/api/me', undefined, owner.cookie)).data.user.accountId, owner.accountId);
  assert.ok(await store.users.findOne({ _id: owner.id }));
});

test('deletion removes owned data, revokes sessions, cancels requests, and preserves the partner’s completed trade', async t => {
  const { api, store } = await fixture(t);
  const owner = await player(api, store, 'delete_owner', 30);
  const other = await player(api, store, 'delete_partner', 10);
  const extra = await api('/api/login', { identifier: owner.username, password });
  const upload = await api('/api/account/avatar', { imageDataUrl: await image() }, owner.cookie, 'PUT');
  await api('/api/presence', {}, owner.cookie);
  await upsertCardDefinition(store, { id: 'pepper_delete', name: 'Pepper' });
  const grant = await grantCards(store, { ownerAccountId: owner.accountId, cardIds: ['pepper_delete', 'pepper_delete'], grantId: crypto.randomUUID() });
  const pending = await trade(api, other, owner, false);
  const active = await trade(api, owner, other);
  await api(`/api/trades/${active.id}/messages`, { body: 'Private original', clientMessageId: crypto.randomUUID() }, owner.cookie);
  let completed = await trade(api, owner, other);
  completed = (await api(`/api/trades/${completed.id}/contribution`, { tokens: 5, cardIds: [grant.cardInstanceIds[0]], version: completed.version }, owner.cookie)).data.trade;
  await api(`/api/trades/${completed.id}/confirm`, { version: completed.version }, owner.cookie);
  assert.equal((await api(`/api/trades/${completed.id}/confirm`, { version: completed.version }, other.cookie)).data.trade.status, 'accepted');
  const parent = await api('/api/chat', { text: 'Public original' }, owner.cookie);
  const reply = await api('/api/chat', { text: 'Keep my reply', replyToId: parent.data.message.id }, other.cookie);
  await store.verificationTokens.insertOne({ _id: crypto.randomBytes(32).toString('hex'), userId: owner.id, purpose: 'login', expiresAt: new Date(Date.now() + 60000) });
  const deleted = await removeAccount(api, owner);
  assert.equal(deleted.status, 200); assert.equal(deleted.cookie, 'pepper_session=');
  assert.equal(await store.users.findOne({ _id: owner.id }), null);
  assert.equal(await store.sessions.countDocuments({ userId: owner.id }), 0);
  assert.equal(await store.verificationTokens.countDocuments({ userId: owner.id }), 0);
  assert.equal(await store.cardInstances.countDocuments({ ownerUserId: owner.id }), 0);
  assert.equal(await store.cardInstances.countDocuments({ ownerUserId: other.id }), 1);
  assert.equal(await store.cardGrants.countDocuments({ _id: grant.grantId }), 1);
  assert.equal((await api('/api/me', undefined, owner.cookie)).data.user, null);
  assert.equal((await api('/api/me', undefined, extra.cookie)).data.user, null);
  assert.equal((await api(`/api/profiles/${owner.username}`)).status, 404);
  assert.equal((await api(upload.data.user.avatarUrl)).status, 404);
  assert.equal((await api('/api/presence')).data.count, 0);
  for (const id of [active.id, pending.id]) assert.equal((await api(`/api/trades/${id}`, undefined, other.cookie)).data.trade.status, 'cancelled');
  const history = (await api(`/api/trades/${completed.id}`, undefined, other.cookie)).data.trade;
  assert.equal(history.status, 'accepted'); assert.equal(history.sender.username, 'Deleted player');
  assert.equal(history.offeredTokens, 5); assert.equal(history.offeredCards.length, 1);
  const chat = (await api('/api/chat')).data.messages;
  assert.equal(chat.length, 1); assert.equal(chat[0].id, reply.data.message.id);
  assert.equal(chat[0].replyTo.username, 'Deleted player'); assert.equal(chat[0].replyTo.text, 'Message deleted.'); assert.equal(chat[0].replyTo.available, false);
  const privateHistory = (await api(`/api/trades/${active.id}/messages`, undefined, other.cookie)).data.messages[0];
  assert.equal(privateHistory.sender.username, 'Deleted player'); assert.equal(privateHistory.body, 'Message deleted.');
  const replacement = await player(api, store, owner.username);
  assert.notEqual(replacement.accountId, owner.accountId);
  assert.equal((await api(`/api/trades/${active.id}`, undefined, replacement.cookie)).status, 404);
  assert.equal((await api(`/api/trades/${active.id}`, undefined, other.cookie)).data.trade.sender.username, 'Deleted player');
});

test('a request paused after reading its recipient cannot survive recipient deletion', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'race_sender');
  const recipient = await player(api, store, 'race_recipient');
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const original = store.users.findOne.bind(store.users);
  let paused = false;
  store.users.findOne = async (query, ...args) => {
    const value = await original(query, ...args);
    if (!paused && query.accountId === recipient.accountId) { paused = true; reached(); await blocked; }
    return value;
  };
  t.after(() => { store.users.findOne = original; release(); });
  const creating = api('/api/trades', { recipientAccountId: recipient.accountId, clientOfferId: crypto.randomUUID() }, sender.cookie);
  await waiting;
  assert.equal((await removeAccount(api, recipient)).status, 200);
  release();
  assert.equal((await creating).status, 409);
  assert.equal(await store.trades.countDocuments(), 0);
});

test('a reply paused after reading an author cannot restore deleted text', async t => {
  const { api, store } = await fixture(t);
  const author = await player(api, store, 'race_author');
  const writer = await player(api, store, 'race_writer');
  const parent = await api('/api/chat', { text: 'Delete this original' }, author.cookie);
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const original = store.users.findOne.bind(store.users);
  let paused = false;
  store.users.findOne = async (query, ...args) => {
    const value = await original(query, ...args);
    if (!paused && query._id?.equals(author.id) && args[0]?.projection?.username) { paused = true; reached(); await blocked; }
    return value;
  };
  t.after(() => { store.users.findOne = original; release(); });
  const sending = api('/api/chat', { text: 'Delayed reply', replyToId: parent.data.message.id }, writer.cookie);
  await waiting;
  assert.equal((await removeAccount(api, author)).status, 200);
  release();
  assert.equal((await sending).status, 409);
  assert.equal(await store.messages.countDocuments(), 0);
});

test('deletion and final trade confirmation serialize without partial transfers', async t => {
  const { api, store } = await fixture(t);
  const sender = await player(api, store, 'race_final_sender', 25);
  const recipient = await player(api, store, 'race_final_recipient', 10);
  let room = await trade(api, sender, recipient);
  room = (await api(`/api/trades/${room.id}/contribution`, { tokens: 7, cardIds: [], version: room.version }, sender.cookie)).data.trade;
  await api(`/api/trades/${room.id}/confirm`, { version: room.version }, sender.cookie);
  const [deleted, confirmed] = await Promise.all([removeAccount(api, sender), api(`/api/trades/${room.id}/confirm`, { version: room.version }, recipient.cookie)]);
  assert.equal(deleted.status, 200); assert.ok([200, 409].includes(confirmed.status));
  const saved = await store.trades.findOne({ _id: new ObjectId(room.id) });
  const remaining = await store.users.findOne({ _id: recipient.id });
  assert.ok(['cancelled', 'accepted'].includes(saved.status));
  assert.equal(remaining.balance, saved.status === 'accepted' ? 17 : 10);
  assert.equal(await store.users.findOne({ _id: sender.id }), null);
});

test('standalone MongoDB refuses deletion without partially removing account data', async t => {
  const standalone = await MongoMemoryServer.create();
  t.after(() => standalone.stop());
  const { api, store } = await fixture(t, standalone.getUri());
  const owner = await player(api, store, 'standalone_delete', 15);
  assert.equal((await removeAccount(api, owner)).status, 503);
  assert.equal((await api('/api/me', undefined, owner.cookie)).data.user.accountId, owner.accountId);
  assert.equal((await store.users.findOne({ _id: owner.id })).balance, 15);
  assert.equal(await store.sessions.countDocuments({ userId: owner.id }), 1);
});
