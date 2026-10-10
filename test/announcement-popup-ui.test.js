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
const deviceKey = 'pepper.announcements.device.seen';
const storedSeen = ui => JSON.parse(ui.storage.get(deviceKey) || '[]');
const assertPublicReadsOnly = ui => assert.ok(ui.calls.every(call => call.route === 'announcements' && call.method === 'GET'));

function harness({ user: initialUser = null, entries = [], server = { entries, seen: new Map() }, storage = new Map(), network, authLoading = false, storageFault = null } = {}) {
  const elements = new Map(), timers = new Map(), calls = [], navigations = [], storageWrites = [], documentListeners = new Map(), windowListeners = new Map();
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
    localStorage: {
      get length() { if (storageFault === 'all') throw new Error('Storage unavailable'); return storage.size; },
      key(index) { if (storageFault === 'all') throw new Error('Storage unavailable'); return [...storage.keys()][index] ?? null; },
      getItem(key) { if (storageFault === 'all') throw new Error('Storage unavailable'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageFault) throw new Error('Storage unavailable'); storageWrites.push({ key, value }); storage.set(key, value); },
      removeItem(key) { if (storageFault) throw new Error('Storage unavailable'); storage.delete(key); }
    },
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
  vm.runInContext(source.replace(/window\.PepperAnnouncementPopup = \{ ([^}]+) \};/, 'window.PepperAnnouncementPopup = { $1, inspect: () => popup, load };'), context);
  return {
    api: context.window.PepperAnnouncementPopup, elements, document, context, server, storage, calls, navigations, storageWrites,
    setUser: boundary.setUser,
    click: id => elements.get(id).dispatch('click'),
    route(route) { boundary.navigateTo(route); },
    event(type) { for (const callback of documentListeners.get(type) || []) callback(); },
    windowEvent(type, event = {}) { for (const callback of windowListeners.get(type) || []) callback(event); },
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
  assert.deepEqual(ui.calls.map(call => call.route), ['announcements']);
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
  const ui = harness({ user: user('reader'), entries: [entry('oldest'), entry('middle', 1), entry('newest', 2)] }); await tick();
  ui.click('announcementPopupDismiss'); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement middle');
  assert.deepEqual(storedSeen(ui), ['newest']);
  ui.elements.get('announcementPopup').dispatch('cancel'); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement oldest');
  ui.click('announcementPopupClose'); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  assert.deepEqual(storedSeen(ui), ['middle', 'newest', 'oldest']);
  assert.equal(ui.server.seen.size, 0); assertPublicReadsOnly(ui);
});

test('account acknowledgments survive reload on the same device and leave unacknowledged entries unseen', async () => {
  const reader = user('reader'), server = { entries: [entry('old'), entry('new', 1)], seen: new Map() }, storage = new Map();
  const first = harness({ user: reader, server, storage }); await tick(); first.click('announcementPopupDismiss'); await tick();
  const next = harness({ user: reader, server, storage }); await tick();
  assert.equal(next.elements.get('announcementPopupTitle').textContent, 'Announcement old');
  assert.deepEqual(storedSeen(next), ['new']); assert.equal(server.seen.size, 0);
  assertPublicReadsOnly(first); assertPublicReadsOnly(next);
});

test('guests persist only acknowledged IDs locally and never send seen requests', async () => {
  const storage = new Map(), entries = [entry('old'), entry('new', 1)];
  const first = harness({ entries, storage }); await tick(); first.click('announcementPopupDismiss'); await tick();
  assert.equal(first.calls.filter(call => call.method === 'POST').length, 0);
  assert.deepEqual(storedSeen(first), ['new']);
  const next = harness({ entries, storage }); await tick();
  assert.equal(next.elements.get('announcementPopupTitle').textContent, 'Announcement old');
});

test('device acknowledgments survive signing in, switching accounts, and logging out', async () => {
  const first = user('first'), second = user('second'), ui = harness({ entries: [entry('news')] }); await tick();
  ui.click('announcementPopupDismiss'); await tick();
  ui.setUser(first); await tick(); assert.equal(ui.elements.get('announcementPopup').open, false);
  ui.setUser(second); await tick(); assert.equal(ui.elements.get('announcementPopup').open, false);
  ui.setUser(null); await tick(); assert.equal(ui.elements.get('announcementPopup').open, false);
  await ui.advance(31000); assert.equal(ui.elements.get('announcementPopup').open, false);
  assert.deepEqual(storedSeen(ui), ['news']); assertPublicReadsOnly(ui);
});

