const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../public/friends.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const player = username => ({ accountId: `PPR-${username}`, username, role: 'player', banned: false });
const friendship = (name, id = `friend-${name}`) => ({ id, player: player(name) });
const request = (sender, recipient, id = 'request-id') => ({ id, sender, recipient, status: 'pending' });
const message = (sender, text, extra = {}) => ({ id: crypto.randomBytes(12).toString('hex'), clientMessageId: crypto.randomUUID(), sender, text, createdAt: new Date().toISOString(), ...extra });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Run the complete production module with DOM, time, and API boundaries replaced.
function harness(user, snapshot = { friends: [], incoming: [], outgoing: [] }, network, options = {}) {
  const elements = new Map(), calls = [], timers = new Map(), intervals = [], listeners = new Map(), pickers = [], navigations = [];
  const clock = { now: Date.now() };
  let context, timerId = 0;
  const node = (id = '', attrs = '', tagName = '') => {
    const classes = new Set(), events = new Map();
    return {
      id, tagName: tagName.toUpperCase(), children: [], dataset: {}, value: '', textContent: '', hidden: /\bhidden\b/.test(attrs), disabled: false,
      scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
      append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); },
      replaceChildren(...children) { for (const child of children) child.parentElement = this; this.children = children; },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, callback) { events.set(name, callback); },
      dispatch(name, target = this) { return events.get(name)?.({ preventDefault() {}, target }); },
      closest(selector) { for (let target = this; target; target = target.parentElement) if (selector === '[data-friend-action]' && target.dataset.friendAction) return target; return null; },
      focus() { document.activeElement = this; }, click() { this.dispatch('click'); }
    };
  };
  for (const match of html.matchAll(/<[a-z][a-z0-9]*\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(match[2], node(match[2], match[1]));
  const document = { getElementById: id => elements.get(id), createElement: tagName => node('', '', tagName), body: node(), activeElement: null, hidden: !!options.hidden, addEventListener: (name, callback) => listeners.set(name, callback) };
  const boundary = {
    document, crypto, console, URLSearchParams,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } },
    window: {
      location: { search: options.search || '' },
      setTimeout(callback, delay = 0) { const id = ++timerId; timers.set(id, { callback, at: clock.now + delay, delay }); return id; },
      clearTimeout: id => timers.delete(id),
      PepperPlayerPicker: { attach(config) {
        const picker = { resets: 0, closes: 0, reset() { this.resets++; }, close() { this.closes++; } };
        pickers.push({ config, picker }); return picker;
      } }
    },
    setInterval(callback, delay) { intervals.push({ callback, delay }); },
    state: { user: null, accountSubmitting: false }, accountBanned: false, userIdentityRevision: 0, routeRevision: 0, pageKind: 'friends',
    profileHref: name => `/profile/${name}`, profileAvatar: person => { const avatar = node(); avatar.dataset.accountId = person.accountId; return avatar; }, playerRoleBadges: () => node(),
    message: (target, text) => { target.textContent = text; },
    setUser(value) {
      if (context.state.user?.accountId !== value?.accountId) context.userIdentityRevision++;
      context.state.user = value; context.window.PepperFriends.syncUser();
    },
    navigateTo(href, options) {
      navigations.push({ href, options }); context.window.location.search = ''; context.pageKind = 'friends'; context.routeRevision++;
      context.window.PepperFriends.onRoute(); return true;
    },
    api: async (route, options = {}) => {
      const call = { route, method: options.method || 'GET', payload: options.body ? JSON.parse(options.body) : null }; calls.push(call);
      const result = network ? await network(call) : undefined;
      if (result !== undefined) return result;
      if (route === 'friends' && call.method === 'GET') return snapshot;
      const chat = /^friends\/([^/]+)\/messages$/.exec(route);
      if (chat && call.method === 'GET') return { friend: snapshot.friends.find(friend => friend.id === chat[1]), messages: [] };
      const read = /^friends\/([^/]+)\/read$/.exec(route);
      if (read && call.method === 'POST') return { friend: { ...snapshot.friends.find(friend => friend.id === read[1]), unreadCount: 0 } };
      throw new Error(`Unexpected ${call.method} ${route}`);
    }
  };
  context = vm.createContext(boundary);
  vm.runInContext(source.replace('window.PepperFriends = { syncUser, onRoute, load, openConversation };', 'window.PepperFriends = { syncUser, onRoute, load, inspect: () => friends, openConversation, loadMessages, requestFriend, perform, sendMessage, act, render, markRead };'), context);
  boundary.setUser(user);
  return {
    api: context.window.PepperFriends, elements, calls, timers, intervals, listeners, pickers, navigations, context, snapshot, setUser: boundary.setUser,
    navigate(page, search = '') { context.pageKind = page; context.window.location.search = search; context.routeRevision++; context.window.PepperFriends.onRoute(); },
    async runNextTimer() {
      const item = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; assert.ok(item, 'A retry is scheduled');
      timers.delete(item[0]); clock.now = Math.max(clock.now, item[1].at); item[1].callback(); await tick(); return item[1].delay;
    }
  };
}
const allText = element => [element.textContent, ...element.children.map(allText)].filter(Boolean).join(' ');
const controls = element => [...(element.dataset.friendAction ? [element] : []), ...element.children.flatMap(controls)];
const descendants = element => [element, ...element.children.flatMap(descendants)];
const posts = ui => ui.calls.filter(call => call.method === 'POST' && !call.route.endsWith('/read'));
const reads = ui => ui.calls.filter(call => call.method === 'POST' && call.route.endsWith('/read'));
function send(ui, text) { ui.elements.get('friendChatInput').value = text; ui.elements.get('friendChatForm').dispatch('submit'); }

