const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp, connectMongo } = require('../server');

let mongo;
const password = 'news-test-password';
const publicFields = ['accountId', 'avatarUrl', 'banned', 'protectedAdmin', 'role', 'username'];
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });
function apiFor(t, store, options = {}) {
  const server = createApp(store, { mailer: null, ...options }).listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (route, body, cookie, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], retryAfter: response.headers.get('retry-after') };
  };
}
async function fixture(t) {
  const store = await connectMongo({ uri: mongo.getUri(), dbName: `news_${crypto.randomBytes(4).toString('hex')}` });
  t.after(() => store.client.close());
  let now = Date.now();
  const api = apiFor(t, store, { now: () => now });
  const player = async username => {
    const response = await api('/api/register', { username, password });
    assert.equal(response.status, 201);
    const user = await store.users.findOne({ accountId: response.data.user.accountId });
    return { ...response.data.user, id: user._id, cookie: response.cookie };
  };
  const admin = await player('675'), mod = await player('news_mod'), peerMod = await player('news_peer_mod'), member = await player('news_member'), other = await player('news_other');
  await store.users.updateMany({ _id: { $in: [mod.id, peerMod.id] } }, { $set: { role: 'mod' } });
  const publish = async (kind = 'announcements', author = admin) => {
    const response = await api(`/api/${kind}`, { title: 'News', description: 'Details', ...(kind === 'changelog' ? { version: '0.8.0-1' } : {}) }, author.cookie);
    assert.equal(response.status, 201);
    return response.data.entry;
  };
  const comment = (kind, entryId, actor = member, text = 'A comment', clientMessageId = crypto.randomUUID()) => api(`/api/${kind}/${entryId}/comments`, { text, clientMessageId }, actor.cookie);
  const remove = (kind, entryId, commentId, actor = member) => api(`/api/${kind}/${entryId}/comments/${commentId}`, undefined, actor.cookie, 'DELETE');
  return { store, api, admin, mod, peerMod, member, other, player, publish, comment, remove, advance: ms => { now += ms; } };
}

test('news entries expose only current public author identities and safe legacy fallbacks', async t => {
  const { store, api, admin, mod, publish } = await fixture(t);
  const announcement = await publish('announcements', mod), release = await publish('changelog');
  assert.equal(announcement.author.role, 'mod'); assert.equal(release.author.role, 'admin');
  assert.deepEqual(Object.keys(announcement.author).sort(), publicFields);
  assert.deepEqual(Object.keys(release.author).sort(), publicFields);
  await store.users.updateOne({ _id: mod.id }, { $set: { username: 'RenamedMod', usernameKey: 'renamedmod', avatarVersion: 'new', banned: true } });
  const current = (await api('/api/announcements')).data.entries[0];
  assert.equal(current.author.username, 'RenamedMod'); assert.equal(current.author.banned, true);
  assert.match(current.author.avatarUrl, /\?v=new$/);
  await store.changelog.insertOne({ title: 'Legacy', description: 'Old', version: '0.1.0', createdAt: new Date(0) });
  const legacy = (await api('/api/changelog')).data.entries.at(-1);
  assert.deepEqual(legacy.author, { username: 'Unknown author', accountId: null, avatarUrl: '/favicon.svg', role: 'player', banned: false, protectedAdmin: false });
  assert.equal(legacy.commentCount, 0);
  assert.equal(legacy.version, '0.1.0-0');
  assert.equal((await api('/api/me', undefined, admin.cookie)).data.user.role, 'admin');
});

test('both news sections allow signed-in comments and public reads while validating parent and message input', async t => {
  const { api, member, publish, comment, advance } = await fixture(t);
  for (const kind of ['announcements', 'changelog']) {
    const entry = await publish(kind);
    const route = `/api/${kind}/${entry.id}/comments`;
    assert.deepEqual((await api(route)).data, { comments: [], nextCursor: null });
    assert.equal((await api(route, { text: 'Hello', clientMessageId: crypto.randomUUID() })).status, 401);
    for (const text of ['', '  ', 12, null, 'a'.repeat(1001)]) assert.equal((await comment(kind, entry.id, member, text)).status, 400);
    assert.equal((await comment(kind, entry.id, member, 'Valid', 'bad')).status, 400);
    const posted = await comment(kind, entry.id, member, '  Hello everyone  ');
    assert.equal(posted.status, 201);
    assert.equal(posted.data.comment.text, 'Hello everyone');
    assert.equal(posted.data.comment.deleted, false);
    assert.deepEqual(Object.keys(posted.data.comment.author).sort(), publicFields);
    assert.deepEqual((await api(route)).data.comments, [posted.data.comment]);
    assert.equal((await api(`/api/${kind}`)).data.entries[0].commentCount, 1);
    assert.equal((await api(`/api/${kind}/bad/comments`)).status, 400);
    assert.equal((await comment(kind, new ObjectId().toString())).status, 404);
    advance(1000);
  }
});

