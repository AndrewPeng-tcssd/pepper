const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp, connectMongo } = require('../server');
const { trimChatHistory } = require('../mongo');
const { TURN_MS } = require('../games');

let mongo;
const password = 'moderation-password';
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });
async function fixture(t) {
  const store = await connectMongo({ uri: mongo.getUri(), dbName: `moderation_${crypto.randomBytes(5).toString('hex')}` });
  t.after(() => store.client.close());
  let now = Date.now();
  const server = createApp(store, { mailer: null, now: () => now, verifyTurnstile: async () => true }).listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = async (route, body, cookie, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { store, api, advance: ms => { now += ms; } };
}
async function player(api, store, username, extra = {}) {
  const registered = await api('/api/register', { username, password, ...extra });
  assert.equal(registered.status, 201);
  const user = await store.users.findOne({ accountId: registered.data.user.accountId });
  await store.users.updateOne({ _id: user._id }, { $set: { balance: 100 } });
  return { ...registered.data.user, id: user._id, cookie: registered.cookie };
}
const patch = (api, actor, target, body) => api(`/api/moderation/players/${target.accountId}`, body, actor.cookie, 'PATCH');
async function staff(api, store) {
  const admin = await player(api, store, '675');
  const mod = await player(api, store, 'test_mod');
  assert.equal((await patch(api, admin, mod, { role: 'mod' })).status, 200);
  return { admin, mod };
}
const balances = (store, ...players) => Promise.all(players.map(async person => (await store.users.findOne({ _id: person.id })).balance));
async function match(api, sender, recipient, active = true) {
  const created = await api('/api/games', { recipientAccountId: recipient.accountId, game: 'tic-tac-toe', stake: 10, clientRequestId: crypto.randomUUID() }, sender.cookie);
  assert.equal(created.status, 201);
  if (!active) return created.data.game;
  const accepted = await api(`/api/games/${created.data.game.id}/accept`, {}, recipient.cookie);
  assert.equal(accepted.status, 200);
  return accepted.data.game;
}

test('roles cannot be supplied at signup, staff lookup is private, and public identities include role tags', async t => {
  const { api, store } = await fixture(t);
  const { admin, mod } = await staff(api, store);
  const ordinary = await player(api, store, 'ordinary', { role: 'admin', banned: false, protectedAdmin: true });
  assert.equal((await api('/api/me', undefined, admin.cookie)).data.user.role, 'admin');
  assert.equal((await api('/api/me', undefined, mod.cookie)).data.user.role, 'mod');
  assert.equal((await api('/api/me', undefined, ordinary.cookie)).data.user.role, 'player');
  assert.equal((await api('/api/me', undefined, ordinary.cookie)).data.user.protectedAdmin, false);
  assert.equal((await api('/api/me', undefined, admin.cookie)).data.user.protectedAdmin, true);
  assert.equal((await api('/api/moderation/players')).status, 401);
  assert.equal((await api('/api/moderation/players', undefined, ordinary.cookie)).status, 403);
  const lookup = await api('/api/moderation/players?username=ordi', undefined, mod.cookie);
  assert.equal(lookup.status, 200);
  assert.deepEqual(lookup.data.players.map(user => user.accountId), [ordinary.accountId]);
  assert.deepEqual(Object.keys(lookup.data.players[0]).sort(), ['accountId', 'avatarUrl', 'banned', 'protectedAdmin', 'role', 'username']);
  assert.equal((await api(`/api/profiles/${mod.username}`)).data.profile.role, 'mod');
  assert.equal((await api('/api/leaderboard')).data.entries.find(entry => entry.accountId === admin.accountId).role, 'admin');
  await api('/api/presence', {}, mod.cookie);
  assert.equal((await api('/api/presence')).data.players[0].role, 'mod');
  const game = await match(api, mod, ordinary);
  assert.equal(game.sender.role, 'mod'); assert.equal(game.recipient.role, 'player');
});

test('administrators assign staff roles while moderators cannot sanction staff', async t => {
  const { api, store } = await fixture(t);
  const { admin, mod } = await staff(api, store);
  const ordinary = await player(api, store, 'hierarchy_player');
  const peer = await player(api, store, 'hierarchy_peer');
  assert.equal((await patch(api, admin, peer, { role: 'mod' })).status, 200);
  assert.equal((await patch(api, mod, ordinary, { role: 'mod' })).status, 403);
  assert.equal((await patch(api, ordinary, ordinary, { role: 'mod' })).status, 403);
  assert.equal((await patch(api, admin, ordinary, { role: 'admin' })).status, 200);
  assert.equal((await api('/api/me', undefined, ordinary.cookie)).data.user.role, 'admin');
  assert.equal((await patch(api, admin, ordinary, { role: 'mod', banned: true })).status, 400);
  for (const target of [admin, peer, mod]) assert.equal((await patch(api, mod, target, { banned: true })).status, 403);
  assert.equal((await patch(api, admin, admin, { banned: true })).status, 403);
  assert.equal((await patch(api, admin, admin, { role: 'player' })).status, 403);
  assert.equal((await patch(api, admin, peer, { role: 'player' })).status, 200);
  assert.equal((await patch(api, mod, peer, { banned: true })).status, 200);
});

test('administrator identity survives renames and cannot be reclaimed through the original username', async t => {
  const { api, store } = await fixture(t);
  const { admin, mod } = await staff(api, store);
  const renamed = await api('/api/account/username', { username: 'renamed_admin', currentPassword: password }, admin.cookie, 'PATCH');
  assert.equal(renamed.status, 200); assert.equal(renamed.data.user.role, 'admin');
  assert.equal(renamed.data.user.protectedAdmin, true);
  const replacement = await player(api, store, '675');
  assert.equal(replacement.role, 'player');
  assert.equal(replacement.protectedAdmin, false);
  assert.equal((await patch(api, replacement, mod, { banned: true })).status, 403);
  assert.equal((await api('/api/me', undefined, admin.cookie)).data.user.role, 'admin');
  assert.equal((await patch(api, admin, mod, { role: 'player' })).status, 200);
});

test('delegated administrators grant every staff role and cannot change or ban the permanent owner', async t => {
  const { api, store } = await fixture(t);
  const { admin: owner, mod } = await staff(api, store);
  const delegated = await player(api, store, 'delegated_admin');
  const target = await player(api, store, 'staff_target');
  assert.equal((await patch(api, owner, delegated, { role: 'admin' })).status, 200);
  const identity = (await api('/api/me', undefined, delegated.cookie)).data.user;
  assert.equal(identity.role, 'admin'); assert.equal(identity.protectedAdmin, false);
  for (const role of ['mod', 'senior_mod', 'admin', 'player']) {
    const result = await patch(api, delegated, target, { role });
    assert.equal(result.status, 200); assert.equal(result.data.player.role, role);
    assert.equal(result.data.player.protectedAdmin, false);
    assert.equal((await store.users.findOne({ _id: target.id })).role, role);
  }
  for (const role of ['moderator', 'senior', 'owner', '', null]) assert.equal((await patch(api, delegated, target, { role })).status, 400);
  for (const role of ['player', 'mod', 'senior_mod', 'admin']) {
    assert.equal((await patch(api, delegated, owner, { role })).status, 403);
    assert.equal((await patch(api, delegated, delegated, { role })).status, 403);
  }
  for (const banned of [true, false]) {
    assert.equal((await patch(api, delegated, owner, { banned })).status, 403);
    assert.equal((await patch(api, delegated, delegated, { banned })).status, 403);
  }
  const renamed = await api('/api/account/username', { username: 'protected_renamed', currentPassword: password }, owner.cookie, 'PATCH');
  assert.equal(renamed.status, 200); assert.equal(renamed.data.user.protectedAdmin, true);
  const replacement = await player(api, store, '675');
  assert.equal((await patch(api, delegated, replacement, { role: 'mod' })).status, 200);
  assert.equal((await patch(api, delegated, owner, { role: 'player' })).status, 403);
  assert.equal((await patch(api, delegated, owner, { banned: true })).status, 403);
  // A fresh moderation instance resolves only the saved immutable account binding.
  const { createModeration } = require('../moderation');
  const fresh = createModeration(store);
  assert.deepEqual(await fresh.publicFields(await store.users.findOne({ _id: owner.id })), { role: 'admin', banned: false, protectedAdmin: true });
  assert.deepEqual(await fresh.publicFields(await store.users.findOne({ _id: replacement.id })), { role: 'mod', banned: false, protectedAdmin: false });
  assert.equal((await patch(api, delegated, mod, { role: 'player' })).status, 200);
});

test('senior moderators sanction players and mods and only revoke existing mod status', async t => {
  const { api, store, advance } = await fixture(t);
  const { admin, mod } = await staff(api, store);
  const senior = await player(api, store, 'senior_staff');
  const peer = await player(api, store, 'senior_peer');
  const delegated = await player(api, store, 'senior_admin');
  advance(15 * 60 * 1000 + 1);
  const member = await player(api, store, 'senior_member');
  for (const [target, role] of [[senior, 'senior_mod'], [peer, 'senior_mod'], [delegated, 'admin']]) assert.equal((await patch(api, admin, target, { role })).status, 200);
  assert.equal((await api('/api/moderation/players?username=senior', undefined, senior.cookie)).status, 200);
  assert.equal((await api('/api/me', undefined, senior.cookie)).data.user.role, 'senior_mod');
  for (const target of [member, mod]) {
    for (const banned of [true, false]) assert.equal((await patch(api, senior, target, { banned })).status, 200);
  }
  for (const target of [admin, delegated, peer, senior]) {
    assert.equal((await patch(api, senior, target, { banned: true })).status, 403);
    assert.equal((await patch(api, senior, target, { banned: false })).status, 403);
    assert.equal((await patch(api, senior, target, { role: 'player' })).status, 403);
  }
  for (const target of [member, mod]) for (const role of ['mod', 'senior_mod', 'admin']) assert.equal((await patch(api, senior, target, { role })).status, 403);
  assert.equal((await patch(api, senior, member, { role: 'player' })).status, 403);
  assert.equal((await patch(api, mod, peer, { banned: true })).status, 403);
  const revoked = await patch(api, senior, mod, { role: 'player' });
  assert.equal(revoked.status, 200); assert.equal(revoked.data.player.role, 'player');
  assert.equal((await api('/api/moderation/players', undefined, mod.cookie)).status, 403);
  assert.equal((await patch(api, senior, mod, { role: 'player' })).status, 403);
});

test('delegated administrators publish changelogs and update versions while senior mods only publish announcements', async t => {
  const { api, store } = await fixture(t);
  const { admin } = await staff(api, store);
  const delegated = await player(api, store, 'news_delegated');
  const senior = await player(api, store, 'news_senior');
  await patch(api, admin, delegated, { role: 'admin' });
  await patch(api, admin, senior, { role: 'senior_mod' });
  const announcement = await api('/api/announcements', { title: 'Senior notice', description: 'Details.' }, senior.cookie);
  assert.equal(announcement.status, 201); assert.equal(announcement.data.entry.author.role, 'senior_mod');
  assert.equal((await api('/api/changelog', { title: 'Not allowed', description: 'Details.', version: '0.8.1-1' }, senior.cookie)).status, 403);
  assert.equal((await api('/api/version', { version: '0.8.1-1' }, senior.cookie, 'PATCH')).status, 403);
  const changelog = await api('/api/changelog', { title: 'Delegated release', description: 'Details.', version: '0.8.1-1' }, delegated.cookie);
  assert.equal(changelog.status, 201); assert.equal(changelog.data.entry.author.accountId, delegated.accountId);
  assert.equal((await api('/api/version', { version: '0.8.1-2' }, delegated.cookie, 'PATCH')).status, 200);
  assert.equal((await api(`/api/changelog/${changelog.data.entry.id}`, undefined, senior.cookie, 'DELETE')).status, 403);
  assert.equal((await api(`/api/changelog/${changelog.data.entry.id}`, undefined, delegated.cookie, 'DELETE')).status, 200);
  assert.equal((await patch(api, admin, delegated, { role: 'player' })).status, 200);
  assert.equal((await api('/api/version', { version: '0.8.1-3' }, delegated.cookie, 'PATCH')).status, 403);
});

test('banning revokes sessions, closes trades, refunds active games, and preserves names and banned tags', async t => {
  const { api, store } = await fixture(t);
  const { mod } = await staff(api, store);
  const target = await player(api, store, 'ban_target'); const other = await player(api, store, 'ban_partner');
  const extra = await api('/api/login', { identifier: target.username, password });
  const game = await match(api, target, other);
  const created = await api('/api/trades', { recipientAccountId: other.accountId, clientOfferId: crypto.randomUUID() }, target.cookie);
  const trade = created.data.trade;
  assert.equal((await api(`/api/trades/${trade.id}/join`, {}, other.cookie)).status, 200);
  const banned = await patch(api, mod, target, { banned: true });
  assert.equal(banned.status, 200); assert.equal(banned.data.player.banned, true); assert.equal(banned.data.player.username, target.username);
  assert.deepEqual(await balances(store, target, other), [100, 100]);
  const ended = (await api(`/api/games/${game.id}`, undefined, other.cookie)).data.game;
  assert.equal(ended.status, 'cancelled'); assert.equal(ended.sender.username, target.username); assert.equal(ended.sender.banned, true);
  assert.equal((await store.users.findOne({ _id: target.id })).gamePayoutReserve, 0);
  assert.equal((await api(`/api/trades/${trade.id}`, undefined, other.cookie)).data.trade.status, 'cancelled');
  for (const cookie of [target.cookie, extra.cookie]) {
    const me = await api('/api/me', undefined, cookie);
    assert.equal(me.data.user, null); assert.equal(me.data.banned, true);
    const send = await api('/api/chat', { text: 'Blocked', clientMessageId: crypto.randomUUID() }, cookie);
    assert.equal(send.status, 403); assert.equal(send.data.banned, true);
  }
  assert.equal((await api('/api/login', { identifier: target.username, password })).status, 403);
  assert.equal((await api(`/api/profiles/${target.username}`)).data.profile.banned, true);
  assert.equal((await api('/api/games', { recipientAccountId: target.accountId, game: 'tic-tac-toe', stake: 1, clientRequestId: crypto.randomUUID() }, other.cookie)).status, 409);
  assert.equal((await patch(api, mod, target, { banned: false })).status, 200);
  assert.equal((await api('/api/me', undefined, target.cookie)).data.user, null);
  const fresh = await api('/api/login', { identifier: target.username, password });
  assert.equal(fresh.status, 200); assert.equal(fresh.data.user.banned, false);
});

test('banning after a turn deadline preserves the timeout winner and pays only once', async t => {
  let starter;
  t.mock.method(crypto, 'randomInt', max => { assert.equal(max, 2); return starter; });
  for (starter of [0, 1]) {
    const { api, store, advance } = await fixture(t);
    const { mod } = await staff(api, store);
    const target = await player(api, store, `deadline_ban_target_${starter}`); const other = await player(api, store, `deadline_ban_partner_${starter}`);
    const game = await match(api, target, other);
    assert.equal(game.xAccountId, starter === 0 ? target.accountId : other.accountId);
    assert.equal(game.turnAccountId, game.xAccountId);
    const winner = game.turnAccountId === target.accountId ? other : target;
    advance(TURN_MS + 1);
    assert.equal((await patch(api, mod, target, { banned: true })).status, 200);
    assert.equal((await patch(api, mod, target, { banned: true })).status, 200);
    const saved = (await api(`/api/games/${game.id}`, undefined, other.cookie)).data.game;
    assert.equal(saved.status, 'completed'); assert.equal(saved.reason, 'timeout'); assert.equal(saved.winnerAccountId, winner.accountId);
    assert.deepEqual(await balances(store, target, other), winner.accountId === target.accountId ? [110, 90] : [90, 110]);
  }
});

test('chat moderation follows role hierarchy and deleted receipts cannot resurrect messages', async t => {
  const { api, store, advance } = await fixture(t);
  const { admin, mod } = await staff(api, store);
  const ordinary = await player(api, store, 'chat_ordinary'); const other = await player(api, store, 'chat_other');
  const peer = await player(api, store, 'chat_peer');
  await patch(api, admin, peer, { role: 'mod' });
  const receipt = crypto.randomUUID();
  const original = await api('/api/chat', { text: 'Original message', clientMessageId: receipt }, ordinary.cookie);
  const reply = await api('/api/chat', { text: 'Reply', clientMessageId: crypto.randomUUID(), replyToId: original.data.message.id }, other.cookie);
  const adminMessage = await api('/api/chat', { text: 'Administrator post' }, admin.cookie);
  const peerMessage = await api('/api/chat', { text: 'Moderator post' }, peer.cookie);
  const ownMessage = await api('/api/chat', { text: 'Own moderator post' }, mod.cookie);
  const erase = (actor, message) => api(`/api/chat/${message.id}`, undefined, actor.cookie, 'DELETE');
  assert.equal((await erase(ordinary, original.data.message)).status, 403);
  assert.equal((await erase(mod, adminMessage.data.message)).status, 403);
  assert.equal((await erase(mod, peerMessage.data.message)).status, 403);
  assert.equal((await erase(mod, ownMessage.data.message)).status, 200);
  assert.equal((await erase(mod, original.data.message)).status, 200);
  const messages = (await api('/api/chat')).data.messages;
  const tombstone = messages.find(message => message.id === original.data.message.id);
  assert.equal(tombstone.deleted, true); assert.equal(tombstone.text, 'Message deleted.');
  const quoted = messages.find(message => message.id === reply.data.message.id).replyTo;
  assert.equal(quoted.text, 'Message deleted.'); assert.equal(quoted.available, false);
  advance(4000);
  const retried = await api('/api/chat', { text: 'Original message', clientMessageId: receipt }, ordinary.cookie);
  assert.equal(retried.status, 201); assert.equal(retried.data.message.id, original.data.message.id);
  assert.equal(retried.data.message.deleted, true); assert.equal(retried.data.message.text, 'Message deleted.');
  assert.equal(await store.messages.countDocuments({ userId: ordinary.id, clientMessageId: receipt }), 1);
  assert.equal((await erase(admin, peerMessage.data.message)).status, 200);
  await store.messages.insertMany(Array.from({ length: 100 }, (_, index) => ({
    userId: other.id, username: other.username, text: `Newer ${index}`, createdAt: new Date(Date.now() + 60000 + index)
  })));
  await trimChatHistory(store.messages);
  assert.ok(await store.messages.findOne({ _id: new ObjectId(original.data.message.id), deleted: true }));
  assert.equal((await api('/api/chat')).data.messages.some(message => message.id === original.data.message.id), false);
  const oldRetry = await api('/api/chat', { text: 'Original message', clientMessageId: receipt }, ordinary.cookie);
  assert.equal(oldRetry.status, 201); assert.equal(oldRetry.data.message.deleted, true);
  assert.equal(oldRetry.data.message.id, original.data.message.id);
});

test('senior moderators delete player and mod chat messages but cannot delete senior or admin messages', async t => {
  const { api, store, advance } = await fixture(t);
  const { admin, mod } = await staff(api, store);
  const senior = await player(api, store, 'chat_senior');
  const peer = await player(api, store, 'chat_senior_peer');
  const delegated = await player(api, store, 'chat_delegated_admin');
  advance(15 * 60 * 1000 + 1);
  const member = await player(api, store, 'chat_member');
  for (const [target, role] of [[senior, 'senior_mod'], [peer, 'senior_mod'], [delegated, 'admin']]) await patch(api, admin, target, { role });
  const entries = new Map();
  for (const author of [member, mod, senior, peer, delegated, admin]) {
    const response = await api('/api/chat', { text: `${author.username} post`, clientMessageId: crypto.randomUUID() }, author.cookie);
    assert.equal(response.status, 201);
    entries.set(author, response.data.message);
  }
  const erase = (actor, author) => api(`/api/chat/${entries.get(author).id}`, undefined, actor.cookie, 'DELETE');
  assert.equal((await erase(mod, senior)).status, 403);
  for (const author of [peer, delegated, admin]) assert.equal((await erase(senior, author)).status, 403);
  for (const author of [member, mod, senior]) assert.equal((await erase(senior, author)).status, 200);
  // Any administrator may delete posts by any other administrator, including the owner.
  for (const author of [peer, delegated, admin]) assert.equal((await erase(delegated, author)).status, 200);
});

test('moderators publish announcements and delete their own, while administrator can remove any', async t => {
  const { api, store } = await fixture(t);
  const { admin, mod } = await staff(api, store);
  const peer = await player(api, store, 'announcements_peer'); const ordinary = await player(api, store, 'announcements_player');
  await patch(api, admin, peer, { role: 'mod' });
  const publish = (actor, title) => api('/api/announcements', { title, description: 'Test announcement.' }, actor.cookie);
  assert.equal((await publish(ordinary, 'Unauthorized')).status, 403);
  const ownerEntry = await publish(admin, 'Admin'); const modEntry = await publish(mod, 'Mod'); const peerEntry = await publish(peer, 'Peer');
  assert.deepEqual([ownerEntry.status, modEntry.status, peerEntry.status], [201, 201, 201]);
  const erase = (actor, result) => api(`/api/announcements/${result.data.entry.id}`, undefined, actor.cookie, 'DELETE');
  assert.equal((await erase(mod, ownerEntry)).status, 403);
  assert.equal((await erase(mod, peerEntry)).status, 403);
  assert.equal((await erase(mod, modEntry)).status, 200);
  assert.equal((await erase(admin, peerEntry)).status, 200);
  await patch(api, admin, mod, { role: 'player' });
  assert.equal((await publish(mod, 'Demoted')).status, 403);
});

async function pauseFirstUserRead(t, store, user) {
  let release, reached;
  const blocked = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { reached = resolve; });
  const original = store.users.findOne.bind(store.users);
  let paused = false;
  store.users.findOne = async (query, ...args) => {
    const result = await original(query, ...args);
    if (!paused && query._id?.toString() === user.id.toString()) { paused = true; reached(); await blocked; }
    return result;
  };
  t.after(() => { store.users.findOne = original; release(); });
  return { waiting, release };
}

