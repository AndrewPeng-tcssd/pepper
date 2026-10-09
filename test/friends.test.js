const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp, connectMongo, CLAIM_INTERVAL_MS } = require('../server');

let mongo;
const password = 'friends-password';
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });
async function fixture(t, options = {}) {
  const store = await connectMongo({ uri: mongo.getUri(), dbName: `friends_${crypto.randomBytes(4).toString('hex')}` });
  t.after(() => store.client.close());
  let now = Date.now();
  const app = createApp(store, { mailer: null, now: () => now, ...options });
  const server = app.listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = async (route, body, cookie, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], retryAfter: response.headers.get('retry-after') };
  };
  const player = async username => {
    const response = await api('/api/register', { username, password });
    assert.equal(response.status, 201);
    const user = await store.users.findOne({ accountId: response.data.user.accountId });
    return { ...response.data.user, id: user._id, cookie: response.cookie };
  };
  const alice = await player('Alice'), bob = await player('Bob'), outsider = await player('Outsider');
  const request = async (sender = alice, recipient = bob, clientRequestId = crypto.randomUUID()) => api('/api/friends/requests', { recipientAccountId: recipient.accountId, clientRequestId }, sender.cookie);
  const action = (id, name, actor = bob) => api(`/api/friends/requests/${id}/${name}`, {}, actor.cookie);
  const accepted = async () => {
    const response = await request();
    assert.equal(response.status, 201);
    assert.equal((await action(response.data.request.id, 'accept')).status, 200);
    return response.data.request.id;
  };
  return { store, app, api, player, alice, bob, outsider, request, action, accepted, advance: ms => { now += ms; }, time: () => now };
}
const send = (api, id, actor, text = 'Hello', clientMessageId = crypto.randomUUID()) => api(`/api/friends/${id}/messages`, { text, clientMessageId }, actor.cookie);
const publicFields = ['accountId', 'avatarUrl', 'banned', 'role', 'username'];

test('friend requests are private and recipient acceptance creates both alphabetical friend lists', async t => {
  const { api, alice, bob, outsider, request, action, player } = await fixture(t);
  assert.equal((await api('/api/friends')).status, 401);
  const created = await request();
  assert.equal(created.status, 201);
  assert.equal(created.data.request.status, 'pending');
  assert.deepEqual(Object.keys(created.data.request.sender).sort(), publicFields);
  assert.deepEqual(Object.keys(created.data.request.recipient).sort(), publicFields);
  assert.deepEqual((await api('/api/friends', undefined, outsider.cookie)).data, { friends: [], incoming: [], outgoing: [] });
  assert.equal((await api('/api/friends', undefined, alice.cookie)).data.outgoing[0].id, created.data.request.id);
  assert.equal((await api('/api/friends', undefined, bob.cookie)).data.incoming[0].id, created.data.request.id);
  assert.equal((await action(created.data.request.id, 'accept', alice)).status, 403);
  assert.equal((await action(created.data.request.id, 'accept', outsider)).status, 404);
  assert.equal((await action(created.data.request.id, 'accept')).data.request.status, 'accepted');
  assert.equal((await action(created.data.request.id, 'accept')).status, 200);
  const zed = await player('Zed'), aaron = await player('aaron');
  for (const person of [zed, aaron]) {
    const invitation = await request(bob, person);
    assert.equal((await action(invitation.data.request.id, 'accept', person)).status, 200);
  }
  const bobs = (await api('/api/friends', undefined, bob.cookie)).data;
  assert.deepEqual(bobs.friends.map(friend => friend.player.username), ['aaron', 'Alice', 'Zed']);
  assert.deepEqual(bobs.incoming, []); assert.deepEqual(bobs.outgoing, []);
  assert.deepEqual(Object.keys(bobs.friends[0].player).sort(), publicFields);
  assert.equal((await api('/api/friends', undefined, alice.cookie)).data.friends[0].player.accountId, bob.accountId);
});