test('friends are private to a signed-in account and disabled outside the Friends page', async () => {
  const ui = harness(null); await tick();
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.elements.get('friendsGuest').hidden, false);
  assert.equal(ui.elements.get('friendsAccount').hidden, true);
  await ui.api.requestFriend({ preventDefault() {} }); send(ui, 'No account');
  assert.equal(posts(ui).length, 0);
  ui.setUser(player('local')); await tick();
  assert.equal(ui.elements.get('friendsAccount').hidden, false);
  ui.navigate('games');
  const calls = ui.calls.length;
  for (const interval of ui.intervals) interval.callback(); await tick();
  assert.equal(ui.calls.length, calls);
  assert.equal(ui.pickers[0].config.isEnabled(), false);
  assert.equal(ui.elements.get('friendRequestSend').disabled, true);
});

test('friend suggestions use the shared prefix search without sending a request', async () => {
  const target = player('example');
  const ui = harness(player('local'), undefined, call => call.route.startsWith('players?') ? { players: [target] } : undefined);
  await tick(); const { config } = ui.pickers[0];
  assert.equal(config.input, ui.elements.get('friendUsername')); assert.equal(config.isEnabled(), true);
  const matches = await config.search('ex &');
  assert.equal(matches[0].accountId, target.accountId);
  assert.equal(ui.calls.at(-1).route, 'players?username=ex%20%26');
  config.input.value = target.username; config.onSelect(target);
  assert.equal(config.input.value, 'example'); assert.equal(posts(ui).length, 0);
});

test('friend suggestion results cannot survive account or route changes', async () => {
  for (const change of ['route', 'account']) {
    const response = deferred();
    const ui = harness(player('local'), undefined, call => call.route.startsWith('players?') ? response.promise : undefined);
    await tick(); const pending = ui.pickers[0].config.search('ex');
    if (change === 'route') ui.navigate('games'); else ui.setUser(player('new-account'));
    response.resolve({ players: [player('example')] });
    assert.equal((await pending).length, 0, change);
  }
});

test('friend requests look up the exact username and send permanent IDs with an idempotency key', async () => {
  const target = player('example'), local = player('local');
  const snapshot = { friends: [], incoming: [], outgoing: [] };
  const ui = harness(local, snapshot, call => {
    if (call.route === 'profiles/example') return { profile: target };
    if (call.route === 'friends/requests' && call.method === 'POST') {
      const saved = request(local, target); snapshot.outgoing = [saved]; return { request: saved };
    }
  });
  await tick(); ui.elements.get('friendUsername').value = ' example ';
  await ui.api.requestFriend({ preventDefault() {} }); await tick();
  assert.equal(ui.calls.filter(call => call.route === 'profiles/example').length, 1);
  assert.equal(posts(ui).length, 1);
  assert.equal(posts(ui)[0].payload.recipientAccountId, target.accountId);
  assert.match(posts(ui)[0].payload.clientRequestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(posts(ui)[0].payload).sort(), ['clientRequestId', 'recipientAccountId']);
  assert.equal(ui.elements.get('friendUsername').value, '');
  assert.equal(ui.elements.get('friendRequestMessage').textContent, 'Request sent.');
  assert.match(allText(ui.elements.get('friendOutgoing')), /example/);
});

test('a pending player lookup blocks duplicate requests and cannot send after navigation or account changes', async () => {
  for (const change of ['route', 'account']) {
    const response = deferred();
    const ui = harness(player('local'), undefined, call => call.route.startsWith('profiles/') ? response.promise : undefined);
    await tick(); ui.elements.get('friendUsername').value = 'example';
    const first = ui.api.requestFriend({ preventDefault() {} });
    await ui.api.requestFriend({ preventDefault() {} });
    assert.equal(ui.calls.filter(call => call.route.startsWith('profiles/')).length, 1);
    if (change === 'route') ui.navigate('games'); else ui.setUser(player('new-account'));
    response.resolve({ profile: player('example') }); await first; await tick();
    assert.equal(posts(ui).length, 0, change);
  }
});

