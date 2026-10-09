const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/announcement-popup.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const user = name => ({ accountId: `PPR-${name}`, username: name, balance: 100 });
const entry = (id, order = 0) => ({ id, title: `Announcement ${id}`, description: `Details for ${id}`, createdAt: new Date(1700000000000 + order * 1000).toISOString(), author: { accountId: 'PPR-admin', username: 'admin', role: 'admin', avatarUrl: '/pepper.svg' } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function harness({ user: initialUser = null, entries = [], server = { entries, seen: new Map() }, storage = new Map(), network, authLoading = false } = {}) {
  const elements = new Map(), timers = new Map(), calls = [], navigations = [], documentListeners = new Map(), windowListeners = new Map();
  let clock = Date.now(), timerId = 0, context;
  const classes = new Set(authLoading ? ['auth-loading'] : []);
  const node = (id = '') => {
    const listeners = new Map();
    const result = {
      id, children: [], dataset: {}, open: false, textContent: '', className: '',
      classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      addEventListener(type, callback) { listeners.set(type, [...(listeners.get(type) || []), callback]); },
      dispatch(type) { for (const callback of listeners.get(type) || []) callback({ preventDefault() {}, target: this }); },
      showModal() { this.open = true; },
      close() { this.open = false; queueMicrotask(() => { for (const callback of documentListeners.get('close') || []) callback({ target: this }); this.dispatch('close'); }); },
      focus() { document.activeElement = this; }, scrollIntoView() { this.scrolled = true; },
      querySelectorAll(selector) { return selector === '[data-entry-id]' ? this.children : []; }
    };
    return result;
  };
  for (const id of ['announcementPopup', 'announcementPopupTitle', 'announcementPopupAuthor', 'announcementPopupDate', 'announcementPopupDescription', 'announcementPopupMessage', 'announcementPopupRead', 'announcementPopupDismiss', 'announcementPopupClose', 'announcementEntries', 'authDialog', 'deleteAccountDialog']) elements.set(id, node(id));
  const document = {
    hidden: false, body: node('body'), activeElement: null,
    getElementById: id => elements.get(id), createElement: () => node(),
    querySelectorAll: selector => selector === 'dialog[open]' ? [...elements.values()].filter(element => element.open) : [],
    addEventListener(type, callback) { documentListeners.set(type, [...(documentListeners.get(type) || []), callback]); }
  };
  const boundary = {
    document, console, AbortController, state: { user: initialUser }, accountBanned: false, userIdentityRevision: 0, routeRevision: 0, pageKind: 'home',
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: clock + delay, interval: delay }); return id; },
      addEventListener(type, callback) { windowListeners.set(type, [...(windowListeners.get(type) || []), callback]); }
    },
    profileHref: name => `/profile/${name}`, profileAvatar: person => { const avatar = node(); avatar.avatar = person; return avatar; },
    playerRoleBadges: person => { const badges = node(); badges.textContent = person.role; return badges; },
    setUser(value) { if (context.state.user?.accountId !== value?.accountId) context.userIdentityRevision++; context.state.user = value; context.window.PepperAnnouncementPopup?.syncUser(); },
    navigateTo(route) { navigations.push(route); context.routeRevision++; context.pageKind = route === '/announcements' ? 'announcements' : 'games'; context.window.PepperAnnouncementPopup.onRoute(); },
    api: async (route, options = {}) => {
      const identity = context.state.user?.accountId || 'guest';
      const call = { route, identity, method: options.method || 'GET', body: options.body, signal: options.signal }; calls.push(call);
      const result = network ? await network(call, server) : undefined;
      if (result !== undefined) return result;
      if (route === 'announcements') return { entries: server.entries };
      if (route === 'announcements/unseen') return { entries: server.entries.filter(item => !server.seen.get(identity)?.has(item.id)) };
      const match = /^announcements\/([^/]+)\/seen$/.exec(route);
      if (match && call.method === 'POST') {
        const seen = server.seen.get(identity) || new Set(); seen.add(decodeURIComponent(match[1])); server.seen.set(identity, seen); return { ok: true };
      }
      throw new Error(`Unexpected request ${route}`);
    }
  };
  context = vm.createContext(boundary);
  vm.runInContext(source.replace('window.PepperAnnouncementPopup = { syncUser, onRoute, syncEntries };', 'window.PepperAnnouncementPopup = { syncUser, onRoute, syncEntries, inspect: () => popup, load, sendSeen };'), context);
  return {
    api: context.window.PepperAnnouncementPopup, elements, document, context, server, storage, calls, navigations,
    setUser: boundary.setUser,
    click: id => elements.get(id).dispatch('click'),
    route(route) { boundary.navigateTo(route); },
    event(type) { for (const callback of documentListeners.get(type) || []) callback(); },
    windowEvent(type) { for (const callback of windowListeners.get(type) || []) callback(); },
    article(id) { const article = node(); article.dataset.entryId = id; elements.get('announcementEntries').append(article); return article; },
    async advance(milliseconds) {
      const end = clock + milliseconds;
      for (let count = 0; count < 10000; count++) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { clock = end; await tick(); return; }
        clock = next[1].at; timers.delete(next[0]); if (next[1].interval) timers.set(next[0], { ...next[1], at: clock + next[1].interval });
        next[1].callback(); await tick();
      }
      throw new Error('Too many timers');
    }
  };
}