test('friend request validation rejects self, invalid identifiers, nonexistent and banned players', async t => {
  const { api, store, alice, bob, request } = await fixture(t);
  assert.equal((await request(alice, alice)).status, 400);
  assert.equal((await api('/api/friends/requests', { recipientAccountId: bob.accountId, clientRequestId: 'wrong' }, alice.cookie)).status, 400);
  assert.equal((await api('/api/friends/requests', { recipientAccountId: 'wrong', clientRequestId: crypto.randomUUID() }, alice.cookie)).status, 400);
  assert.equal((await request(alice, { accountId: `PPR-${crypto.randomUUID().toUpperCase()}` })).status, 404);
  await store.users.updateOne({ _id: bob.id }, { $set: { banned: true } });
  assert.equal((await request()).status, 409);
  assert.equal((await request(bob, alice)).status, 403);
  assert.equal(await store.friendships.countDocuments(), 0);
});

test('friend request retries and concurrent reciprocal requests never create duplicates or autoaccept', async t => {
  const { api, store, alice, bob, request, action } = await fixture(t);
  const clientId = crypto.randomUUID();
  const responses = await Promise.all([request(alice, bob, clientId), request(alice, bob, clientId)]);
  assert.ok(responses.every(response => [200, 201].includes(response.status)));
  assert.equal(new Set(responses.map(response => response.data.request.id)).size, 1);
  assert.equal(await store.friendships.countDocuments(), 1);
  assert.equal((await request(bob, alice)).status, 409);
  assert.equal((await request()).status, 409);
  assert.equal((await request(alice, { accountId: alice.accountId }, clientId)).status, 400);
  const id = responses[0].data.request.id;
  assert.equal((await action(id, 'accept')).status, 200);
  assert.equal((await request()).status, 409);
  assert.equal((await request(alice, bob, clientId)).data.request.status, 'accepted');
  assert.equal((await api('/api/friends', undefined, alice.cookie)).data.friends.length, 1);
});

test('denying and cancelling removes requests completely and permits a new explicit invitation', async t => {
  const { api, store, alice, bob, request, action } = await fixture(t);
  const oldClientId = crypto.randomUUID();
  const first = await request(alice, bob, oldClientId);
  const id = first.data.request.id;
  assert.equal((await action(id, 'deny', alice)).status, 403);
  assert.equal((await action(id, 'deny')).data.request.status, 'denied');
  assert.equal((await action(id, 'deny')).status, 200);
  for (const person of [alice, bob]) assert.deepEqual((await api('/api/friends', undefined, person.cookie)).data, { friends: [], incoming: [], outgoing: [] });
  assert.equal((await action(id, 'accept')).status, 409);
  const next = await request(bob, alice);
  assert.equal(next.status, 201);
  assert.notEqual(next.data.request.id, id);
  assert.equal((await action(next.data.request.id, 'cancel', alice)).status, 403);
  assert.equal((await action(next.data.request.id, 'cancel', bob)).data.request.status, 'cancelled');
  assert.equal((await request(alice, bob, oldClientId)).status, 409);
  assert.equal(await store.friendships.countDocuments(), 1);
});

test('resending a closed friend request uses a fresh ID and stale actions cannot answer it', async t => {
  const { api, store, alice, bob, request, action } = await fixture(t);
  const clientRequestId = crypto.randomUUID();
  const first = (await request(alice, bob, clientRequestId)).data.request;
  assert.equal((await action(first.id, 'deny')).status, 200);
  const second = (await request()).data.request;
  assert.notEqual(second.id, first.id);
  for (const [name, actor] of [['accept', bob], ['deny', bob], ['cancel', alice]]) {
    assert.equal((await action(first.id, name, actor)).status, 404);
  }
  assert.equal((await request(alice, bob, clientRequestId)).status, 409);
  assert.equal((await store.friendships.findOne({ _id: new ObjectId(second.id) })).status, 'pending');
  assert.equal(await store.friendships.countDocuments(), 1);
  assert.equal((await api(`/api/friends/${first.id}/messages`, undefined, bob.cookie)).status, 404);
  assert.equal((await action(second.id, 'cancel', alice)).status, 200);
  const third = (await request()).data.request;
  assert.notEqual(third.id, second.id);
  assert.equal((await action(second.id, 'accept')).status, 404);
  assert.equal((await action(third.id, 'accept')).status, 200);
  assert.equal((await api('/api/friends', undefined, bob.cookie)).data.friends[0].id, third.id);
});