test('comment retries and overlapping sends are idempotent with account and entry scoped UUIDs', async t => {
  const { api, store, member, other, publish, comment, advance } = await fixture(t);
  const entry = await publish(), next = await publish(), clientId = crypto.randomUUID();
  const results = await Promise.all([comment('announcements', entry.id, member, 'Hello', clientId), comment('announcements', entry.id, member, 'Hello', clientId)]);
  assert.ok(results.every(result => [200, 201].includes(result.status)));
  assert.equal(new Set(results.map(result => result.data.comment.id)).size, 1);
  assert.equal(await store.newsComments.countDocuments(), 1);
  assert.equal((await comment('announcements', entry.id, member, 'Changed', clientId)).status, 409);
  assert.equal((await comment('announcements', entry.id, other, 'Other', clientId)).status, 201);
  advance(1000);
  assert.equal((await comment('announcements', next.id, member, 'Another entry', clientId)).status, 201);
  assert.equal((await api(`/api/announcements/${entry.id}/comments`)).data.comments.length, 2);
});

test('comment cooldown returns retry timing and a deleted receipt cannot resurrect its original text', async t => {
  const { api, member, publish, comment, remove, advance } = await fixture(t);
  const entry = await publish(), clientId = crypto.randomUUID();
  const first = await comment('announcements', entry.id, member, 'Original', clientId);
  const fast = await comment('announcements', entry.id, member, 'Next');
  assert.equal(fast.status, 429); assert.equal(fast.retryAfter, '1'); assert.equal(fast.data.retryAfterMs, 1000);
  advance(fast.data.retryAfterMs);
  assert.equal((await comment('announcements', entry.id, member, 'Next')).status, 201);
  const removed = await remove('announcements', entry.id, first.data.comment.id);
  assert.equal(removed.status, 200); assert.equal(removed.data.comment.deleted, true);
  assert.equal(removed.data.comment.text, 'Comment deleted.');
  const replay = await comment('announcements', entry.id, member, 'Original', clientId);
  assert.equal(replay.status, 200); assert.deepEqual(replay.data, removed.data);
  assert.equal((await api('/api/announcements')).data.entries[0].commentCount, 1);
});

test('comment pages remain stable across tied timestamps, tombstones, and newly appended comments', async t => {
  const { api, store, member, publish, remove } = await fixture(t);
  const entry = await publish(), at = new Date();
  const seeded = Array.from({ length: 105 }, (_, i) => ({ _id: new ObjectId(), kind: 'announcements', entryId: new ObjectId(entry.id), authorUserId: member.id,
    authorAccountId: member.accountId, clientMessageId: crypto.randomUUID(), text: `Comment ${i}`, createdAt: at, deleted: false }));
  await store.newsComments.insertMany(seeded);
  const first = (await api(`/api/announcements/${entry.id}/comments`)).data;
  assert.equal(first.comments.length, 50); assert.ok(first.nextCursor);
  assert.deepEqual(first.comments.map(row => row.id), seeded.slice(0, 50).map(row => row._id.toString()));
  await remove('announcements', entry.id, seeded[55]._id.toString());
  const second = (await api(`/api/announcements/${entry.id}/comments?cursor=${first.nextCursor}`)).data;
  assert.equal(second.comments.length, 50); assert.equal(second.comments[5].deleted, true);
  assert.ok(second.nextCursor);
  const final = (await api(`/api/announcements/${entry.id}/comments?cursor=${second.nextCursor}`)).data;
  assert.equal(final.comments.length, 5); assert.equal(final.nextCursor, null);
  assert.equal(new Set([...first.comments, ...second.comments, ...final.comments].map(row => row.id)).size, 105);
  await store.newsComments.insertOne({ ...seeded[0], _id: new ObjectId(), clientMessageId: crypto.randomUUID(), text: 'Newest', createdAt: new Date(at.getTime() + 1) });
  const withNew = (await api(`/api/announcements/${entry.id}/comments?cursor=${second.nextCursor}`)).data;
  assert.equal(withNew.comments.at(-1).text, 'Newest');
  for (const cursor of ['bad!', 'e30', Buffer.from(JSON.stringify(['bad', seeded[0]._id])).toString('base64url')]) {
    assert.equal((await api(`/api/announcements/${entry.id}/comments?cursor=${cursor}`)).status, 400);
  }
});