test('incoming requests offer Accept and Deny and outgoing requests can be cancelled', async () => {
  for (const action of ['accept', 'deny', 'cancel']) {
    const local = player('local'), other = player('other'), incoming = action !== 'cancel';
    const saved = request(incoming ? other : local, incoming ? local : other);
    const snapshot = { friends: [], incoming: incoming ? [saved] : [], outgoing: incoming ? [] : [saved] };
    const ui = harness(local, snapshot, call => {
      if (call.method === 'POST') {
        assert.equal(call.route, `friends/requests/${saved.id}/${action}`);
        snapshot.incoming = []; snapshot.outgoing = [];
        if (action === 'accept') snapshot.friends = [friendship('other', saved.id)];
        return { request: { ...saved, status: action === 'accept' ? 'accepted' : action === 'deny' ? 'denied' : 'cancelled' } };
      }
    });
    await tick();
    const buttons = controls(ui.elements.get(incoming ? 'friendIncoming' : 'friendOutgoing'));
    assert.deepEqual(buttons.map(control => control.textContent), incoming ? ['Accept', 'Deny'] : ['Cancel']);
    const control = buttons.find(control => control.dataset.friendAction === action);
    ui.elements.get('friendsPage').dispatch('click', control); await tick();
    assert.equal(posts(ui).length, 1); assert.deepEqual(posts(ui)[0].payload, {});
    assert.equal(ui.elements.get('friendIncoming').children.length, 0);
    assert.equal(ui.elements.get('friendOutgoing').children.length, 0);
    if (action === 'accept') assert.match(allText(ui.elements.get('friendsList')), /other/);
    ui.elements.get('friendsPage').dispatch('click', control); await tick();
    assert.equal(posts(ui).length, 1, 'Old controls cannot repeat a completed action');
  }
});

test('uncertain friend requests retry with the original idempotency key', async () => {
  let first = true;
  const ui = harness(player('local'), undefined, call => {
    if (call.route.startsWith('profiles/')) return { profile: player('other') };
    if (call.method === 'POST') { if (first) { first = false; throw new Error('Connection lost'); } return { request: {} }; }
  });
  await tick(); ui.elements.get('friendUsername').value = 'other';
  await ui.api.requestFriend({ preventDefault() {} }); await tick();
  assert.equal(ui.elements.get('friendRequestSend').textContent, 'Retry request');
  await ui.api.requestFriend({ preventDefault() {} }); await tick();
  assert.equal(posts(ui).length, 2); assert.deepEqual(posts(ui)[0].payload, posts(ui)[1].payload);
  assert.equal(ui.calls.filter(call => call.route.startsWith('profiles/')).length, 1);
});

test('only a selected accepted friend can receive a private message', async () => {
  const local = player('local'), friend = friendship('other');
  const ui = harness(local, { friends: [friend], incoming: [], outgoing: [] }, call => {
    if (call.method === 'POST' && call.route.endsWith('/messages')) return { message: message(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }) };
  });
  await tick(); send(ui, 'Before selection'); ui.api.openConversation('unrelated'); await tick();
  assert.equal(posts(ui).length, 0);
  assert.equal(ui.elements.get('friendChatContent').hidden, true);
  ui.api.openConversation(friend.id); await tick();
  assert.equal(ui.elements.get('friendChatContent').hidden, false);
  assert.match(allText(ui.elements.get('friendChatPlayer')), /other/);
  send(ui, 'Hello <script>alert(1)</script>'); await tick();
  assert.equal(posts(ui).length, 1);
  assert.equal(posts(ui)[0].route, `friends/${friend.id}/messages`);
  assert.deepEqual(Object.keys(posts(ui)[0].payload).sort(), ['clientMessageId', 'text']);
  assert.equal(posts(ui)[0].payload.text, 'Hello <script>alert(1)</script>');
  assert.match(allText(ui.elements.get('friendChatMessages')), /Hello <script>/);
  assert.equal(ui.api.inspect().outbox.length, 0);
});

test('switching conversations discards late message reads from the old friend', async () => {
  const first = friendship('first'), second = friendship('second'), response = deferred();
  const secondMessage = message(second.player, 'Second conversation');
  const ui = harness(player('local'), { friends: [first, second], incoming: [], outgoing: [] }, call => {
    if (call.route === `friends/${first.id}/messages`) return response.promise;
    if (call.route === `friends/${second.id}/messages`) return { friend: second, messages: [secondMessage] };
  });
  await tick(); ui.api.openConversation(first.id); ui.api.openConversation(second.id); await tick();
  response.resolve({ friend: first, messages: [message(first.player, 'Old private conversation')] }); await tick();
  assert.equal(ui.api.inspect().selectedId, second.id);
  assert.match(allText(ui.elements.get('friendChatMessages')), /Second conversation/);
  assert.doesNotMatch(allText(ui.elements.get('friendChatMessages')), /Old private/);
  assert.match(allText(ui.elements.get('friendChatPlayer')), /second/);
});

