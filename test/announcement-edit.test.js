const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp, connectMongo } = require('../server');

let mongo;
before(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); });
after(async () => { await mongo?.stop(); });
async function fixture(t) {
  const store = await connectMongo({ uri: mongo.getUri(), dbName: `announcement_edit_${crypto.randomBytes(4).toString('hex')}` });
  t.after(() => store.client.close());
  let now = Date.now();
  const server = createApp(store, { mailer: null, now: () => now }).listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = async (route, body, cookie, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const people = {};
  for (const [key, username] of Object.entries({ owner: '675', mod: 'editor_mod', senior: 'editor_senior', admin: 'editor_admin', member: 'editor_member' })) {
    const response = await api('/api/register', { username, password: 'preview-password' });
    assert.equal(response.status, 201);
    people[key] = { ...response.data.user, cookie: response.cookie };
  }
  for (const key of ['mod', 'senior', 'admin']) {
    const response = await api(`/api/moderation/players/${people[key].accountId}`, { role: key === 'senior' ? 'senior_mod' : key }, people.owner.cookie, 'PATCH');
    assert.equal(response.status, 200);
  }
  const publish = async (person = people.mod) => {
    const response = await api('/api/announcements', { title: 'Original title', description: 'Original text' }, person.cookie);
    assert.equal(response.status, 201); return response.data.entry;
  };
  const edit = (entry, person, body = { title: 'Edited title', description: 'Edited text' }) => api(`/api/announcements/${entry.id}`, body, person?.cookie, 'PATCH');
  return { store, api, ...people, publish, edit, advance: ms => { now += ms; } };
}

test('editing preserves the original author, dates, comments and seen state while crediting distinct editors', async t => {
  const { store, api, owner, mod, senior, admin, member, publish, edit, advance } = await fixture(t);
  const entry = await publish();
  const reply = await api(`/api/announcements/${entry.id}/comments`, { text: 'Keep this reply', clientMessageId: crypto.randomUUID() }, member.cookie);
  assert.equal(reply.status, 201);
  assert.equal((await api(`/api/announcements/${entry.id}/seen`, {}, member.cookie)).status, 200);
  advance(2000);
  assert.equal((await edit(entry, mod)).status, 200);
  assert.equal((await edit(entry, senior)).status, 200);
  assert.equal((await edit(entry, senior)).status, 200);
  assert.equal((await edit(entry, owner)).status, 200);
  assert.equal((await edit(entry, admin)).status, 200);
  const current = (await api('/api/announcements')).data.entries[0];
  assert.equal(current.author.accountId, mod.accountId);
  assert.equal(current.createdAt, entry.createdAt);
  assert.ok(Date.parse(current.updatedAt) > Date.parse(entry.createdAt));
  assert.deepEqual(current.contributors.map(person => person.accountId), [mod.accountId, senior.accountId, owner.accountId, admin.accountId]);
  assert.equal(current.commentCount, 1);
  assert.equal((await api(`/api/announcements/${entry.id}/comments`)).data.comments[0].text, 'Keep this reply');
  assert.deepEqual((await api('/api/announcements/unseen', undefined, member.cookie)).data.entries, []);
  await store.users.updateOne({ accountId: senior.accountId }, { $set: { username: 'SeniorRenamed', usernameKey: 'seniorrenamed' } });
  const renamed = (await api('/api/announcements')).data.entries[0];
  assert.equal(renamed.contributors[1].username, 'SeniorRenamed');
  const saved = await store.announcements.findOne({ _id: new ObjectId(entry.id) });
  assert.deepEqual(saved.editorAccountIds, [senior.accountId, owner.accountId, admin.accountId]);
});

test('announcement editing and deletion follow the staff hierarchy', async t => {
  const { api, owner, mod, senior, admin, member, publish, edit } = await fixture(t);
  const modEntry = await publish(mod), seniorEntry = await publish(senior), adminEntry = await publish(admin), ownerEntry = await publish(owner);
  assert.equal((await edit(modEntry)).status, 401);
  assert.equal((await edit(modEntry, member)).status, 403);
  assert.equal((await edit(modEntry, senior)).status, 200);
  assert.equal((await edit(seniorEntry, mod)).status, 403);
  assert.equal((await edit(seniorEntry, senior)).status, 200);
  assert.equal((await edit(adminEntry, senior)).status, 403);
  assert.equal((await edit(ownerEntry, senior)).status, 403);
  assert.equal((await edit(ownerEntry, admin)).status, 200);
  await api(`/api/moderation/players/${mod.accountId}`, { role: 'senior_mod' }, owner.cookie, 'PATCH');
  assert.equal((await edit(modEntry, senior)).status, 403, 'Current author role protects a promoted peer');
  const remove = (entry, person) => api(`/api/announcements/${entry.id}`, undefined, person.cookie, 'DELETE');
  assert.equal((await remove(modEntry, senior)).status, 403);
  await api(`/api/moderation/players/${mod.accountId}`, { role: 'mod' }, owner.cookie, 'PATCH');
  assert.equal((await remove(modEntry, senior)).status, 200);
  assert.equal((await remove(ownerEntry, senior)).status, 403);
  assert.equal((await remove(seniorEntry, admin)).status, 200);
});

test('invalid edits cannot change attribution or content and repeated simultaneous editors retain both credits', async t => {
  const { store, api, owner, mod, senior, admin, publish, edit } = await fixture(t);
  const entry = await publish();
  for (const payload of [{ title: '', description: 'Text' }, { title: 'Title', description: '' }, { title: 'x'.repeat(121), description: 'Text' },
    { title: 'Title', description: 'x'.repeat(5001) }, { title: 'Title', description: 'Text', authorAccountId: owner.accountId }]) {
    assert.equal((await edit(entry, owner, payload)).status, 400);
  }
  assert.equal((await api('/api/announcements/invalid', { title: 'Title', description: 'Text' }, owner.cookie, 'PATCH')).status, 400);
  assert.equal((await edit({ id: new ObjectId().toString() }, owner)).status, 404);
  const original = (await api('/api/announcements')).data.entries[0];
  assert.equal(original.title, entry.title); assert.deepEqual(original.contributors.map(person => person.accountId), [mod.accountId]);
  const results = await Promise.all([edit(entry, senior), edit(entry, admin)]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  const saved = await store.announcements.findOne({ _id: new ObjectId(entry.id) });
  assert.deepEqual(new Set(saved.editorAccountIds), new Set([senior.accountId, admin.accountId]));
  assert.equal(saved.authorAccountId, mod.accountId);
});