test('comment deletion permits owners and enforces the staff hierarchy for other authors', async t => {
  const { api, admin, mod, peerMod, member, other, publish, comment, remove } = await fixture(t);
  const entry = await publish('changelog');
  const byMember = (await comment('changelog', entry.id, member)).data.comment;
  const byOther = (await comment('changelog', entry.id, other)).data.comment;
  const byMod = (await comment('changelog', entry.id, mod)).data.comment;
  const byPeer = (await comment('changelog', entry.id, peerMod)).data.comment;
  const byAdmin = (await comment('changelog', entry.id, admin)).data.comment;
  assert.equal((await remove('changelog', entry.id, byMember.id, other)).status, 403);
  assert.equal((await remove('changelog', entry.id, byMember.id, member)).status, 200);
  assert.equal((await remove('changelog', entry.id, byOther.id, mod)).status, 200);
  assert.equal((await remove('changelog', entry.id, byMod.id, mod)).status, 200);
  assert.equal((await remove('changelog', entry.id, byPeer.id, mod)).status, 403);
  assert.equal((await remove('changelog', entry.id, byAdmin.id, mod)).status, 403);
  assert.equal((await remove('changelog', entry.id, byPeer.id, admin)).status, 200);
  assert.equal((await remove('changelog', entry.id, byAdmin.id, admin)).status, 200);
  assert.equal((await api('/api/changelog')).data.entries[0].commentCount, 0);
  assert.equal((await remove('changelog', entry.id, byMember.id, member)).status, 200);
  assert.equal((await api(`/api/changelog/${entry.id}/comments/${byMember.id}`, undefined, undefined, 'DELETE')).status, 401);
});

test('senior moderators delete comments by players and mods but preserve senior and admin comments', async t => {
  const { api, store, admin, mod, member, player, publish, remove, advance } = await fixture(t);
  advance(15 * 60 * 1000 + 1);
  const senior = await player('comment_senior'), peer = await player('comment_senior_peer'), delegated = await player('comment_admin');
  for (const [target, role] of [[senior, 'senior_mod'], [peer, 'senior_mod'], [delegated, 'admin']]) {
    const assigned = await api(`/api/moderation/players/${target.accountId}`, { role }, admin.cookie, 'PATCH');
    assert.equal(assigned.status, 200);
  }
  for (const kind of ['announcements', 'changelog']) {
    const entry = await publish(kind);
    const rows = new Map();
    // Seed tied-time comments to keep this authorization matrix independent of send cooldowns.
    for (const author of [member, mod, senior, peer, delegated, admin]) {
      const row = { _id: new ObjectId(), kind, entryId: new ObjectId(entry.id), authorUserId: author.id, authorAccountId: author.accountId,
        clientMessageId: crypto.randomUUID(), text: `${author.username} comment`, createdAt: new Date(), deleted: false };
      await store.newsComments.insertOne(row); rows.set(author, row._id.toString());
    }
    assert.equal((await remove(kind, entry.id, rows.get(senior), mod)).status, 403);
    for (const author of [peer, delegated, admin]) assert.equal((await remove(kind, entry.id, rows.get(author), senior)).status, 403);
    for (const author of [member, mod, senior]) assert.equal((await remove(kind, entry.id, rows.get(author), senior)).status, 200);
    for (const author of [peer, delegated, admin]) assert.equal((await remove(kind, entry.id, rows.get(author), delegated)).status, 200);
    assert.equal((await api(`/api/${kind}`)).data.entries.find(item => item.id === entry.id).commentCount, 0);
  }
});

test('comment identities use current names, pictures, roles and bans and banned authors cannot post', async t => {
  const { api, store, member, publish, comment } = await fixture(t);
  const entry = await publish(), posted = await comment('announcements', entry.id);
  await store.users.updateOne({ _id: member.id }, { $set: { username: 'Changed', usernameKey: 'changed', role: 'mod', avatarVersion: 'new', banned: true } });
  const current = (await api(`/api/announcements/${entry.id}/comments`)).data.comments[0];
  assert.equal(current.id, posted.data.comment.id); assert.equal(current.author.username, 'Changed');
  assert.equal(current.author.role, 'mod'); assert.equal(current.author.banned, true); assert.match(current.author.avatarUrl, /\?v=new$/);
  const blocked = await comment('announcements', entry.id);
  assert.equal(blocked.status, 403); assert.equal(blocked.data.banned, true);
});