test('first visits show the newest unseen announcement site-wide with the author identity', async () => {
  const ui = harness({ user: user('reader'), entries: [entry('older'), entry('newer', 1)] }); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, true);
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement newer');
  assert.equal(ui.elements.get('announcementPopupDescription').textContent, 'Details for newer');
  const author = ui.elements.get('announcementPopupAuthor').children[0];
  assert.equal(author.href, '/profile/admin'); assert.equal(author.children[0].avatar.avatarUrl, '/pepper.svg');
  assert.equal(author.children[2].textContent, 'admin');
  assert.equal(ui.document.activeElement, ui.elements.get('announcementPopupDismiss'));
  assert.deepEqual(ui.calls.map(call => call.route), ['announcements/unseen']);
});

test('announcement popups retain the original author and show distinct editors', async () => {
  const announcement = entry('edited'), editor = { ...user('editor'), role: 'admin' };
  announcement.contributors = [announcement.author, editor, editor];
  const ui = harness({ user: user('reader'), entries: [announcement] }); await tick();
  const authors = ui.elements.get('announcementPopupAuthor').children;
  assert.deepEqual(authors.map(author => author.children[1].textContent), ['admin', 'editor']);
  assert.deepEqual(authors.map(author => author.href), ['/profile/admin', '/profile/editor']);
});

test('dismiss, Escape, and Close acknowledge only the displayed entry and advance the queue', async () => {
  const reader = user('reader'), ui = harness({ user: reader, entries: [entry('oldest'), entry('middle', 1), entry('newest', 2)] }); await tick();
  ui.click('announcementPopupDismiss'); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement middle');
  assert.deepEqual([...ui.server.seen.get(reader.accountId)], ['newest']);
  ui.elements.get('announcementPopup').dispatch('cancel'); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement oldest');
  ui.click('announcementPopupClose'); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  assert.deepEqual([...ui.server.seen.get(reader.accountId)], ['newest', 'middle', 'oldest']);
  assert.ok(ui.calls.filter(call => call.method === 'POST').every(call => call.body === '{}'));
});

test('account acknowledgments survive reload through the database and leave unacknowledged entries unseen', async () => {
  const reader = user('reader'), server = { entries: [entry('old'), entry('new', 1)], seen: new Map() };
  const first = harness({ user: reader, server }); await tick(); first.click('announcementPopupDismiss'); await tick();
  const next = harness({ user: reader, server }); await tick();
  assert.equal(next.elements.get('announcementPopupTitle').textContent, 'Announcement old');
  assert.equal(server.seen.get(reader.accountId).has('old'), false);
});