test('changing accounts clears private messages, drafts, and stale message responses', async () => {
  const friend = friendship('other'), response = deferred();
  const snapshot = { friends: [friend], incoming: [], outgoing: [] };
  const ui = harness(player('local'), snapshot, call => call.route.endsWith('/messages') ? response.promise : undefined);
  await tick(); ui.api.openConversation(friend.id); ui.elements.get('friendChatInput').value = 'Private draft';
  snapshot.friends = []; ui.setUser(player('new-account')); await tick();
  response.resolve({ friend, messages: [message(friend.player, 'Old private message')] }); await tick();
  assert.equal(ui.api.inspect().selectedId, null); assert.equal(ui.api.inspect().messages.length, 0);
  assert.equal(ui.elements.get('friendChatInput').value, '');
  assert.equal(ui.elements.get('friendChatContent').hidden, true);
  assert.doesNotMatch(allText(ui.elements.get('friendChatMessages')), /Old private/);
});

test('rate-limited private messages stay pending and send automatically with the same receipt', async () => {
  const local = player('local'), friend = friendship('other'); let attempts = 0;
  const ui = harness(local, { friends: [friend], incoming: [], outgoing: [] }, call => {
    if (call.method === 'POST' && call.route.endsWith('/messages')) {
      if (++attempts === 1) throw Object.assign(new Error('Too fast.'), { status: 429, retryAfterMs: 200 });
      return { message: message(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }) };
    }
  });
  await tick(); ui.api.openConversation(friend.id); await tick(); send(ui, 'Queued message'); await tick();
  assert.equal(ui.api.inspect().outbox[0].status, 'pending');
  assert.match(allText(ui.elements.get('friendChatMessages')), /Sending…/);
  assert.equal(controls(ui.elements.get('friendChatMessages')).length, 0, 'Rate limits require no manual retry');
  await ui.runNextTimer();
  assert.equal(posts(ui).length, 1, 'Retry waits until the server delay has passed');
  assert.ok(await ui.runNextTimer() >= 300);
  assert.equal(posts(ui).length, 2); assert.deepEqual(posts(ui)[0].payload, posts(ui)[1].payload);
  assert.equal(ui.api.inspect().outbox.length, 0);
  assert.equal(ui.api.inspect().messages.length, 1);
  assert.doesNotMatch(allText(ui.elements.get('friendChatMessages')), /Sending…/);
});

test('rate-limit retries cannot send after signing into a different account', async () => {
  const friend = friendship('other'), snapshot = { friends: [friend], incoming: [], outgoing: [] };
  const ui = harness(player('local'), snapshot, call => {
    if (call.method === 'POST' && call.route.endsWith('/messages')) throw Object.assign(new Error('Too fast.'), { status: 429, retryAfterMs: 200 });
  });
  await tick(); ui.api.openConversation(friend.id); await tick(); send(ui, 'Old account message'); await tick();
  await ui.runNextTimer();
  const oldTimer = [...ui.timers.values()][0]; assert.ok(oldTimer);
  snapshot.friends = []; ui.setUser(player('new-account')); await tick();
  assert.equal(ui.timers.size, 0); assert.equal(ui.api.inspect().outbox.length, 0);
  oldTimer.callback(); await tick();
  assert.equal(posts(ui).length, 1);
});

test('uncertain private messages offer a safe retry without losing their text', async () => {
  const local = player('local'), friend = friendship('other'); let fail = true;
  const ui = harness(local, { friends: [friend], incoming: [], outgoing: [] }, call => {
    if (call.method === 'POST' && call.route.endsWith('/messages')) {
      if (fail) throw new Error('Connection lost.');
      return { message: message(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }) };
    }
  });
  await tick(); ui.api.openConversation(friend.id); await tick(); send(ui, 'Keep this message'); await tick();
  assert.equal(ui.api.inspect().outbox[0].status, 'failed');
  assert.match(allText(ui.elements.get('friendChatMessages')), /Keep this message/);
  const retry = controls(ui.elements.get('friendChatMessages')).find(control => control.textContent === 'Retry'); assert.ok(retry);
  fail = false; ui.elements.get('friendsPage').dispatch('click', retry); await tick();
  assert.equal(posts(ui).length, 2); assert.deepEqual(posts(ui)[0].payload, posts(ui)[1].payload);
  assert.equal(ui.api.inspect().outbox.length, 0);
});

test('saved message receipts reconcile pending sends without duplicating a message', async () => {
  const local = player('local'), friend = friendship('other'), pending = deferred(); let saved;
  const ui = harness(local, { friends: [friend], incoming: [], outgoing: [] }, call => {
    if (call.method === 'POST' && call.route.endsWith('/messages')) { saved = message(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }); return pending.promise; }
    if (call.route.endsWith('/messages') && saved) return { friend, messages: [saved] };
  });
  await tick(); ui.api.openConversation(friend.id); await tick(); send(ui, 'Saved once'); await tick();
  await ui.api.loadMessages();
  assert.equal(ui.api.inspect().outbox.length, 0); assert.equal(ui.api.inspect().messages.length, 1);
  pending.resolve({ message: saved }); await tick();
  assert.equal(ui.api.inspect().messages.length, 1);
  assert.equal(ui.elements.get('friendChatMessages').children.length, 1);
});