test('unseen announcements persist per account and own publications are immediately marked seen', async t => {
  const { api, store, admin, member, other, publish } = await fixture(t);
  const first = await publish(), second = await publish();
  assert.equal((await api('/api/announcements/unseen')).status, 401);
  assert.deepEqual((await api('/api/announcements/unseen', undefined, admin.cookie)).data, { entries: [] });
  const unseen = (await api('/api/announcements/unseen', undefined, member.cookie)).data.entries;
  assert.deepEqual(unseen.map(entry => entry.id), [second.id, first.id]);
  assert.deepEqual(Object.keys(unseen[0].author).sort(), publicFields);
  const route = `/api/announcements/${second.id}/seen`;
  assert.equal((await api(route, {})).status, 401);
  assert.deepEqual((await api(route, {}, member.cookie)).data, { ok: true });
  assert.equal((await api(route, {}, member.cookie)).status, 200);
  assert.equal(await store.announcementSeen.countDocuments({ userId: member.id }), 1);
  assert.deepEqual((await api('/api/announcements/unseen', undefined, member.cookie)).data.entries.map(entry => entry.id), [first.id]);
  assert.equal((await api('/api/announcements/unseen', undefined, other.cookie)).data.entries.length, 2);
  const restarted = await connectMongo({ uri: mongo.getUri(), dbName: store.db.databaseName });
  t.after(() => restarted.client.close());
  assert.deepEqual((await apiFor(t, restarted)('/api/announcements/unseen', undefined, member.cookie)).data.entries.map(entry => entry.id), [first.id]);
  assert.equal((await api(`/api/announcements/${new ObjectId()}/seen`, {}, member.cookie)).status, 404);
  assert.equal((await api('/api/announcements/bad/seen', {}, member.cookie)).status, 400);
});

test('deleting a news parent removes comments and seen receipts atomically and preserves other entries', async t => {
  const { api, store, admin, member, publish, comment, advance } = await fixture(t);
  const announcement = await publish(), release = await publish('changelog'), kept = await publish();
  await comment('announcements', announcement.id); advance(1000);
  await comment('changelog', release.id); advance(1000);
  await comment('announcements', kept.id);
  await api(`/api/announcements/${announcement.id}/seen`, {}, member.cookie);
  assert.equal((await api(`/api/announcements/${announcement.id}`, undefined, admin.cookie, 'DELETE')).status, 200);
  assert.equal(await store.announcementSeen.countDocuments({ entryId: new ObjectId(announcement.id) }), 0);
  assert.equal(await store.newsComments.countDocuments(), 2);
  assert.equal((await api(`/api/changelog/${release.id}`, undefined, admin.cookie, 'DELETE')).status, 200);
  assert.equal(await store.newsComments.countDocuments(), 1);
  assert.equal((await api(`/api/announcements/${announcement.id}/comments`)).status, 404);
});

test('deleting an account tombstones comments, removes seen state, and preserves another author content', async t => {
  const { api, store, member, other, publish, comment } = await fixture(t);
  const entry = await publish();
  await comment('announcements', entry.id, member, 'Private account content');
  await comment('announcements', entry.id, other, 'Keep this');
  await api(`/api/announcements/${entry.id}/seen`, {}, member.cookie);
  assert.equal((await api('/api/account', { confirmation: 'DELETE', currentPassword: password }, member.cookie, 'DELETE')).status, 200);
  assert.equal(await store.announcementSeen.countDocuments({ userId: member.id }), 0);
  const rows = (await api(`/api/announcements/${entry.id}/comments`)).data.comments;
  assert.equal(rows[0].deleted, true); assert.equal(rows[0].text, 'Comment deleted.');
  assert.equal(rows[0].author.username, 'Deleted player'); assert.equal(rows[0].author.accountId, null);
  assert.equal(rows[1].text, 'Keep this');
  assert.equal((await api('/api/announcements')).data.entries[0].commentCount, 1);
  assert.equal((await store.newsComments.findOne({ authorUserId: member.id })).text, '');
});

test('comments racing parent or account deletion do not leave orphan or unredacted content', async t => {
  const { api, store, admin, member, publish, comment } = await fixture(t);
  const entry = await publish();
  const outcomes = await Promise.all([comment('announcements', entry.id), api(`/api/announcements/${entry.id}`, undefined, admin.cookie, 'DELETE')]);
  assert.equal(outcomes[1].status, 200); assert.ok([201, 404].includes(outcomes[0].status));
  assert.equal(await store.newsComments.countDocuments(), 0);
  const next = await publish();
  const more = await Promise.all([comment('announcements', next.id), api('/api/account', { confirmation: 'DELETE', currentPassword: password }, member.cookie, 'DELETE')]);
  assert.equal(more[1].status, 200); assert.ok([201, 401].includes(more[0].status));
  assert.equal(await store.newsComments.countDocuments({ authorUserId: member.id, deleted: { $ne: true } }), 0);
});