test('only accepted friends can read or send direct messages and data never includes account secrets', async t => {
  const { api, alice, bob, outsider, request, action } = await fixture(t);
  const id = (await request()).data.request.id;
  assert.equal((await send(api, id, alice)).status, 403);
  assert.equal((await api(`/api/friends/${id}/messages`, undefined, bob.cookie)).status, 403);
  assert.equal((await api(`/api/friends/${id}/messages`)).status, 401);
  assert.equal((await action(id, 'accept')).status, 200);
  const message = await send(api, id, alice, '  Hello Bob  ');
  assert.equal(message.status, 201);
  assert.equal(message.data.message.text, 'Hello Bob');
  assert.deepEqual(Object.keys(message.data.message.sender).sort(), publicFields);
  assert.equal((await send(api, id, outsider)).status, 404);
  assert.equal((await api(`/api/friends/${id}/messages`, undefined, outsider.cookie)).status, 404);
  const messages = await api(`/api/friends/${id}/messages`, undefined, bob.cookie);
  assert.equal(messages.data.messages.length, 1);
  assert.deepEqual(messages.data.messages[0], message.data.message);
  assert.equal(messages.data.friend.player.accountId, alice.accountId);
  assert.deepEqual(Object.keys(messages.data.friend.player).sort(), publicFields);
});

test('direct messages retry idempotently, reject reused IDs, and expose automatic cooldown retry timing', async t => {
  const { api, store, alice, accepted, advance } = await fixture(t);
  const id = await accepted(), clientId = crypto.randomUUID();
  const first = await send(api, id, alice, 'Hello', clientId);
  assert.equal(first.status, 201);
  const replay = await send(api, id, alice, 'Hello', clientId);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, first.data);
  assert.equal((await send(api, id, alice, 'Changed', clientId)).status, 409);
  const fast = await send(api, id, alice, 'Next');
  assert.equal(fast.status, 429);
  assert.equal(fast.retryAfter, '1');
  assert.equal(fast.data.retryAfterMs, 1000);
  advance(fast.data.retryAfterMs);
  assert.equal((await send(api, id, alice, 'Next')).status, 201);
  assert.equal(await store.friendMessages.countDocuments(), 2);
});

test('direct messages validate length and identifiers and return the latest 100 chronologically', async t => {
  const { api, store, alice, bob, accepted } = await fixture(t);
  const id = await accepted();
  for (const text of ['', '  ', 2, null, 'a'.repeat(1001)]) assert.equal((await send(api, id, alice, text)).status, 400);
  assert.equal((await send(api, id, alice, 'Valid', 'bad')).status, 400);
  assert.equal((await api('/api/friends/bad/messages', undefined, alice.cookie)).status, 400);
  assert.equal((await api(`/api/friends/${new ObjectId()}/messages`, undefined, alice.cookie)).status, 404);
  const start = Date.now() - 1000;
  await store.friendMessages.insertMany(Array.from({ length: 105 }, (_, i) => ({
    friendshipId: new ObjectId(id), senderUserId: i % 2 ? alice.id : bob.id, clientMessageId: crypto.randomUUID(), text: `Message ${i}`, createdAt: new Date(start + i)
  })));
  const messages = (await api(`/api/friends/${id}/messages`, undefined, alice.cookie)).data.messages;
  assert.equal(messages.length, 100);
  assert.equal(messages[0].text, 'Message 5');
  assert.equal(messages.at(-1).text, 'Message 104');
});