test('a chat request paused during authentication cannot post after its account is banned', async t => {
  const { api, store } = await fixture(t);
  const { mod } = await staff(api, store); const target = await player(api, store, 'inflight_chat');
  const gate = await pauseFirstUserRead(t, store, target);
  const sending = api('/api/chat', { text: 'Must not appear', clientMessageId: crypto.randomUUID() }, target.cookie);
  await gate.waiting;
  assert.equal((await patch(api, mod, target, { banned: true })).status, 200);
  gate.release();
  assert.equal((await sending).status, 403);
  assert.equal(await store.messages.countDocuments({ userId: target.id }), 0);
});

test('a moderator request paused during authentication cannot publish after demotion', async t => {
  const { api, store } = await fixture(t);
  const { admin, mod } = await staff(api, store);
  const gate = await pauseFirstUserRead(t, store, mod);
  const publishing = api('/api/announcements', { title: 'Stale privilege', description: 'Must not publish.' }, mod.cookie);
  await gate.waiting;
  assert.equal((await patch(api, admin, mod, { role: 'player' })).status, 200);
  gate.release();
  assert.equal((await publishing).status, 403);
  assert.equal(await store.announcements.countDocuments(), 0);
});

test('a senior moderation request paused during authentication cannot ban staff after demotion', async t => {
  const { api, store } = await fixture(t);
  const { admin, mod } = await staff(api, store);
  const senior = await player(api, store, 'inflight_senior');
  await patch(api, admin, senior, { role: 'senior_mod' });
  const gate = await pauseFirstUserRead(t, store, senior);
  const banning = patch(api, senior, mod, { banned: true });
  await gate.waiting;
  assert.equal((await patch(api, admin, senior, { role: 'mod' })).status, 200);
  gate.release();
  assert.equal((await banning).status, 403);
  assert.notEqual((await store.users.findOne({ _id: mod.id })).banned, true);
});

test('ban and game acceptance serialize without retaining stakes or active matches', async t => {
  const { api, store } = await fixture(t);
  const { mod } = await staff(api, store);
  const target = await player(api, store, 'ban_race_target'); const other = await player(api, store, 'ban_race_other');
  const game = await match(api, target, other, false);
  const results = await Promise.all([
    api(`/api/games/${game.id}/accept`, {}, other.cookie),
    patch(api, mod, target, { banned: true })
  ]);
  assert.equal(results[1].status, 200); assert.ok([200, 409].includes(results[0].status));
  const saved = await store.games.findOne({ _id: new ObjectId(game.id) });
  assert.equal(saved.status, 'cancelled'); assert.equal(saved.escrowed, false);
  assert.deepEqual(await balances(store, target, other), [100, 100]);
});