test('a new browser sees announcements previously acknowledged by the account on another device', async () => {
  const reader = user('reader'), server = { entries: [entry('news')], seen: new Map([[reader.accountId, new Set(['news'])]]) };
  const first = harness({ user: reader, server }); await tick();
  assert.equal(first.elements.get('announcementPopup').open, true);
  first.click('announcementPopupDismiss'); await tick();
  const next = harness({ user: reader, server }); await tick();
  assert.equal(next.elements.get('announcementPopup').open, true);
  assertPublicReadsOnly(first); assertPublicReadsOnly(next);
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

test('legacy guest and every account pending key migrate into the device acknowledgments', async () => {
  const storage = new Map([
    [deviceKey, JSON.stringify(['device'])],
    ['pepper.announcements.guest.seen', JSON.stringify(['guest', 'duplicate'])],
    ['pepper.announcements.pending.PPR-first', JSON.stringify(['first', 'duplicate'])],
    ['pepper.announcements.pending.PPR-second', JSON.stringify(['second'])],
    ['unrelated.preference', 'keep']
  ]);
  const entries = ['device', 'guest', 'first', 'second', 'duplicate', 'fresh'].map((id, order) => entry(id, order));
  const ui = harness({ user: user('third'), storage, entries }); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement fresh');
  assert.deepEqual(new Set(storedSeen(ui)), new Set(['device', 'guest', 'first', 'second', 'duplicate']));
  assert.equal(storage.get('unrelated.preference'), 'keep');
  ui.click('announcementPopupDismiss'); await tick(); ui.setUser(null); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false); assertPublicReadsOnly(ui);
});

test('invalid legacy storage data cannot break popup loading or acknowledge valid entries', async () => {
  const storage = new Map([
    [deviceKey, '{invalid'],
    ['pepper.announcements.guest.seen', JSON.stringify({ id: 'news' })],
    ['pepper.announcements.pending.PPR-first', JSON.stringify([null, 4, 'seen'])],
    ['pepper.announcements.pending.PPR-second', 'not json']
  ]);
  const ui = harness({ storage, entries: [entry('seen'), entry('news', 1)] }); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement news');
  ui.click('announcementPopupDismiss'); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  assert.deepEqual(new Set(storedSeen(ui)), new Set(['seen', 'news'])); assertPublicReadsOnly(ui);
});

for (const storageFault of ['write', 'all']) test(`unavailable ${storageFault === 'write' ? 'storage writes' : 'storage'} preserves in-memory acknowledgments across account changes`, async () => {
  const ui = harness({ user: user('first'), entries: [entry('news')], storageFault }); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, true);
  ui.click('announcementPopupDismiss'); await tick();
  ui.setUser(user('second')); await tick(); ui.setUser(null); await tick();
  await ui.api.load(); await ui.advance(31000);
  assert.equal(ui.elements.get('announcementPopup').open, false); assertPublicReadsOnly(ui);
});

test('another tab dismissal closes its matching popup and advances without acknowledging other entries', async () => {
  const storage = new Map(), entries = [entry('old'), entry('new', 1)];
  const first = harness({ storage, entries }), second = harness({ storage, entries, user: user('reader') }); await tick();
  first.click('announcementPopupDismiss'); await tick();
  second.windowEvent('storage', { key: deviceKey, newValue: storage.get(deviceKey), storageArea: second.context.localStorage }); await tick();
  assert.equal(second.elements.get('announcementPopupTitle').textContent, 'Announcement old');
  assert.deepEqual(storedSeen(second), ['new']);
  second.click('announcementPopupDismiss'); await tick();
  first.windowEvent('storage', { key: deviceKey, newValue: storage.get(deviceKey), storageArea: first.context.localStorage }); await tick();
  assert.equal(first.elements.get('announcementPopup').open, false);
  assert.deepEqual(new Set(storedSeen(first)), new Set(['new', 'old']));
  assertPublicReadsOnly(first); assertPublicReadsOnly(second);
});

test('storage events merge existing device acknowledgments and ignore unrelated or malformed changes', async () => {
  const storage = new Map([[deviceKey, JSON.stringify(['known'])]]);
  const ui = harness({ storage, entries: [entry('known'), entry('old', 1), entry('new', 2)] }); await tick();
  ui.windowEvent('storage', { key: 'unrelated.preference', newValue: JSON.stringify(['new']) }); await tick();
  ui.windowEvent('storage', { key: deviceKey, newValue: '{invalid' }); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement new');
  storage.set(deviceKey, JSON.stringify(['new']));
  ui.windowEvent('storage', { key: deviceKey, newValue: JSON.stringify(['new']), storageArea: ui.context.localStorage }); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement old');
  ui.click('announcementPopupDismiss'); await tick();
  assert.deepEqual(new Set(storedSeen(ui)), new Set(['known', 'old', 'new']));
  await ui.api.load(); assert.equal(ui.elements.get('announcementPopup').open, false); assertPublicReadsOnly(ui);
});

test('View announcement acknowledges one entry and focuses its article when the page loads', async () => {
  const ui = harness({ user: user('reader'), entries: [entry('old'), entry('new', 1)] }); await tick();
  ui.click('announcementPopupRead'); await tick();
  assert.deepEqual(ui.navigations, ['/announcements']); assert.equal(ui.elements.get('announcementPopup').open, false);
  const article = ui.article('new'); ui.api.syncEntries(ui.server.entries); await tick();
  assert.equal(ui.document.activeElement, article); assert.equal(article.scrolled, true);
  assert.deepEqual(storedSeen(ui), ['new']); assertPublicReadsOnly(ui);
  ui.route('/games'); await tick(); assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement old');
});