test('an older message read cannot remove a newly sent message', async () => {
  const local = player('local'), friend = friendship('other'), oldRead = deferred(); let reads = 0;
  const ui = harness(local, { friends: [friend], incoming: [], outgoing: [] }, call => {
    if (call.route.endsWith('/messages') && call.method === 'GET' && ++reads === 2) return oldRead.promise;
    if (call.method === 'POST' && call.route.endsWith('/messages')) return { message: message(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }) };
  });
  await tick(); ui.api.openConversation(friend.id); await tick();
  const stale = ui.api.loadMessages(); send(ui, 'New message'); await tick();
  oldRead.resolve({ friend, messages: [] }); await stale;
  assert.equal(ui.api.inspect().messages.length, 1);
  assert.match(allText(ui.elements.get('friendChatMessages')), /New message/);
});

test('banned friends cannot receive messages and show an unavailable status', async () => {
  const friend = friendship('banned'); friend.player.banned = true;
  const ui = harness(player('local'), { friends: [friend], incoming: [], outgoing: [] });
  await tick(); ui.api.openConversation(friend.id); await tick();
  assert.equal(ui.elements.get('friendChatInput').disabled, true);
  assert.equal(ui.elements.get('friendChatSend').disabled, true);
  assert.equal(ui.elements.get('friendChatMessage').textContent, 'Player unavailable.');
  assert.equal(ui.calls.filter(call => call.route.endsWith('/messages')).length, 0);
  send(ui, 'Blocked message'); await tick();
  assert.equal(posts(ui).length, 0);
  friend.player.banned = false; await ui.api.load();
  assert.equal(ui.elements.get('friendChatInput').disabled, false);
  assert.equal(ui.elements.get('friendChatMessage').textContent, '');
});

test('the entire friend row is a keyboard-accessible button without nested profile links', async () => {
  const friend = friendship('other');
  const ui = harness(player('local'), { friends: [friend], incoming: [], outgoing: [] }); await tick();
  const row = ui.elements.get('friendsList').children[0];
  assert.equal(row.tagName, 'BUTTON'); assert.equal(row.type, 'button');
  assert.equal(row['aria-label'], 'Message other'); assert.equal(row.dataset.friendAction, 'open');
  assert.equal(descendants(row).some(item => item.tagName === 'A'), false);
  const username = descendants(row).find(item => item.textContent === 'other');
  ui.elements.get('friendsPage').dispatch('click', username); await tick();
  assert.equal(ui.api.inspect().selectedId, friend.id);
  assert.equal(ui.elements.get('friendChatContent').hidden, false);
  assert.equal(ui.context.document.activeElement, ui.elements.get('friendChatInput'));
});

test('message lists show previews, dates, and unread counts and sort unread conversations first', async () => {
  const local = player('local'), noHistory = friendship('new-friend');
  const history = (name, unread, timestamp, sender = player(name)) => ({ ...friendship(name), unreadCount: unread, lastMessage: message(sender, `Latest from ${name}`, { createdAt: timestamp }) });
  const olderUnread = history('older', 2, '2026-10-07T12:00:00Z');
  const newerUnread = history('newer', 1, '2026-10-08T12:00:00Z');
  const newestRead = history('read', 0, '2026-10-08T13:00:00Z', local);
  const ui = harness(local, { friends: [newestRead, olderUnread, noHistory, newerUnread], incoming: [], outgoing: [] }); await tick();
  const rows = ui.elements.get('friendConversations').children;
  assert.deepEqual(rows.map(row => row.dataset.friendId), [newerUnread.id, olderUnread.id, newestRead.id, noHistory.id]);
  assert.equal(ui.elements.get('friendConversationsEmpty').hidden, true);
  assert.equal(ui.elements.get('friendsList').children.length, 4);
  assert.match(allText(rows[0]), /Latest from newer/); assert.match(allText(rows[2]), /You: Latest from read/);
  assert.match(allText(rows[3]), /No messages yet\./);
  const date = descendants(rows[0]).find(item => item.tagName === 'TIME');
  assert.equal(date.dateTime, newerUnread.lastMessage.createdAt); assert.ok(date.textContent.length > 0);
  assert.ok(rows[0]['aria-label'].includes('Latest from newer')); assert.ok(rows[0]['aria-label'].includes(date.textContent));
  assert.ok(rows[1]['aria-label'].includes('2 unread messages'));
  const unread = descendants(rows[1]).find(item => item.className === 'friend-unread');
  assert.equal(unread.textContent, '2'); assert.equal(unread['aria-label'], '2 unread messages');
  assert.deepEqual(ui.elements.get('friendsList').children.map(row => row.dataset.friendId), [newerUnread.id, olderUnread.id, newestRead.id, noHistory.id]);
});

