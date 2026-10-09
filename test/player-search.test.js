const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp, connectMongo } = require('../server');
const { createAccountId } = require('../mongo');

let mongo;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
});
after(async () => { await mongo?.stop(); });

async function fixture(t, username = 'searcher') {
  const store = await connectMongo({ uri: mongo.getUri(), dbName: `player_search_${crypto.randomBytes(5).toString('hex')}` });
  t.after(() => store.client.close());
  const server = createApp(store, { mailer: null }).listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = async (route, cookie, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const registered = await api('/api/register', undefined, { username, password: 'player-search-password' });
  assert.equal(registered.status, 201);
  const search = prefix => api(`/api/players${prefix === undefined ? '' : `?username=${encodeURIComponent(prefix)}`}`, registered.cookie);
  const seed = async (name, fields = {}) => {
    const user = { username: name, usernameKey: name.toLowerCase(), accountId: createAccountId(), role: 'player', ...fields };
    await store.users.insertOne(user);
    return user;
  };
  return { store, api, cookie: registered.cookie, user: registered.data.user, search, seed };
}

const names = result => result.data.players.map(player => player.username);

test('player search narrows username prefixes alphabetically as letters are added', async t => {
  const { search, seed } = await fixture(t);
  for (const name of ['example', 'exa', 'e', 'exampl', 'ex', 'examp', 'exam', 'Other', 'next']) await seed(name);
  assert.deepEqual(names(await search('e')), ['e', 'ex', 'exa', 'exam', 'examp', 'exampl', 'example']);
  assert.deepEqual(names(await search('ex')), ['ex', 'exa', 'exam', 'examp', 'exampl', 'example']);
  assert.deepEqual(names(await search('exa')), ['exa', 'exam', 'examp', 'exampl', 'example']);
  assert.deepEqual(names(await search('example')), ['example']);
  assert.deepEqual(names(await search('x')), []);
  assert.deepEqual(names(await search('missing')), []);
});

test('player search trims input and sorts case-insensitively, including an initial empty query', async t => {
  const { search, seed } = await fixture(t);
  for (const name of ['zebra', 'Alpha_z', 'alpha_a', 'ExAMPle', 'alpha_B']) await seed(name);
  const expected = ['alpha_a', 'alpha_B', 'Alpha_z', 'ExAMPle', 'zebra'];
  assert.deepEqual(names(await search()), expected);
  assert.deepEqual(names(await search('')), expected);
  assert.deepEqual(names(await search('   ')), expected);
  assert.deepEqual(names(await search(' ALPHA_ ')), expected.slice(0, 3));
  assert.deepEqual(names(await search('exAM')), ['ExAMPle']);
});

test('player search excludes the requester and banned players before returning results', async t => {
  const { search, seed } = await fixture(t, 'ex_requester');
  await seed('ex_banned', { banned: true });
  await seed('ex_allowed', { banned: false });
  await seed('ex_legacy');
  assert.deepEqual(names(await search('ex')), ['ex_allowed', 'ex_legacy']);
});

test('player search returns only public identity fields with current roles and avatars', async t => {
  const { search, seed } = await fixture(t);
  const admin = await seed('675', {
    email: 'private@example.test', passwordHash: 'secret-password', balance: 934, lastClaimAt: 123,
    activityRevision: 7, sessionToken: 'secret-session', createdAt: 456, avatarVersion: 'avatar-version'
  });
  await seed('moderator', { role: 'mod' });
  await seed('ordinary', { role: 'admin' });
  const result = await search();
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.data), ['players']);
  for (const player of result.data.players) {
    assert.deepEqual(Object.keys(player).sort(), ['accountId', 'avatarUrl', 'banned', 'role', 'username']);
    assert.equal(player.banned, false);
    assert.equal(typeof player.accountId, 'string');
    assert.equal(typeof player.avatarUrl, 'string');
  }
  assert.equal(result.data.players.find(player => player.accountId === admin.accountId).role, 'admin');
  assert.equal(result.data.players.find(player => player.username === 'moderator').role, 'mod');
  assert.equal(result.data.players.find(player => player.username === 'ordinary').role, 'player');
  const serialized = JSON.stringify(result.data);
  for (const secret of ['private@example.test', 'secret-password', 'secret-session', 'balance', 'lastClaimAt', 'activityRevision', 'createdAt']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('player search requires a current, unbanned login', async t => {
  const { api, store, cookie, user } = await fixture(t);
  assert.equal((await api('/api/players')).status, 401);
  assert.equal((await api('/api/players', 'pepper_session=invalid')).status, 401);
  assert.equal((await api('/api/players?username=.', cookie)).status, 400);
  await store.users.updateOne({ accountId: user.accountId }, { $set: { banned: true } });
  const banned = await api('/api/players', cookie);
  assert.equal(banned.status, 403);
  assert.equal(banned.data.banned, true);
});

test('player search rejects malformed or repeated query values and permits valid ASCII prefixes', async t => {
  const { api, cookie, search, seed } = await fixture(t);
  for (const prefix of ['.', 'ex.*', 'ex name', 'ex-name', 'é', 'a'.repeat(25), 'ex\nname', '\u0000']) {
    assert.equal((await search(prefix)).status, 400, JSON.stringify(prefix));
  }
  for (const route of ['/api/players?username=e&username=ex', '/api/players?username%5B0%5D=e', '/api/players?username%5Bkey%5D=e']) {
    assert.equal((await api(route, cookie)).status, 400, route);
  }
  await seed('_One2');
  await seed('a'.repeat(24));
  assert.deepEqual(names(await search('_oNE2')), ['_One2']);
  assert.deepEqual(names(await search('a'.repeat(24))), ['a'.repeat(24)]);
});

test('player search returns at most 25 alphabetically first eligible matches', async t => {
  const { search, seed } = await fixture(t, 'list_00_requester');
  await seed('list_00_banned', { banned: true });
  for (let index = 30; index >= 1; index -= 1) await seed(`list_${String(index).padStart(2, '0')}`);
  const result = await search('list_');
  assert.equal(result.status, 200);
  assert.deepEqual(names(result), Array.from({ length: 25 }, (_, index) => `list_${String(index + 1).padStart(2, '0')}`));
});

test('moderation player lookup stays staff-only and includes banned players and the administrator', async t => {
  const { api, cookie, seed } = await fixture(t, '675');
  const ordinary = await api('/api/register', undefined, { username: 'ordinary', password: 'player-search-password' });
  await seed('banned_player', { banned: true });
  assert.equal((await api('/api/moderation/players')).status, 401);
  assert.equal((await api('/api/moderation/players', ordinary.cookie)).status, 403);
  const result = await api('/api/moderation/players', cookie);
  assert.equal(result.status, 200);
  assert.deepEqual(names(result), ['675', 'banned_player', 'ordinary']);
  assert.equal(result.data.players.find(player => player.username === 'banned_player').banned, true);
});