test('new announcements are discovered while visible and deleted entries leave the queue', async () => {
  const ui = harness({ user: user('reader') }); await tick(); assert.equal(ui.elements.get('announcementPopup').open, false);
  ui.server.entries = [entry('news')]; await ui.advance(30000);
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement news');
  ui.server.entries = []; ui.api.syncEntries([]); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false); assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('a newly published announcement can be acknowledged locally before the author receives its snapshot', async () => {
  const own = entry('own'), ui = harness({ user: user('admin') }); await tick();
  ui.api.acknowledgeEntry(own.id);
  ui.server.entries = [own]; ui.api.syncEntries(ui.server.entries); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  assert.deepEqual(storedSeen(ui), ['own']);
  ui.setUser(user('reader')); await tick(); assert.equal(ui.elements.get('announcementPopup').open, false);
  assertPublicReadsOnly(ui);
});

test('an author on another device still sees their announcement until that browser acknowledges it', async () => {
  const own = entry('own'), reader = user('admin'), server = { entries: [own], seen: new Map([[reader.accountId, new Set(['own'])]]) };
  const ui = harness({ user: reader, server }); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement own');
  ui.api.syncEntries(server.entries); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, true); assertPublicReadsOnly(ui);
});

test('acknowledging a published entry removes only that entry from the visible queue', async () => {
  const ui = harness({ user: user('admin'), entries: [entry('old'), entry('own', 1)] }); await tick();
  ui.api.acknowledgeEntry('own'); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement old');
  assert.deepEqual(storedSeen(ui), ['own']);
  ui.api.acknowledgeEntry(null); ui.api.acknowledgeEntry(2); ui.api.acknowledgeEntry(''); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement old');
  assert.deepEqual(storedSeen(ui), ['own']); assertPublicReadsOnly(ui);
});

test('deleted and unknown authors are shown without invalid profile links', async () => {
  const deleted = { ...entry('deleted'), author: { accountId: null, username: 'Deleted player' } };
  const ui = harness({ entries: [deleted] }); await tick();
  assert.equal(ui.elements.get('announcementPopupAuthor').children[0].href, undefined);
  ui.server.entries = [{ ...entry('unknown', 1), author: null }]; await ui.api.load();
  assert.equal(ui.elements.get('announcementPopupAuthor').textContent, 'Unknown author');
});

test('a stale public read cannot restore an announcement removed by a fresher parent snapshot', async () => {
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

test('edited parent snapshots update the visible announcement without replaying acknowledged entries', async () => {
  const ui = harness({ user: user('reader'), entries: [entry('old'), entry('new', 1)] }); await tick();
  ui.click('announcementPopupDismiss'); await tick();
  ui.server.entries = [{ ...entry('old'), title: 'Edited old announcement' }, { ...entry('new', 1), title: 'Edited seen announcement' }];
  ui.api.syncEntries(ui.server.entries); await tick();
  assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Edited old announcement');
  ui.click('announcementPopupDismiss'); await tick();
  ui.api.syncEntries(ui.server.entries); await tick();
  assert.equal(ui.elements.get('announcementPopup').open, false);
  assert.deepEqual(storedSeen(ui), ['new', 'old']); assertPublicReadsOnly(ui);
});

test('tabs merge stored acknowledgments before writing even if storage events have not arrived yet', async () => {
  const storage = new Map(), entries = [entry('old'), entry('new', 1)];
  const first = harness({ storage, entries }), second = harness({ storage, entries }); await tick();
  first.api.acknowledgeEntry('old'); await tick();
  second.click('announcementPopupDismiss'); await tick();
  assert.deepEqual(new Set(storedSeen(second)), new Set(['old', 'new']));
  second.setUser(user('reader')); await tick();
  assert.equal(second.elements.get('announcementPopup').open, false); assertPublicReadsOnly(second);
});

test('equal acknowledgment sets in different insertion orders do not bounce storage writes between tabs', async () => {
  const storage = new Map([[deviceKey, JSON.stringify(['second', 'first'])]]), entries = [entry('first'), entry('second', 1), entry('fresh', 2)];
  const first = harness({ storage, entries }); await tick();
  assert.equal(storage.get(deviceKey), JSON.stringify(['first', 'second']));
  const second = harness({ storage, entries, user: user('reader') }); await tick();
  first.storageWrites.length = 0; second.storageWrites.length = 0;
  for (let round = 0; round < 4; round++) {
    for (const ui of [first, second]) {
      ui.windowEvent('storage', { key: deviceKey, newValue: storage.get(deviceKey), storageArea: ui.context.localStorage });
      await tick();
      assert.equal(ui.elements.get('announcementPopupTitle').textContent, 'Announcement fresh');
    }
  }
  assert.deepEqual(first.storageWrites, []); assert.deepEqual(second.storageWrites, []);
  assert.equal(storage.get(deviceKey), JSON.stringify(['first', 'second']));
  assertPublicReadsOnly(first); assertPublicReadsOnly(second);
});