test('message history updates while Friends is open without clearing a composed draft or focused friend button', async () => {
  const friend = friendship('other'), snapshot = { friends: [friend], incoming: [], outgoing: [] };
  const ui = harness(player('local'), snapshot); await tick(); ui.api.openConversation(friend.id); await tick();
  ui.elements.get('friendChatInput').value = 'My unfinished reply';
  snapshot.friends = [{ ...friend, unreadCount: 1, lastMessage: message(friend.player, 'New while open') }];
  ui.elements.get('friendsList').children[0].focus(); await ui.api.load();
  assert.equal(ui.elements.get('friendChatInput').value, 'My unfinished reply');
  assert.match(allText(ui.elements.get('friendConversations')), /New while open/);
  assert.equal(ui.context.document.activeElement, ui.elements.get('friendsList').children[0]);
});

test('notification links select an accepted conversation after its friends have loaded', async () => {
  const friend = friendship('other'), loaded = deferred();
  const ui = harness(player('local'), { friends: [friend], incoming: [], outgoing: [] }, call => call.route === 'friends' ? loaded.promise : undefined, { search: `?conversation=${friend.id}` });
  assert.equal(ui.api.inspect().selectedId, null);
  loaded.resolve({ friends: [friend], incoming: [], outgoing: [] }); await tick();
  assert.equal(ui.api.inspect().selectedId, friend.id);
  assert.equal(ui.calls.some(call => call.route === `friends/${friend.id}/messages`), true);
  ui.navigate('friends', '?conversation=not-a-friend'); await tick();
  assert.equal(ui.api.inspect().selectedId, friend.id, 'Unknown IDs cannot create a conversation');
  assert.equal(ui.calls.some(call => call.route === 'friends/not-a-friend/messages'), false);
});

test('opening a visible conversation reads only its displayed message snapshot and leaves bell checks separate', async () => {
  const friend = friendship('other'), incoming = message(friend.player, 'Unread message');
  friend.lastMessage = incoming; friend.unreadCount = 2;
  let notified = 0;
  const ui = harness(player('local'), { friends: [friend], incoming: [], outgoing: [] }, call => {
    if (call.route.endsWith('/messages')) return { friend, messages: [incoming] };
    if (call.route.endsWith('/read')) return { friend: { ...friend, unreadCount: 0 } };
  });
  ui.context.window.PepperNotifications = { load: () => { notified++; } };
  await tick(); assert.equal(reads(ui).length, 0);
  ui.api.openConversation(friend.id); await tick();
  assert.equal(reads(ui).length, 1); assert.deepEqual(reads(ui)[0].payload, { messageId: incoming.id });
  assert.equal(ui.api.inspect().entries[0].unreadCount, 0); assert.equal(notified, 1);
  assert.equal(ui.calls.some(call => call.route.includes('notifications/') && call.method === 'POST'), false);
  await ui.api.loadMessages(); await tick(); assert.equal(reads(ui).length, 1, 'A read snapshot is acknowledged once');
});

test('hidden conversations and stale conversation responses never mark messages as seen', async () => {
  const friend = friendship('other'), incoming = message(friend.player, 'Unread message');
  const ui = harness(player('local'), { friends: [friend], incoming: [], outgoing: [] }, call => call.route.endsWith('/messages') ? { friend, messages: [incoming] } : undefined, { hidden: true });
  await tick(); ui.api.openConversation(friend.id); await tick(); assert.equal(reads(ui).length, 0);
  ui.context.document.hidden = false; ui.listeners.get('visibilitychange')(); await tick();
  assert.equal(reads(ui).length, 1);
  for (const change of ['route', 'account', 'conversation']) {
    const response = deferred(), second = friendship('second');
    const stale = harness(player('local'), { friends: [friend, second], incoming: [], outgoing: [] }, call => call.route === `friends/${friend.id}/messages` ? response.promise : undefined);
    await tick(); stale.api.openConversation(friend.id);
    if (change === 'route') stale.navigate('games');
    else if (change === 'account') stale.setUser(player('someone-else'));
    else stale.api.openConversation(second.id);
    response.resolve({ friend, messages: [incoming] }); await tick();
    assert.equal(reads(stale).length, 0, change);
  }
});

test('stale read acknowledgements cannot replace a current conversation or a different account', async () => {
  for (const change of ['route', 'account', 'conversation']) {
    const friend = friendship('other'), second = friendship('second'), acknowledgement = deferred();
    const incoming = message(friend.player, 'Message before switch'); friend.lastMessage = incoming; friend.unreadCount = 1;
    const ui = harness(player('local'), { friends: [friend, second], incoming: [], outgoing: [] }, call => {
      if (call.route === `friends/${friend.id}/messages`) return { friend, messages: [incoming] };
      if (call.route.endsWith('/read')) return acknowledgement.promise;
    });
    await tick(); ui.api.openConversation(friend.id); await tick(); assert.equal(reads(ui).length, 1);
    if (change === 'route') ui.navigate('games');
    else if (change === 'account') ui.setUser(player('someone-else'));
    else ui.api.openConversation(second.id);
    acknowledgement.resolve({ friend: { ...friend, unreadCount: 0 } }); await tick();
    assert.equal(ui.api.inspect().entries.find(item => item.id === friend.id).unreadCount, 1, change);
  }
});