test('friend and message identities reflect current names, avatars, moderator tags, and bans', async t => {
  const { api, store, alice, bob, accepted } = await fixture(t);
  const id = await accepted();
  await send(api, id, alice);
  await store.users.updateOne({ _id: alice.id }, { $set: { username: 'Renamed', usernameKey: 'renamed', role: 'mod', avatarVersion: 'new', banned: true } });
  const friend = (await api('/api/friends', undefined, bob.cookie)).data.friends[0].player;
  assert.equal(friend.username, 'Renamed'); assert.equal(friend.role, 'mod'); assert.equal(friend.banned, true);
  assert.match(friend.avatarUrl, /\?v=new$/);
  const messages = (await api(`/api/friends/${id}/messages`, undefined, bob.cookie)).data.messages;
  assert.deepEqual(messages[0].sender, friend);
  assert.equal((await send(api, id, bob)).status, 409);
  assert.equal((await send(api, id, alice)).status, 403);
});

test('acceptance rechecks banned or deleted players and does not activate unavailable friendships', async t => {
  const { store, alice, bob, request, action } = await fixture(t);
  const id = (await request()).data.request.id;
  await store.users.updateOne({ _id: alice.id }, { $set: { banned: true } });
  assert.equal((await action(id, 'accept')).status, 409);
  assert.equal((await store.friendships.findOne({ _id: new ObjectId(id) })).status, 'pending');
  assert.equal((await action(id, 'deny')).status, 200);
  await store.users.updateOne({ _id: alice.id }, { $set: { banned: false } });
  const again = (await request()).data.request;
  await store.users.deleteOne({ _id: alice.id });
  assert.equal((await action(again.id, 'accept', bob)).status, 404);
});

test('account deletion removes friendship records and both players private messages while preserving other friendships', async t => {
  const { api, store, alice, bob, outsider, request, action, accepted } = await fixture(t);
  const id = await accepted();
  await send(api, id, alice, 'Alice private');
  await send(api, id, bob, 'Bob private');
  const other = (await request(bob, outsider)).data.request;
  await action(other.id, 'accept', outsider);
  await send(api, other.id, outsider, 'Keep this');
  const deleted = await api('/api/account', { confirmation: 'DELETE', currentPassword: password }, alice.cookie, 'DELETE');
  assert.equal(deleted.status, 200);
  assert.equal(await store.friendships.countDocuments(), 1);
  assert.equal(await store.friendMessages.countDocuments(), 1);
  assert.equal((await api('/api/friends', undefined, bob.cookie)).data.friends[0].player.accountId, outsider.accountId);
  assert.equal((await api(`/api/friends/${id}/messages`, undefined, bob.cookie)).status, 404);
  const recreated = await api('/api/register', { username: 'Alice', password });
  assert.equal(recreated.status, 201);
  assert.deepEqual((await api('/api/friends', undefined, recreated.cookie)).data, { friends: [], incoming: [], outgoing: [] });
});

test('simultaneous friend acceptance and denial produce one stable result', async t => {
  const { store, request, action } = await fixture(t);
  const id = (await request()).data.request.id;
  const outcomes = await Promise.all([action(id, 'accept'), action(id, 'deny')]);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]);
  assert.ok(['accepted', 'denied'].includes((await store.friendships.findOne({ _id: new ObjectId(id) })).status));
});

test('friend requests and direct messages cannot leave orphan records when account deletion races', async t => {
  const { api, store, alice, bob, request, accepted } = await fixture(t);
  const id = await accepted();
  const outcomes = await Promise.all([
    send(api, id, bob, 'A final message'),
    api('/api/account', { confirmation: 'DELETE', currentPassword: password }, alice.cookie, 'DELETE')
  ]);
  assert.equal(outcomes[1].status, 200);
  assert.ok([201, 404].includes(outcomes[0].status));
  assert.equal(await store.friendships.countDocuments(), 0);
  assert.equal(await store.friendMessages.countDocuments(), 0);
  const newAlice = await api('/api/register', { username: 'Alice', password });
  const target = { accountId: newAlice.data.user.accountId };
  const more = await Promise.all([
    request(bob, target), api('/api/account', { confirmation: 'DELETE', currentPassword: password }, newAlice.cookie, 'DELETE')
  ]);
  assert.equal(more[1].status, 200);
  assert.ok([201, 404, 409].includes(more[0].status));
  assert.equal(await store.friendships.countDocuments(), 0);
});

