const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/notifications.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const player = username => ({ accountId: `PPR-${username}`, username, role: 'player', banned: false });
const incoming = (number, extra = {}) => ({ id: `message:${number}`, type: 'message', friendId: 'friend-sage', player: player('Sage'), text: `Message ${number}`, createdAt: '2026-10-08T12:30:00.000Z', read: false, ...extra });
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

// Execute the production module while replacing its account, DOM, clock, and network boundaries.
function harness(user = null, entries = [], network) {
  const elements = new Map(), calls = [], timers = new Map(), intervals = [], listeners = new Map(), windowListeners = new Map(), navigation = [];
  const clock = { now: Date.parse('2026-10-08T13:00:00.000Z') }, feed = { notifications: entries, unreadCount: entries.filter(entry => !entry.read).length };
  let timerId = 0, context;
  const node = (id = '', attrs = '') => {
    const events = new Map(), classes = new Set();
    return {
      id, children: [], dataset: {}, textContent: '', hidden: /\bhidden\b/.test(attrs), open: false,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      append(...children) { for (const child of children) child.parentNode = this; this.children.push(...children); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      setAttribute(name, value) { this[name] = value; }, addEventListener(name, callback) { events.set(name, callback); },
      dispatch(name, target = this) { return events.get(name)?.({ target, preventDefault() {} }); },
      closest(selector) { return selector === '[data-notification-id]' && this.dataset.notificationId ? this : this.parentNode?.closest(selector) || null; },
      focus() { document.activeElement = this; }
    };
  };
  for (const match of html.matchAll(/<[a-z][a-z0-9]*\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(match[2], node(match[2], match[1]));
  const document = { getElementById: id => elements.get(id), createElement: () => node(), hidden: false, activeElement: null, addEventListener: (name, callback) => listeners.set(name, callback) };
  const boundary = {
    document, console,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } },
    state: { user: null, accountSubmitting: false }, accountBanned: false, userIdentityRevision: 0, pageKind: 'home',
    window: {
      setTimeout(callback, delay = 0) { const id = ++timerId; timers.set(id, { callback, at: clock.now + delay, delay }); return id; },
      clearTimeout: id => timers.delete(id), addEventListener: (name, callback) => windowListeners.set(name, callback)
    },
    setInterval: (callback, delay) => intervals.push({ callback, delay }),
    profileAvatar: person => { const image = node(); image.dataset.accountId = person.accountId; return image; },
    playerRoleBadges: () => node(), message: (target, text) => { target.textContent = text; },
    navigateTo: href => navigation.push(href),
    setUser(value) {
      if (context.state.user?.accountId !== value?.accountId) context.userIdentityRevision++;
      context.state.user = value; context.window.PepperNotifications.syncUser();
    },
    api: async (route, options = {}) => {
      const call = { route, method: options.method || 'GET', payload: options.body ? JSON.parse(options.body) : null }; calls.push(call);
      const custom = network ? await network(call) : undefined;
      if (custom !== undefined) return custom;
      if (route === 'notifications/read') {
        feed.notifications = feed.notifications.map(entry => call.payload.ids.includes(entry.id) ? { ...entry, read: true } : entry);
        feed.unreadCount = feed.notifications.filter(entry => !entry.read).length;
      }
      return { notifications: feed.notifications.map(entry => ({ ...entry })), unreadCount: feed.unreadCount };
    }
  };
  context = vm.createContext(boundary); vm.runInContext(source, context); boundary.setUser(user);
  return {
    api: context.window.PepperNotifications, context, elements, calls, timers, intervals, listeners, windowListeners, navigation, feed, clock, setUser: boundary.setUser,
    open() { const menu = elements.get('notificationMenu'); menu.open = true; menu.dispatch('toggle'); },
    close() { const menu = elements.get('notificationMenu'); menu.open = false; menu.dispatch('toggle'); },
    async poll() { intervals.forEach(interval => interval.callback()); await tick(); },
    async nextTimer() {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; assert.ok(next, 'A claim reminder is scheduled');
      timers.delete(next[0]); clock.now = Math.max(clock.now, next[1].at); next[1].callback(); await tick(); return next[1].delay;
    }
  };
}
const allText = element => [element.textContent, ...element.children.map(allText)].filter(Boolean).join(' ');
const reads = ui => ui.calls.filter(call => call.method === 'POST');
const gets = ui => ui.calls.filter(call => call.method === 'GET');

test('the global bell is private to signed-in, unbanned accounts', async () => {
  const ui = harness(); await tick();
  assert.equal(ui.elements.get('notificationMenu').hidden, true); assert.equal(ui.calls.length, 0);
  ui.open(); await ui.poll(); assert.equal(ui.calls.length, 0);
  ui.setUser(player('local')); await tick();
  assert.equal(ui.elements.get('notificationMenu').hidden, false); assert.equal(gets(ui).length, 1);
  ui.context.accountBanned = true; ui.api.syncUser(); await ui.poll();
  assert.equal(ui.elements.get('notificationMenu').hidden, true); assert.equal(ui.elements.get('notificationMenu').open, false);
  assert.equal(gets(ui).length, 1);
});

test('unchecked messages display a numeric badge, sender, safe preview, and date', async () => {
  const ui = harness(player('local'), [incoming(1, { text: '<script>alert(1)</script>' }), incoming(2)]); await tick();
  assert.equal(ui.elements.get('notificationBadge').hidden, false); assert.equal(ui.elements.get('notificationBadge').textContent, '2');
  assert.equal(ui.elements.get('notificationBell')['aria-label'], 'Notifications, 2 unread');
  const rows = ui.elements.get('notificationList').children;
  assert.equal(rows.length, 2); assert.match(allText(rows[0]), /Sage <script>alert\(1\)<\/script>/);
  assert.equal(rows[0].children[2].dateTime, '2026-10-08T12:30:00.000Z');
  assert.match(rows[0].children[2].textContent, /Oct 8/);
  assert.match(rows[0].className, /notification-unread/); assert.equal(reads(ui).length, 0);
});

test('opening the bell checks only its rendered snapshot and preserves arrivals during the read', async () => {
  const response = deferred();
  const ui = harness(player('local'), [incoming(1), incoming(2)], call => call.method === 'POST' ? response.promise : undefined);
  await tick(); ui.elements.get('accountMenu').open = true; ui.open(); await tick();
  assert.equal(ui.elements.get('accountMenu').open, false);
  assert.deepEqual(reads(ui)[0].payload.ids, ['message:1', 'message:2']);
  ui.feed.notifications = [incoming(3), incoming(1, { read: true }), incoming(2, { read: true })]; ui.feed.unreadCount = 1;
  response.resolve({ notifications: ui.feed.notifications, unreadCount: 1 }); await tick();
  assert.equal(ui.elements.get('notificationBadge').textContent, '1'); assert.equal(reads(ui).length, 1);
  assert.match(allText(ui.elements.get('notificationList')), /Message 3/);
  await ui.poll(); assert.equal(reads(ui).length, 1, 'An open menu does not automatically check later arrivals');
});

test('new messages appear while the Messages page and notification menu remain open', async () => {
  const ui = harness(player('local')); await tick(); ui.context.pageKind = 'friends'; ui.open(); await tick();
  ui.feed.notifications = [incoming(1), incoming(2)]; ui.feed.unreadCount = 2;
  await ui.poll();
  assert.equal(ui.elements.get('notificationBadge').textContent, '2'); assert.equal(reads(ui).length, 0);
  assert.match(allText(ui.elements.get('notificationList')), /Message 2/);
  ui.close(); ui.open(); await tick();
  assert.equal(reads(ui).length, 1); assert.deepEqual(reads(ui)[0].payload.ids, ['message:1', 'message:2']);
  assert.equal(ui.elements.get('notificationBadge').hidden, true);
});

test('an older unread GET cannot restore a badge after checking notifications', async () => {
  const stale = deferred(); let number = 0;
  const ui = harness(player('local'), [incoming(1)], call => call.method === 'GET' && ++number === 2 ? stale.promise : undefined);
  await tick(); const pending = ui.api.load(); ui.open(); await tick();
  assert.equal(ui.elements.get('notificationBadge').hidden, true);
  stale.resolve({ notifications: [incoming(1)], unreadCount: 1 }); await pending; await tick();
  assert.equal(ui.elements.get('notificationBadge').hidden, true);
  assert.doesNotMatch(ui.elements.get('notificationList').children[0].className, /notification-unread/);
});

test('late private feeds and read responses cannot leak across account changes', async () => {
  for (const operation of ['load', 'read']) {
    const old = deferred(); let first = true;
    const ui = harness(player('first'), [incoming(1)], call => {
      if (operation === 'load' && call.method === 'GET' && first) { first = false; return old.promise; }
      if (operation === 'read' && call.method === 'POST') return old.promise;
    });
    if (operation === 'read') { await tick(); ui.open(); }
    ui.feed.notifications = [incoming(2, { text: 'New account message' })]; ui.feed.unreadCount = 1;
    ui.setUser(player('second')); await tick();
    old.resolve({ notifications: [incoming(1, { text: 'Old private message' })], unreadCount: 9 }); await tick();
    assert.equal(ui.elements.get('notificationBadge').textContent, '1', operation);
    assert.match(allText(ui.elements.get('notificationList')), /New account message/, operation);
    assert.doesNotMatch(allText(ui.elements.get('notificationList')), /Old private message/, operation);
    assert.equal(ui.elements.get('notificationMenu').open, false, operation);
  }
});

test('hidden pages stop polling and refresh promptly when visible or connected again', async () => {
  const ui = harness(player('local')); await tick(); const initial = gets(ui).length;
  ui.context.document.hidden = true; await ui.poll(); await ui.api.load();
  assert.equal(gets(ui).length, initial);
  ui.feed.notifications = [incoming(1)]; ui.feed.unreadCount = 1; ui.context.document.hidden = false;
  ui.listeners.get('visibilitychange')(); await tick();
  assert.equal(ui.elements.get('notificationBadge').textContent, '1');
  ui.windowListeners.get('online')(); await tick(); assert.equal(gets(ui).length, initial + 2);
});

test('claim reminders refresh at the next claim time and each subsequent claim cycle', async () => {
  const nextClaimAt = Date.parse('2026-10-08T13:00:01.000Z');
  const ui = harness({ ...player('local'), nextClaimAt }); await tick();
  const reminder = due => ({ id: `claim:${due}`, type: 'claim', text: 'Tokens ready', createdAt: new Date(due).toISOString(), read: false });
  ui.feed.notifications = [reminder(nextClaimAt)]; ui.feed.unreadCount = 1;
  assert.equal(await ui.nextTimer(), 1000); assert.equal(ui.elements.get('notificationBadge').textContent, '1');
  assert.match(allText(ui.elements.get('notificationList')), /Tokens ready Claim tokens/);
  assert.equal(ui.timers.size, 0, 'A ready claim does not create an immediate timer loop');
  const later = nextClaimAt + 3600000;
  ui.feed.notifications = []; ui.feed.unreadCount = 0; ui.setUser({ ...player('local'), nextClaimAt: later }); await tick();
  assert.equal(ui.elements.get('notificationBadge').hidden, true);
  ui.feed.notifications = [reminder(later)]; ui.feed.unreadCount = 1;
  assert.equal(await ui.nextTimer(), 3600000); assert.equal(ui.elements.get('notificationBadge').textContent, '1');
});

test('claim readiness while hidden is refreshed upon returning to the page', async () => {
  const nextClaimAt = Date.parse('2026-10-08T13:00:01.000Z');
  const ui = harness({ ...player('local'), nextClaimAt }); await tick(); const initial = gets(ui).length;
  ui.context.document.hidden = true; await ui.nextTimer(); assert.equal(gets(ui).length, initial);
  ui.feed.notifications = [{ id: `claim:${nextClaimAt}`, type: 'claim', text: 'Tokens ready', createdAt: new Date(nextClaimAt).toISOString(), read: false }]; ui.feed.unreadCount = 1;
  ui.context.document.hidden = false; ui.listeners.get('visibilitychange')(); await tick();
  assert.equal(ui.elements.get('notificationBadge').textContent, '1');
});

test('notification clicks open the exact conversation or Overview claim and check that entry', async () => {
  for (const type of ['message', 'claim']) {
    const entry = type === 'message' ? incoming(1, { friendId: 'friend+id' }) : { id: 'claim:1', type: 'claim', text: 'Tokens ready', createdAt: '2026-10-08T13:00:00.000Z', read: false };
    const ui = harness(player('local'), [entry]); await tick();
    const row = ui.elements.get('notificationList').children[0];
    ui.elements.get('notificationMenu').open = true;
    ui.elements.get('notificationList').dispatch('click', row.children[0].children[0]); await tick();
    assert.equal(ui.elements.get('notificationMenu').open, false);
    assert.deepEqual(reads(ui)[0].payload.ids, [entry.id]);
    assert.equal(ui.navigation[0], type === 'message' ? '/friends?conversation=friend%2Bid' : '/#tokens');
  }
});

test('checking a truncated feed preserves unread items outside the rendered snapshot', async () => {
  const entries = Array.from({ length: 101 }, (_, index) => incoming(index));
  const ui = harness(player('local'), entries); await tick(); ui.open(); await tick();
  assert.equal(reads(ui)[0].payload.ids.length, 100);
  assert.equal(ui.elements.get('notificationBadge').textContent, '1');
});

test('notification check failures preserve the unchecked badge and can retry on reopening', async () => {
  let fail = true;
  const ui = harness(player('local'), [incoming(1)], call => {
    if (call.method === 'POST' && fail) { fail = false; throw new Error('Offline'); }
  });
  await tick(); ui.open(); await tick();
  assert.equal(ui.elements.get('notificationBadge').textContent, '1');
  ui.close(); ui.open(); await tick();
  assert.equal(reads(ui).length, 2); assert.equal(ui.elements.get('notificationBadge').hidden, true);
});

test('authentication expiry clears the bell and unread state', async () => {
  let expired = false;
  const ui = harness(player('local'), [incoming(1)], () => {
    if (expired) { const error = new Error('Sign in required.'); error.status = 401; throw error; }
  }); await tick();
  expired = true; await ui.api.load(); await tick();
  assert.equal(ui.context.state.user, null);
  assert.equal(ui.elements.get('notificationMenu').hidden, true);
  assert.equal(ui.elements.get('notificationBadge').hidden, true);
  assert.equal(ui.elements.get('notificationList').children.length, 0);
});