test('pending private replies stay below confirmed messages even when the server clock is ahead', async () => {
  const local = player('local'), friend = friendship('other');
  const confirmed = message(friend.player, 'Previous confirmed', { createdAt: '2099-01-01T00:00:00Z' });
  const ui = harness(local, { friends: [friend], incoming: [], outgoing: [] }, call => {
    if (call.route.endsWith('/messages') && call.method === 'GET') return { friend, messages: [confirmed] };
    if (call.route.endsWith('/messages') && call.method === 'POST') throw Object.assign(new Error('Too fast'), { status: 429, retryAfterMs: 200 });
  });
  await tick(); ui.api.openConversation(friend.id); await tick(); send(ui, 'New pending'); await tick();
  const rows = ui.elements.get('friendChatMessages').children;
  assert.match(allText(rows[0]), /Previous confirmed/); assert.match(allText(rows[1]), /New pending.*Sending…/);
});

test('conversation drafts survive friend switches but never survive account switches', async () => {
  const first = friendship('first'), second = friendship('second');
  const ui = harness(player('local'), { friends: [first, second], incoming: [], outgoing: [] }); await tick();
  ui.api.openConversation(first.id); ui.elements.get('friendChatInput').value = 'First private draft';
  ui.api.openConversation(second.id); assert.equal(ui.elements.get('friendChatInput').value, '');
  ui.elements.get('friendChatInput').value = 'Second private draft'; ui.api.openConversation(first.id);
  assert.equal(ui.elements.get('friendChatInput').value, 'First private draft');
  ui.setUser(player('someone-else')); await tick(); ui.api.openConversation(first.id);
  assert.equal(ui.elements.get('friendChatInput').value, '');
});

test('a delayed send receipt keeps the latest displayed message as the read snapshot', async () => {
  const local = player('local'), friend = friendship('other'), pending = deferred();
  const newer = message(friend.player, 'Newer incoming', { createdAt: '2026-10-08T12:01:00Z' });
  let loaded = 0, saved;
  const ui = harness(local, { friends: [friend], incoming: [], outgoing: [] }, call => {
    if (call.route.endsWith('/messages') && call.method === 'GET') return { friend, messages: ++loaded === 1 ? [] : [newer] };
    if (call.route.endsWith('/messages') && call.method === 'POST') {
      saved = message(local, call.payload.text, { clientMessageId: call.payload.clientMessageId, createdAt: '2026-10-08T12:00:00Z' });
      return pending.promise;
    }
    if (call.route.endsWith('/read')) return { friend: { ...friend, lastMessage: newer, unreadCount: 0 } };
  });
  await tick(); ui.api.openConversation(friend.id); await tick(); send(ui, 'Older send'); await tick();
  await ui.api.loadMessages(); await tick(); pending.resolve({ message: saved }); await tick();
  assert.deepEqual(Array.from(ui.api.inspect().messages, item => item.id), [saved.id, newer.id]);
  assert.equal(ui.api.inspect().entries[0].lastMessage.id, newer.id, 'A delayed receipt cannot replace a newer inbox preview');
  assert.equal(reads(ui).at(-1).payload.messageId, newer.id);
  const rows = ui.elements.get('friendChatMessages').children;
  assert.match(allText(rows[0]), /Older send/); assert.match(allText(rows[1]), /Newer incoming/);
});

test('Messages starts with every accepted friend and Back restores that list and its keyboard focus', async () => {
  const friend = friendship('other');
  const ui = harness(player('local'), { friends: [friend], incoming: [], outgoing: [] }); await tick();
  assert.equal(ui.elements.get('friendInbox').hidden, false);
  assert.equal(ui.elements.get('friendChatContent').hidden, true);
  assert.equal(ui.elements.get('friendChatBack').hidden, true);
  assert.equal(ui.elements.has('friendChatEmpty'), false);
  assert.equal(ui.elements.get('friendConversations').children.length, 1);
  assert.match(allText(ui.elements.get('friendConversations')), /other.*No messages yet\./);
  const row = ui.elements.get('friendConversations').children[0];
  const username = descendants(row).find(item => item.textContent === 'other');
  ui.elements.get('friendsPage').dispatch('click', username); await tick();
  assert.equal(ui.elements.get('friendInbox').hidden, true);
  assert.equal(ui.elements.get('friendChatContent').hidden, false);
  assert.equal(ui.elements.get('friendChatBack').hidden, false);
  ui.elements.get('friendChatInput').value = 'Unfinished reply';
  ui.elements.get('friendChatBack').click();
  assert.equal(ui.api.inspect().selectedId, null);
  assert.equal(ui.elements.get('friendInbox').hidden, false);
  assert.equal(ui.elements.get('friendChatContent').hidden, true);
  assert.equal(ui.elements.get('friendChatBack').hidden, true);
  const restoredRow = ui.elements.get('friendConversations').children[0];
  assert.equal(ui.context.document.activeElement, restoredRow);
  assert.equal(ui.navigations.length, 0, 'Back without a deep link stays local');
  ui.elements.get('friendsPage').dispatch('click', restoredRow); await tick();
  assert.equal(ui.elements.get('friendChatInput').value, 'Unfinished reply');
});