test('friend summaries show the last message and sort unread conversations before recent conversations and empty friends', async t => {
  const { api, alice, bob, outsider, player, accepted, request, action, advance } = await fixture(t);
  const aliceFriend = await accepted();
  const zed = await player('Zed'), aaron = await player('aaron');
  const otherFriend = (await request(bob, outsider)).data.request.id;
  const zedFriend = (await request(bob, zed)).data.request.id;
  const emptyFriend = (await request(bob, aaron)).data.request.id;
  for (const [id, actor] of [[otherFriend, outsider], [zedFriend, zed], [emptyFriend, aaron]]) await action(id, 'accept', actor);
  const olderUnread = (await send(api, aliceFriend, alice, 'First unread')).data.message;
  advance(1000);
  const newerUnread = (await send(api, otherFriend, outsider, 'Latest unread')).data.message;
  advance(1000);
  const latestSent = (await send(api, zedFriend, bob, 'My latest message')).data.message;
  const friends = (await api('/api/friends', undefined, bob.cookie)).data.friends;
  assert.deepEqual(friends.map(friend => friend.player.username), ['Outsider', 'Alice', 'Zed', 'aaron']);
  assert.deepEqual(friends.map(friend => friend.unreadCount), [1, 1, 0, 0]);
  assert.deepEqual(friends.slice(0, 3).map(friend => friend.lastMessage.text), [newerUnread.text, olderUnread.text, latestSent.text]);
  assert.equal(friends[0].lastMessage.createdAt, newerUnread.createdAt);
  assert.deepEqual(Object.keys(friends[0].lastMessage.sender).sort(), publicFields);
  assert.equal(friends[3].lastMessage, null);
  const read = await api(`/api/friends/${otherFriend}/read`, { messageId: newerUnread.id }, bob.cookie);
  assert.equal(read.status, 200);
  assert.equal(read.data.friend.unreadCount, 0);
  assert.deepEqual((await api('/api/friends', undefined, bob.cookie)).data.friends.map(friend => friend.player.username), ['Alice', 'Zed', 'Outsider', 'aaron']);
});

test('conversation read cursors acknowledge only the displayed snapshot and never move backwards', async t => {
  const { api, store, alice, bob, outsider, accepted, advance, request, action } = await fixture(t);
  const id = await accepted();
  const first = (await send(api, id, alice, 'Already displayed')).data.message;
  const snapshot = await api(`/api/friends/${id}/messages`, undefined, bob.cookie);
  assert.equal(snapshot.data.friend.unreadCount, 1);
  advance(1000);
  const newer = (await send(api, id, alice, 'Arrived after snapshot')).data.message;
  const read = await api(`/api/friends/${id}/read`, { messageId: snapshot.data.messages.at(-1).id }, bob.cookie);
  assert.equal(read.data.friend.unreadCount, 1);
  assert.equal(read.data.friend.lastMessage.id, newer.id);
  assert.equal((await api(`/api/friends/${id}/read`, { messageId: newer.id }, bob.cookie)).data.friend.unreadCount, 0);
  assert.equal((await api(`/api/friends/${id}/read`, { messageId: first.id }, bob.cookie)).data.friend.unreadCount, 0);
  const cursor = (await store.friendships.findOne({ _id: new ObjectId(id) })).readCursors[bob.id.toString()];
  assert.equal(cursor.messageId.toString(), newer.id);
  const other = (await request(alice, outsider)).data.request.id;
  await action(other, 'accept', outsider);
  advance(1000);
  const otherMessage = (await send(api, other, alice, 'Private elsewhere')).data.message;
  assert.equal((await api(`/api/friends/${id}/read`, { messageId: otherMessage.id }, bob.cookie)).status, 404);
  assert.equal((await api(`/api/friends/${id}/read`, { messageId: first.id }, outsider.cookie)).status, 404);
  assert.equal((await api(`/api/friends/${id}/read`, {}, bob.cookie)).status, 400);
  assert.equal((await api(`/api/friends/${id}/read`, { messageId: new ObjectId().toString() }, bob.cookie)).status, 404);
  assert.equal((await api(`/api/friends/${id}/read`, { messageId: first.id })).status, 401);
});