test('guests persist only acknowledged IDs locally and never send seen requests', async () => {
  const storage = new Map(), entries = [entry('old'), entry('new', 1)];
  const first = harness({ entries, storage }); await tick(); first.click('announcementPopupDismiss'); await tick();
  assert.equal(first.calls.filter(call => call.method === 'POST').length, 0);
  assert.deepEqual(JSON.parse(storage.get('pepper.announcements.guest.seen')), ['new']);
  const next = harness({ entries, storage }); await tick();
  assert.equal(next.elements.get('announcementPopupTitle').textContent, 'Announcement old');
});

test('guest seen IDs do not leak into a signed-in account or another account', async () => {
  const first = user('first'), second = user('second'), ui = harness({ entries: [entry('news')] }); await tick();
  ui.click('announcementPopupDismiss'); await tick();
  ui.setUser(first); await tick(); assert.equal(ui.elements.get('announcementPopup').open, true);
  ui.click('announcementPopupDismiss'); await tick();
  ui.setUser(second); await tick(); assert.equal(ui.elements.get('announcementPopup').open, true);
  assert.equal(ui.server.seen.get(second.accountId), undefined);
  ui.setUser(null); await tick(); assert.equal(ui.elements.get('announcementPopup').open, false);
});

test('loading waits for authentication and modal dialogs without acknowledging hidden announcements', async () => {
  const ui = harness({ user: user('reader'), entries: [entry('news')], authLoading: true }); await tick();
  assert.equal(ui.calls.length, 0);
  ui.elements.get('authDialog').showModal(); ui.document.body.classList.remove('auth-loading'); ui.api.syncUser(); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false); assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
  ui.elements.get('authDialog').close(); await tick(); assert.equal(ui.elements.get('announcementPopup').open, true);
  ui.elements.get('deleteAccountDialog').showModal(); ui.api.syncUser(); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  ui.elements.get('deleteAccountDialog').close(); await tick(); assert.equal(ui.elements.get('announcementPopup').open, true);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('banned screens close popups and do not load or acknowledge announcements', async () => {
  const ui = harness({ user: user('reader'), entries: [entry('news')] }); await tick();
  ui.context.accountBanned = true; ui.setUser(null); await tick();
  const count = ui.calls.length; await ui.advance(31000);
  assert.equal(ui.elements.get('announcementPopup').open, false); assert.equal(ui.calls.length, count);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('stale account and route loads cannot populate or reopen the wrong popup', async () => {
  const pending = deferred(); let delayed = true;
  const ui = harness({ user: user('first'), entries: [entry('current')], network: call => call.method === 'GET' && delayed ? (delayed = false, pending.promise) : undefined });
  ui.setUser(user('second')); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement current');
  pending.resolve({ entries: [entry('stale')] }); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement current');
  const routePending = deferred(); let routeDelay = true;
  const next = harness({ entries: [entry('current')], network: call => call.method === 'GET' && routeDelay ? (routeDelay = false, routePending.promise) : undefined });
  next.route('/games'); await tick(); routePending.resolve({ entries: [entry('stale')] }); await tick();
  assert.equal(next.elements.get('announcementPopupTitle').textContent, 'Announcement current');
});

test('rate-limited seen acknowledgments retry automatically without redisplaying the entry', async () => {
  let attempts = 0;
  const ui = harness({ user: user('reader'), entries: [entry('news')], network: call => {
    if (call.method === 'POST' && ++attempts === 1) throw Object.assign(new Error('Too fast.'), { status: 429, retryAfterMs: 5000 });
  } }); await tick(); ui.click('announcementPopupDismiss'); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  await ui.api.load(); assert.equal(ui.elements.get('announcementPopup').open, false);
  await ui.advance(4999); assert.equal(attempts, 1);
  await ui.advance(1); assert.equal(attempts, 2); assert.equal(ui.server.seen.get('PPR-reader').has('news'), true);
});

test('pending account acknowledgments survive reload and retry without affecting another account', async () => {
  const storage = new Map(), server = { entries: [entry('news')], seen: new Map() };
  const first = harness({ user: user('first'), server, storage, network: call => { if (call.method === 'POST') throw new Error('Offline'); } });
  await tick(); first.click('announcementPopupDismiss'); await tick();
  assert.deepEqual(JSON.parse(storage.get('pepper.announcements.pending.PPR-first')), ['news']);
  const second = harness({ user: user('second'), server, storage }); await tick();
  assert.equal(second.elements.get('announcementPopup').open, true); assert.equal(second.calls.filter(call => call.method === 'POST').length, 0);
  const returning = harness({ user: user('first'), server, storage }); await tick();
  assert.equal(returning.elements.get('announcementPopup').open, false); assert.equal(server.seen.get('PPR-first').has('news'), true);
  assert.deepEqual(JSON.parse(storage.get('pepper.announcements.pending.PPR-first')), []);
});

test('an unresolved previous account acknowledgment cannot block or mutate a new account', async () => {
  const pending = deferred();
  const ui = harness({ user: user('first'), entries: [entry('news')], network: call => call.method === 'POST' && call.identity === 'PPR-first' ? pending.promise : undefined });
  await tick(); ui.click('announcementPopupDismiss'); await tick();
  ui.setUser(user('second')); await tick(); ui.click('announcementPopupDismiss'); await tick();
  assert.equal(ui.server.seen.get('PPR-second').has('news'), true);
  pending.resolve({ ok: true }); await tick();
  assert.equal(ui.api.inspect().identity, 'PPR-second'); assert.equal(ui.api.inspect().pending.size, 0);
});

test('View announcement acknowledges one entry and focuses its article when the page loads', async () => {
  const ui = harness({ user: user('reader'), entries: [entry('old'), entry('new', 1)] }); await tick();
  ui.click('announcementPopupRead'); await tick();
  assert.deepEqual(ui.navigations, ['/announcements']); assert.equal(ui.elements.get('announcementPopup').open, false);
  const article = ui.article('new'); ui.api.syncEntries(ui.server.entries); await tick();
  assert.equal(ui.document.activeElement, article); assert.equal(article.scrolled, true);
  assert.deepEqual([...ui.server.seen.get('PPR-reader')], ['new']);
  ui.route('/games'); await tick(); assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement old');
});

test('new announcements are discovered while visible and deleted entries leave the queue', async () => {
  const ui = harness({ user: user('reader') }); await tick(); assert.equal(ui.elements.get('announcementPopup').open, false);
  ui.server.entries = [entry('news')]; await ui.advance(30000);
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement news');
  ui.server.entries = []; ui.api.syncEntries([]); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false); assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('account full entry renders cannot bypass the server unseen filter or show the author their own post', async () => {
  const reader = user('admin'), own = entry('own'), server = { entries: [own], seen: new Map([[reader.accountId, new Set(['own'])]]) };
  const ui = harness({ user: reader, server }); await tick(); ui.api.syncEntries(server.entries); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('deleted and unknown authors are shown without invalid profile links', async () => {
  const deleted = { ...entry('deleted'), author: { accountId: null, username: 'Deleted player' } };
  const ui = harness({ entries: [deleted] }); await tick();
  assert.equal(ui.elements.get('announcementPopupAuthor').children[0].href, undefined);
  ui.server.entries = [{ ...entry('unknown', 1), author: null }]; await ui.api.load();
  assert.equal(ui.elements.get('announcementPopupAuthor').textContent, 'Unknown author');
});

test('a stale unseen read cannot restore an announcement removed by a fresher parent snapshot', async () => {
  const pending = deferred(); let delayed = true;
  const ui = harness({ user: user('reader'), entries: [entry('deleted')], network: call => {
    if (call.method === 'GET' && delayed) { delayed = false; return pending.promise; }
  } });
  ui.server.entries = []; ui.api.syncEntries([]); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  pending.resolve({ entries: [entry('deleted')] }); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  assert.equal(ui.api.inspect().entries.length, 0); assert.equal(ui.calls.filter(call => call.method === 'GET').length, 2);
});

test('fresh or repeated parent snapshots still discover newly published unseen announcements', async () => {
  const ui = harness({ user: user('reader') }); await tick();
  ui.api.syncEntries([]); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  ui.server.entries = [entry('published')]; ui.api.syncEntries(ui.server.entries); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement published');
  assert.equal(ui.elements.get('announcementPopup').open, true);
  ui.api.syncEntries(ui.server.entries); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement published');
});