test('an empty Messages inbox displays the no-friends state without a conversation placeholder', async () => {
  const ui = harness(player('local')); await tick();
  assert.equal(ui.elements.get('friendInbox').hidden, false);
  assert.equal(ui.elements.get('friendConversationsEmpty').hidden, false);
  assert.equal(ui.elements.get('friendConversations').children.length, 0);
  assert.equal(ui.elements.get('friendChatContent').hidden, true);
  assert.equal(ui.elements.get('friendChatBack').hidden, true);
});

test('Back removes a notification deep link so refreshes cannot reopen the abandoned conversation', async () => {
  const friend = friendship('other');
  const ui = harness(player('local'), { friends: [friend], incoming: [], outgoing: [] }, undefined, { search: `?conversation=${friend.id}` }); await tick();
  assert.equal(ui.api.inspect().selectedId, friend.id);
  ui.elements.get('friendChatBack').click(); await tick();
  assert.equal(ui.context.window.location.search, '');
  assert.equal(ui.navigations.length, 1);
  assert.equal(ui.navigations[0].href, '/friends');
  assert.deepEqual({ ...ui.navigations[0].options }, { replace: true, focus: false, scroll: false });
  assert.equal(ui.api.inspect().selectedId, null);
  ui.api.onRoute(); await ui.api.load(); await tick();
  assert.equal(ui.api.inspect().selectedId, null);
  assert.equal(ui.elements.get('friendInbox').hidden, false);
  ui.navigate('games'); ui.navigate('friends'); await tick();
  assert.equal(ui.api.inspect().selectedId, null);
});

test('Back invalidates delayed conversation loads and read acknowledgements', async () => {
  const friend = friendship('other'), incoming = message(friend.player, 'Old conversation response');
  for (const mode of ['messages', 'read']) {
    const delayed = deferred();
    friend.lastMessage = incoming; friend.unreadCount = 1;
    const ui = harness(player('local'), { friends: [friend], incoming: [], outgoing: [] }, call => {
      if (call.route.endsWith('/messages')) return mode === 'messages' ? delayed.promise : { friend, messages: [incoming] };
      if (call.route.endsWith('/read')) return delayed.promise;
    });
    await tick(); ui.api.openConversation(friend.id); await tick(); ui.elements.get('friendChatBack').click();
    delayed.resolve(mode === 'messages' ? { friend, messages: [incoming] } : { friend: { ...friend, unreadCount: 0 } }); await tick();
    assert.equal(ui.api.inspect().selectedId, null, mode);
    assert.equal(ui.api.inspect().messages.length, 0, mode);
    assert.equal(ui.elements.get('friendInbox').hidden, false, mode);
    assert.equal(ui.api.inspect().entries[0].unreadCount, 1, mode);
    if (mode === 'messages') assert.equal(reads(ui).length, 0);
  }
});

test('pending messages still retry to their original friend after Back and another selection', async () => {
  const local = player('local'), first = friendship('first'), second = friendship('second'); let attempts = 0;
  const ui = harness(local, { friends: [first, second], incoming: [], outgoing: [] }, call => {
    if (call.method === 'POST' && call.route.endsWith('/messages')) {
      if (++attempts === 1) throw Object.assign(new Error('Too fast'), { status: 429, retryAfterMs: 200 });
      return { message: message(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }) };
    }
  });
  await tick(); ui.api.openConversation(first.id); await tick(); send(ui, 'Queued for first'); await tick();
  ui.elements.get('friendChatBack').click(); assert.equal(ui.api.inspect().outbox.length, 1);
  ui.api.openConversation(second.id); await tick();
  while (posts(ui).length < 2) await ui.runNextTimer();
  assert.equal(posts(ui)[0].route, `friends/${first.id}/messages`);
  assert.equal(posts(ui)[1].route, `friends/${first.id}/messages`);
  assert.deepEqual(posts(ui)[0].payload, posts(ui)[1].payload);
  assert.equal(ui.api.inspect().selectedId, second.id);
  assert.equal(ui.api.inspect().outbox.length, 0);
  assert.doesNotMatch(allText(ui.elements.get('friendChatMessages')), /Queued for first/);
});