test('conversation cursors use message IDs to resolve equal timestamps and can include a displayed outgoing message', async t => {
  const { api, store, alice, bob, accepted, time } = await fixture(t);
  const id = await accepted(), at = new Date(time());
  const ids = ['000000000000000000000001', '000000000000000000000002', '000000000000000000000003'].map(id => new ObjectId(id));
  await store.friendMessages.insertMany(ids.map((_id, index) => ({ _id, friendshipId: new ObjectId(id), senderUserId: index === 1 ? bob.id : alice.id,
    text: `Message ${index}`, clientMessageId: crypto.randomUUID(), createdAt: at })));
  assert.equal((await api(`/api/friends/${id}/read`, { messageId: ids[1].toString() }, bob.cookie)).data.friend.unreadCount, 1);
  assert.equal((await api(`/api/friends/${id}/read`, { messageId: ids[2].toString() }, bob.cookie)).data.friend.unreadCount, 0);
  assert.equal((await api(`/api/friends/${id}/read`, { messageId: ids[0].toString() }, bob.cookie)).data.friend.unreadCount, 0);
  await store.friendships.updateOne({ _id: new ObjectId(id) }, { $unset: { readCursors: '' } });
  const raced = await Promise.all([ids[2], ids[0]].map(messageId => api(`/api/friends/${id}/read`, { messageId: messageId.toString() }, bob.cookie)));
  assert.ok(raced.every(response => response.status === 200));
  assert.equal((await api('/api/friends', undefined, bob.cookie)).data.friends[0].unreadCount, 0);
});

test('message notifications are separate from conversation reads and checking a snapshot preserves newer notifications', async t => {
  const { api, store, alice, bob, accepted, advance } = await fixture(t);
  const id = await accepted();
  const first = (await send(api, id, alice, 'A new message')).data.message;
  const feed = (await api('/api/notifications', undefined, bob.cookie)).data;
  assert.equal(feed.unreadCount, 1);
  assert.deepEqual(feed.notifications[0], { id: `message:${first.id}`, type: 'message', friendId: id, player: first.sender,
    text: first.text, createdAt: first.createdAt, read: false });
  assert.equal((await api('/api/notifications', undefined, alice.cookie)).data.unreadCount, 0);
  await api(`/api/friends/${id}/read`, { messageId: first.id }, bob.cookie);
  assert.equal((await api('/api/notifications', undefined, bob.cookie)).data.unreadCount, 1);
  advance(1000);
  const newer = (await send(api, id, alice, 'While messages are open')).data.message;
  const checked = await api('/api/notifications/read', { ids: feed.notifications.map(notification => notification.id) }, bob.cookie);
  assert.equal(checked.status, 200);
  assert.equal(checked.data.unreadCount, 1);
  assert.equal(checked.data.notifications.find(notification => notification.id === `message:${first.id}`).read, true);
  assert.equal(checked.data.notifications.find(notification => notification.id === `message:${newer.id}`).read, false);
  assert.equal((await api('/api/friends', undefined, bob.cookie)).data.friends[0].unreadCount, 1);
  await api(`/api/friends/${id}/read`, { messageId: newer.id }, bob.cookie);
  assert.equal((await api('/api/notifications', undefined, bob.cookie)).data.unreadCount, 1);
  assert.equal((await api('/api/notifications/read', { ids: [`message:${newer.id}`] }, bob.cookie)).data.unreadCount, 0);
  assert.ok((await store.friendMessages.findOne({ _id: new ObjectId(newer.id) })).notificationCheckedAt instanceof Date);
  assert.equal((await api('/api/notifications', undefined, bob.cookie)).data.unreadCount, 0);
});

test('notification access is private, validates batches before writing, and ignores unauthorized or future IDs', async t => {
  const { api, store, alice, bob, outsider, accepted, request } = await fixture(t);
  const id = await accepted(), message = (await send(api, id, alice)).data.message;
  assert.equal((await api('/api/notifications')).status, 401);
  assert.equal((await api('/api/notifications/read', { ids: [] })).status, 401);
  assert.deepEqual((await api('/api/notifications', undefined, outsider.cookie)).data, { notifications: [], unreadCount: 0 });
  await api('/api/notifications/read', { ids: [`message:${message.id}`] }, outsider.cookie);
  await api('/api/notifications/read', { ids: [`message:${message.id}`] }, alice.cookie);
  assert.equal((await api('/api/notifications', undefined, bob.cookie)).data.unreadCount, 1);
  for (const ids of [null, 'all', [1], ['wrong'], Array(101).fill(`message:${message.id}`), [`message:${message.id}`, 'wrong']]) {
    assert.equal((await api('/api/notifications/read', { ids }, bob.cookie)).status, 400);
  }
  assert.equal((await api('/api/notifications', undefined, bob.cookie)).data.unreadCount, 1);
  await api('/api/notifications/read', { ids: [`message:${new ObjectId()}`, `claim:${Date.now() + CLAIM_INTERVAL_MS}`] }, bob.cookie);
  assert.equal((await api('/api/notifications', undefined, bob.cookie)).data.unreadCount, 1);
  const pending = (await request(bob, outsider)).data.request.id;
  assert.equal((await api(`/api/friends/${pending}/read`, { messageId: message.id }, outsider.cookie)).status, 403);
  await store.users.updateOne({ _id: bob.id }, { $set: { banned: true } });
  assert.equal((await api('/api/notifications', undefined, bob.cookie)).status, 403);
  assert.equal((await api('/api/notifications/read', { ids: [`message:${message.id}`] }, bob.cookie)).status, 403);
  assert.equal((await api(`/api/friends/${id}/read`, { messageId: message.id }, bob.cookie)).status, 403);
});

test('notifications cap the feed while keeping an accurate total and use current public player identities', async t => {
  const { api, store, alice, bob, accepted, time } = await fixture(t);
  const id = await accepted(), at = time();
  await store.friendMessages.insertMany(Array.from({ length: 105 }, (_, index) => ({ friendshipId: new ObjectId(id), senderUserId: alice.id,
    text: `Message ${index}`, clientMessageId: crypto.randomUUID(), createdAt: new Date(at - 200 + index) })));
  await store.users.updateOne({ _id: alice.id }, { $set: { username: 'Renamed', usernameKey: 'renamed', avatarVersion: 'fresh', role: 'mod', banned: true } });
  const feed = (await api('/api/notifications', undefined, bob.cookie)).data;
  assert.equal(feed.notifications.length, 100);
  assert.equal(feed.unreadCount, 105);
  assert.equal(feed.notifications[0].text, 'Message 104');
  assert.equal(feed.notifications.at(-1).text, 'Message 5');
  assert.equal(feed.notifications[0].player.username, 'Renamed');
  assert.equal(feed.notifications[0].player.role, 'mod');
  assert.equal(feed.notifications[0].player.banned, true);
  assert.match(feed.notifications[0].player.avatarUrl, /\?v=fresh$/);
  assert.deepEqual(Object.keys(feed.notifications[0].player).sort(), publicFields);
  const checked = (await api('/api/notifications/read', { ids: feed.notifications.map(notification => notification.id) }, bob.cookie)).data;
  assert.equal(checked.unreadCount, 5);
  assert.deepEqual(checked.notifications.filter(notification => !notification.read).map(notification => notification.text), ['Message 4', 'Message 3', 'Message 2', 'Message 1', 'Message 0']);
  assert.equal((await api('/api/notifications/read', { ids: checked.notifications.map(notification => notification.id) }, bob.cookie)).data.unreadCount, 0);
  const deleted = await api('/api/account', { confirmation: 'DELETE', currentPassword: password }, alice.cookie, 'DELETE');
  assert.equal(deleted.status, 403);
  await store.users.updateOne({ _id: alice.id }, { $set: { banned: false } });
  assert.equal((await api('/api/account', { confirmation: 'DELETE', currentPassword: password }, alice.cookie, 'DELETE')).status, 200);
  assert.deepEqual((await api('/api/notifications', undefined, bob.cookie)).data, { notifications: [], unreadCount: 0 });
});

test('hourly claim notifications appear at the due time, persist checks, and renew only after the next successful claim', async t => {
  const { api, store, alice, advance, time } = await fixture(t, { verifyTurnstile: async token => token === 'valid-token', randomInt: () => 10 });
  assert.deepEqual((await api('/api/notifications', undefined, alice.cookie)).data, { notifications: [], unreadCount: 0 });
  const first = await api('/api/claim', { turnstileToken: 'valid-token' }, alice.cookie);
  assert.equal(first.status, 200);
  assert.equal(first.data.user.lastClaimAt, time());
  const due = first.data.user.nextClaimAt;
  advance(CLAIM_INTERVAL_MS - 1);
  await api('/api/notifications/read', { ids: [`claim:${due}`] }, alice.cookie);
  assert.equal((await api('/api/notifications', undefined, alice.cookie)).data.unreadCount, 0);
  assert.equal((await api('/api/claim', { turnstileToken: 'valid-token' }, alice.cookie)).status, 429);
  advance(1);
  const feed = (await api('/api/notifications', undefined, alice.cookie)).data;
  assert.deepEqual(feed, { notifications: [{ id: `claim:${due}`, type: 'claim', text: 'Tokens ready', createdAt: new Date(due).toISOString(), read: false }], unreadCount: 1 });
  const checked = await api('/api/notifications/read', { ids: [`claim:${due}`] }, alice.cookie);
  assert.equal(checked.data.notifications[0].read, true);
  assert.equal(checked.data.unreadCount, 0);
  assert.equal((await store.users.findOne({ _id: alice.id })).claimNotificationSeenAt, due);
  assert.equal((await api('/api/notifications', undefined, alice.cookie)).data.unreadCount, 0);
  const restarted = createApp(store, { mailer: null, now: time }).listen(0);
  t.after(() => new Promise(resolve => restarted.close(resolve)));
  const persisted = await fetch(`http://127.0.0.1:${restarted.address().port}/api/notifications`, { headers: { Cookie: alice.cookie } });
  assert.equal((await persisted.json()).unreadCount, 0);
  const next = await api('/api/claim', { turnstileToken: 'valid-token' }, alice.cookie);
  assert.equal(next.status, 200);
  assert.deepEqual((await api('/api/notifications', undefined, alice.cookie)).data, { notifications: [], unreadCount: 0 });
  advance(CLAIM_INTERVAL_MS);
  await api('/api/notifications/read', { ids: [`claim:${due}`] }, alice.cookie);
  const renewed = (await api('/api/notifications', undefined, alice.cookie)).data;
  assert.equal(renewed.unreadCount, 1);
  assert.equal(renewed.notifications[0].id, `claim:${next.data.user.nextClaimAt}`);
  assert.equal(renewed.notifications[0].read, false);
  await api('/api/notifications/read', { ids: [`claim:${next.data.user.nextClaimAt + CLAIM_INTERVAL_MS}`] }, alice.cookie);
  assert.equal((await api('/api/notifications', undefined, alice.cookie)).data.unreadCount, 1);
});
