const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../public/news-comments.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const player = (username, role = 'player') => ({ accountId: `PPR-${username}`, username, role, banned: false });
const comment = (author, text, extra = {}) => ({ id: crypto.randomBytes(12).toString('hex'), clientMessageId: crypto.randomUUID(), author, text, deleted: false, createdAt: new Date().toISOString(), ...extra });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Exercise the whole production module, including real DOM reparenting and async guards.
function harness(user, { network, managementOpen = false, initialEntries } = {}) {
  const calls = [], timers = new Map(), parentRefreshes = [], management = { open: managementOpen };
  const elements = new Map(), clock = { now: Date.now() };
  let context, timerId = 0;
  const node = (tag = 'div') => {
    const listeners = new Map();
    return {
      tagName: tag.toUpperCase(), className: '', id: '', dataset: {}, children: [], parentElement: null,
      textContent: '', value: '', open: false, hidden: false, disabled: false,
      get isConnected() { return this === document.body || !!this.parentElement?.isConnected; },
      append(...children) {
        for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); }
      },
      replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); },
      remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } },
      contains(target) { return this === target || this.children.some(child => child.contains(target)); },
      querySelectorAll(selector) {
        const matches = child => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : selector === '[data-comment-action]' && !!child.dataset.commentAction;
        return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
      },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, callback) { listeners.set(name, callback); },
      dispatch(name) { return listeners.get(name)?.({ preventDefault() {}, target: this }); },
      focus() { document.activeElement = this; }, click() { this.dispatch('click'); }
    };
  };
  const document = { body: null, activeElement: null, createElement: node, getElementById: id => elements.get(id) };
  document.body = node('body');
  for (const id of ['announcementEntries', 'changelogEntries', 'accountButton']) { const item = node(); item.id = id; elements.set(id, item); document.body.append(item); }
  const createArticle = (kind, entry, connected = true) => {
    const article = node('article'); article.className = 'changelog-entry'; article.dataset.entryId = entry.id;
    if (connected) elements.get(kind === 'announcements' ? 'announcementEntries' : 'changelogEntries').append(article); return article;
  };
  const state = { user, accountSubmitting: false, announcementEntries: initialEntries || null, changelogEntries: null };
  for (const entry of initialEntries || []) createArticle('announcements', entry);
  const boundary = {
    document, state, crypto, console, routeRevision: 0, userIdentityRevision: 0, pageKind: 'announcements', accountBanned: false,
    announcementRevision: 0, changelogRevision: 0,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } },
    window: {
      PepperModeration: { enabled: () => management.open },
      setTimeout(callback, delay = 0) { const id = ++timerId; timers.set(id, { callback, at: clock.now + delay, delay }); return id; },
      clearTimeout: id => timers.delete(id)
    },
    accountRole: person => person?.role || 'player', profileHref: username => `/profile/${username}`,
    profileAvatar: author => { const item = node('img'); item.dataset.accountId = author?.accountId; return item; },
    playerRoleBadges: author => node(), message: (target, text) => { target.textContent = text; },
    loadAnnouncements: refresh => { parentRefreshes.push({ kind: 'announcements', refresh }); },
    loadChangelog: refresh => { parentRefreshes.push({ kind: 'changelog', refresh }); },
    setUser(value) {
      if (context.state.user?.accountId !== value?.accountId) context.userIdentityRevision++;
      context.state.user = value; context.window.PepperNewsComments.syncUser();
    },
    api: async (route, options = {}) => {
      const call = { route, method: options.method || 'GET', payload: options.body ? JSON.parse(options.body) : null }; calls.push(call);
      const result = network ? await network(call) : undefined;
      if (result !== undefined) return result;
      if (call.method === 'GET') return { comments: [], nextCursor: null };
      throw new Error(`Unexpected ${call.method} ${route}`);
    }
  };
  context = vm.createContext(boundary);
  vm.runInContext(source.replace('window.PepperNewsComments = { mount, reconcile, syncUser, onRoute };', 'window.PepperNewsComments = { mount, reconcile, syncUser, onRoute, inspect: () => threads, canDelete, load, submitComment, sendNext, deleteComment };'), context);
  return {
    api: context.window.PepperNewsComments, context, calls, timers, parentRefreshes, management, document, elements, createArticle, setUser: boundary.setUser,
    mount(kind = 'announcements', entry = { id: 'entry-id', commentCount: 0 }, connected = true) {
      const article = createArticle(kind, entry, connected); context.window.PepperNewsComments.mount(article, kind, entry);
      return { article, thread: context.window.PepperNewsComments.inspect().get(`${kind}/${entry.id}`) };
    },
    navigate(kind) { context.pageKind = kind; context.routeRevision++; context.window.PepperNewsComments.onRoute(); },
    async runNextTimer() {
      const item = [...timers].sort((left, right) => left[1].at - right[1].at)[0]; assert.ok(item, 'A retry is scheduled');
      timers.delete(item[0]); clock.now = Math.max(clock.now, item[1].at); item[1].callback(); await tick(); return item[1].delay;
    }
  };
}
function open(thread, value = true) { thread.details.open = value; thread.details.dispatch('toggle'); }
function send(thread, text) { thread.input.value = text; thread.form.dispatch('submit'); }
const allText = item => [item.textContent, ...item.children.map(allText)].filter(Boolean).join(' ');
const buttons = thread => thread.list.querySelectorAll('[data-comment-action]');
const posts = ui => ui.calls.filter(call => call.method === 'POST');

test('comments stay collapsed and load publicly only after expansion', async () => {
  const item = comment(player('author'), '<script>alert(1)</script>');
  const ui = harness(null, { network: () => ({ comments: [item], nextCursor: null }) });
  const { thread } = ui.mount('announcements', { id: 'release', commentCount: 7 }); await tick();
  assert.equal(ui.calls.length, 0); assert.equal(thread.details.open, false); assert.equal(thread.body.hidden, true);
  assert.equal(thread.summary.textContent, 'Comments (7)');
  open(thread); await tick();
  assert.equal(ui.calls[0].route, 'announcements/release/comments');
  assert.equal(thread.body.hidden, false); assert.equal(thread.form.hidden, true); assert.equal(thread.signIn.hidden, false);
  assert.match(allText(thread.list), /<script>alert\(1\)<\/script>/);
  assert.equal(thread.list.querySelectorAll('.news-comment-author')[0].href, '/profile/author');
  assert.equal(posts(ui).length, 0);
});

test('Load more follows opaque cursors and merges all comments without duplicates', async () => {
  const author = player('writer'), entries = Array.from({ length: 75 }, (_, index) => comment(author, `Comment ${index}`, { id: `id-${String(index).padStart(3, '0')}`, createdAt: new Date(1700000000000 + index).toISOString() }));
  const cursor = 'opaque/page 2?&';
  const ui = harness(player('local'), { network: call => call.route.includes('?cursor=') ? { comments: [entries[49], ...entries.slice(50)], nextCursor: null } : { comments: entries.slice(0, 50), nextCursor: cursor } });
  const { thread } = ui.mount('announcements', { id: 'release', commentCount: 75 });
  open(thread); await tick();
  assert.equal(thread.comments.length, 50); assert.equal(thread.more.hidden, false);
  thread.more.click(); await tick();
  assert.equal(ui.calls.at(-1).route, `announcements/release/comments?cursor=${encodeURIComponent(cursor)}`);
  assert.equal(thread.comments.length, 75); assert.equal(thread.more.hidden, true);
  assert.deepEqual(Array.from(thread.comments, entry => entry.text), entries.map(entry => entry.text));
  assert.equal(thread.summary.textContent, 'Comments (75)');
});

test('Refresh revisits loaded pages and preserves tombstones', async () => {
  const first = comment(player('writer'), 'First', { id: 'first' }), second = comment(player('writer'), 'Second', { id: 'second' }); let deleted = false;
  const ui = harness(null, { network: call => call.route.includes('?cursor=') ? { comments: [second], nextCursor: null } : { comments: [{ ...first, ...(deleted ? { deleted: true, text: 'Comment deleted.' } : {}) }], nextCursor: 'next' } });
  const { thread } = ui.mount(); open(thread); await tick(); thread.more.click(); await tick();
  deleted = true; thread.refresh.click(); await tick();
  assert.equal(ui.calls.length, 4); assert.equal(thread.comments.length, 2);
  assert.equal(thread.comments.find(item => item.id === first.id).deleted, true);
  assert.match(allText(thread.list), /Comment deleted\./); assert.match(allText(thread.list), /Second/);
  deleted = false; thread.refresh.click(); await tick();
  assert.equal(thread.comments.find(item => item.id === first.id).deleted, true, 'A stale snapshot cannot restore deleted text');
});

test('open comment sections retain their DOM, loaded comments, and draft across parent rerenders', async () => {
  const item = comment(player('writer'), 'Saved comment');
  const ui = harness(player('local'), { network: () => ({ comments: [item], nextCursor: null }) });
  const entry = { id: 'release', commentCount: 1 }, { thread, article } = ui.mount('announcements', entry);
  open(thread); await tick(); thread.input.value = 'Draft comment'; thread.input.focus();
  const replacement = ui.createArticle('announcements', { ...entry }, false);
  ui.api.mount(replacement, 'announcements', { ...entry });
  assert.equal(thread.input.disabled, true, 'Detached form is temporarily unavailable');
  article.remove(); ui.elements.get('announcementEntries').append(replacement); await tick();
  assert.equal(replacement.children[0], thread.details); assert.equal(thread.details.open, true);
  assert.equal(thread.input.value, 'Draft comment'); assert.equal(thread.input.disabled, false); assert.equal(thread.refresh.disabled, false);
  assert.match(allText(thread.list), /Saved comment/); assert.equal(ui.calls.length, 1);
  assert.equal(ui.document.activeElement, thread.input);
});

test('same-account role and management-view changes update deletion controls without clearing drafts', async () => {
  const local = player('admin', 'admin'), own = comment(local, 'Own'), other = comment(player('other'), 'Other');
  const ui = harness(local, { network: () => ({ comments: [own, other], nextCursor: null }) });
  const { thread } = ui.mount(); open(thread); await tick(); thread.input.value = 'Keep draft';
  assert.equal(buttons(thread).filter(control => control.dataset.commentAction === 'delete').length, 1);
  ui.management.open = true; ui.api.syncUser();
  assert.equal(buttons(thread).filter(control => control.dataset.commentAction === 'delete').length, 2);
  assert.equal(thread.input.value, 'Keep draft');
  ui.setUser(player('admin', 'player'));
  assert.equal(buttons(thread).filter(control => control.dataset.commentAction === 'delete').length, 1);
  assert.equal(thread.input.value, 'Keep draft');
});

test('comment deletion follows ownership, staff view, and role hierarchy', async () => {
  for (const role of ['player', 'mod', 'admin']) for (const managementOpen of [false, true]) {
    const local = player('local', role), own = comment(local, 'Own'), ordinary = comment(player('ordinary'), 'Ordinary'), mod = comment(player('other-mod', 'mod'), 'Mod'), admin = comment(player('other-admin', 'admin'), 'Admin');
    const ui = harness(local, { managementOpen, network: () => ({ comments: [own, ordinary, mod, admin], nextCursor: null }) });
    const { thread } = ui.mount(); open(thread); await tick();
    assert.equal(ui.api.canDelete(thread, own), true);
    assert.equal(ui.api.canDelete(thread, ordinary), managementOpen && role !== 'player');
    assert.equal(ui.api.canDelete(thread, mod), managementOpen && role === 'admin');
    assert.equal(ui.api.canDelete(thread, admin), managementOpen && role === 'admin');
    assert.equal(ui.api.canDelete(thread, { ...own, deleted: true }), false);
    ui.setUser(null);
    assert.equal(ui.api.canDelete(thread, own), false);
  }
});

test('deleting a comment confirms once, disables duplicate submits, and retains a tombstone', async () => {
  const local = player('local'), item = comment(local, 'Remove me'), pending = deferred();
  const ui = harness(local, { network: call => call.method === 'DELETE' ? pending.promise : { comments: [item], nextCursor: null } });
  const { thread } = ui.mount('announcements', { id: 'release', commentCount: 1 }); open(thread); await tick();
  const stale = buttons(thread)[0]; stale.click();
  assert.equal(ui.calls.filter(call => call.method === 'DELETE').length, 0);
  const confirm = buttons(thread).find(control => control.textContent === 'Confirm delete'); assert.ok(confirm);
  confirm.click(); confirm.click();
  assert.equal(ui.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(ui.calls.at(-1).route, `announcements/release/comments/${item.id}`);
  assert.equal(buttons(thread)[0].disabled, true);
  pending.resolve({ comment: { ...item, deleted: true, text: 'Comment deleted.' } }); await tick();
  assert.equal(thread.comments[0].deleted, true); assert.match(allText(thread.list), /Comment deleted\./);
  assert.equal(thread.summary.textContent, 'Comments (0)'); assert.equal(ui.context.announcementRevision, 1);
  assert.deepEqual(ui.parentRefreshes, [{ kind: 'announcements', refresh: true }]);
  stale.click(); stale.click(); await tick();
  assert.equal(ui.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('deleted-parent reconciliation discards requests, drafts, and retry state', async () => {
  const pending = deferred();
  const ui = harness(player('local'), { network: () => pending.promise });
  const { thread } = ui.mount('announcements', { id: 'release', commentCount: 2 }); open(thread); thread.input.value = 'Private draft';
  ui.api.reconcile('announcements', []);
  assert.equal(thread.disposed, true); assert.equal(thread.details.isConnected, false); assert.equal(thread.input.value, '');
  pending.resolve({ comments: [comment(player('writer'), 'Late comment')], nextCursor: null }); await tick();
  assert.equal(ui.api.inspect().size, 0); assert.equal(thread.comments.length, 0);
  const replacement = ui.mount('announcements', { id: 'release', commentCount: 0 });
  assert.notEqual(replacement.thread, thread); assert.equal(replacement.thread.details.open, false);
});

test('late public reads cannot replace newer route or account state', async () => {
  for (const change of ['route', 'account']) {
    const pending = deferred(); let reads = 0;
    const ui = harness(player('local'), { network: () => ++reads === 1 ? pending.promise : { comments: [], nextCursor: null } });
    const { thread } = ui.mount(); open(thread); thread.input.value = 'Old draft';
    if (change === 'route') ui.navigate('games'); else ui.setUser(player('new-account'));
    pending.resolve({ comments: [comment(player('old'), 'Late old comment')], nextCursor: null }); await tick();
    assert.equal(thread.comments.length, 0, change);
    if (change === 'account') assert.equal(thread.input.value, '');
  }
});

test('posting sends only trimmed text and a UUID receipt and refreshes the parent count', async () => {
  for (const kind of ['announcements', 'changelog']) {
    const local = player('local');
    const ui = harness(local, { network: call => call.method === 'POST' ? { comment: comment(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }) } : undefined });
    ui.navigate(kind); const { thread } = ui.mount(kind); open(thread); await tick();
    send(thread, '  A comment <b>safe</b>  '); await tick();
    assert.equal(posts(ui).length, 1); assert.equal(posts(ui)[0].route, `${kind}/entry-id/comments`);
    assert.deepEqual(Object.keys(posts(ui)[0].payload).sort(), ['clientMessageId', 'text']);
    assert.match(posts(ui)[0].payload.clientMessageId, /^[0-9a-f-]{36}$/);
    assert.equal(posts(ui)[0].payload.text, 'A comment <b>safe</b>');
    assert.equal(thread.outbox.length, 0); assert.equal(thread.input.value, '');
    assert.match(allText(thread.list), /A comment <b>safe<\/b>/);
    assert.equal(thread.summary.textContent, 'Comments (1)');
    assert.deepEqual(ui.parentRefreshes, [{ kind, refresh: true }]);
  }
});

test('invalid comments and signed-out or banned users cannot submit', async () => {
  const ui = harness(player('local')), { thread } = ui.mount(); open(thread); await tick();
  for (const text of ['', '   ', 'x'.repeat(1001)]) { send(thread, text); await tick(); }
  assert.equal(posts(ui).length, 0);
  ui.setUser(null); send(thread, 'Guest comment'); await tick();
  assert.equal(posts(ui).length, 0); assert.equal(thread.form.hidden, true);
  ui.context.accountBanned = true; ui.setUser({ ...player('local'), banned: true }); send(thread, 'Banned comment'); await tick();
  assert.equal(posts(ui).length, 0); assert.equal(thread.send.disabled, true);
});

test('pending comments serialize sends and preserve submission order', async () => {
  const local = player('local'), first = deferred(); let attempts = 0;
  const ui = harness(local, { network: call => {
    if (call.method === 'POST') return ++attempts === 1 ? first.promise : { comment: comment(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }) };
  } });
  const { thread } = ui.mount(); open(thread); await tick(); send(thread, 'First'); send(thread, 'Second'); await tick();
  assert.equal(posts(ui).length, 1); assert.equal(thread.outbox.length, 2);
  first.resolve({ comment: comment(local, 'First', { clientMessageId: posts(ui)[0].payload.clientMessageId }) }); await tick();
  await ui.runNextTimer();
  assert.equal(posts(ui).length, 2); assert.deepEqual(posts(ui).map(call => call.payload.text), ['First', 'Second']);
  assert.equal(thread.outbox.length, 0); assert.equal(thread.comments.length, 2);
});

test('rate-limited comments remain loading and retry automatically with the same UUID', async () => {
  const local = player('local'); let attempts = 0;
  const ui = harness(local, { network: call => {
    if (call.method === 'POST') {
      if (++attempts === 1) throw Object.assign(new Error('Too fast.'), { status: 429, retryAfterMs: 200 });
      return { comment: comment(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }) };
    }
  } });
  const { thread } = ui.mount(); open(thread); await tick(); send(thread, 'Queued comment'); await tick();
  assert.equal(thread.outbox[0].status, 'pending'); assert.match(allText(thread.list), /Sending…/);
  assert.equal(buttons(thread).filter(control => control.dataset.commentAction === 'retry').length, 0);
  await ui.runNextTimer(); assert.equal(posts(ui).length, 1);
  assert.ok(await ui.runNextTimer() >= 300);
  assert.equal(posts(ui).length, 2); assert.deepEqual(posts(ui)[0].payload, posts(ui)[1].payload);
  assert.equal(thread.outbox.length, 0); assert.equal(thread.summary.textContent, 'Comments (1)');
});

test('failed comments retain their text and retry safely with the same receipt', async () => {
  const local = player('local'); let fail = true;
  const ui = harness(local, { network: call => {
    if (call.method === 'POST') { if (fail) throw new Error('Connection lost.'); return { comment: comment(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }) }; }
  } });
  const { thread } = ui.mount(); open(thread); await tick(); send(thread, 'Keep this comment'); await tick();
  assert.equal(thread.outbox[0].status, 'failed'); assert.match(allText(thread.list), /Keep this comment/);
  const retry = buttons(thread).find(control => control.dataset.commentAction === 'retry'); assert.ok(retry);
  fail = false; retry.click(); await tick();
  assert.equal(posts(ui).length, 2); assert.deepEqual(posts(ui)[0].payload, posts(ui)[1].payload);
  assert.equal(thread.outbox.length, 0);
});

test('account changes cancel queued comment retries and clear old drafts', async () => {
  const ui = harness(player('local'), { network: call => { if (call.method === 'POST') throw Object.assign(new Error('Too fast.'), { status: 429, retryAfterMs: 200 }); } });
  const { thread } = ui.mount(); open(thread); await tick(); send(thread, 'Old account'); await tick(); await ui.runNextTimer();
  const oldTimer = [...ui.timers.values()][0]; assert.ok(oldTimer); thread.input.value = 'Old private draft';
  ui.setUser(player('new-account')); await tick();
  assert.equal(ui.timers.size, 0); assert.equal(thread.outbox.length, 0); assert.equal(thread.input.value, '');
  oldTimer.callback(); await tick(); assert.equal(posts(ui).length, 1);
});

test('stale posts after navigation require a safe retry and cannot update a new route', async () => {
  const local = player('local'), pending = deferred();
  const ui = harness(local, { network: call => call.method === 'POST' ? pending.promise : undefined });
  const { thread } = ui.mount(); open(thread); await tick(); send(thread, 'In flight');
  ui.navigate('games'); pending.resolve({ comment: comment(local, 'In flight', { clientMessageId: posts(ui)[0].payload.clientMessageId }) }); await tick();
  assert.equal(thread.comments.length, 0); assert.equal(thread.outbox[0].status, 'failed');
  assert.equal(ui.parentRefreshes.length, 0); assert.equal(thread.summary.textContent, 'Comments (0)');
  ui.navigate('announcements'); await tick();
  assert.equal(posts(ui).length, 1, 'Returning does not resend an uncertain result automatically');
  assert.ok(buttons(thread).some(control => control.dataset.commentAction === 'retry'));
});

test('a post invalidates an older comments read and saved receipts do not duplicate rows', async () => {
  const local = player('local'), oldRead = deferred(); let reads = 0, saved;
  const ui = harness(local, { network: call => {
    if (call.method === 'GET' && ++reads === 2) return oldRead.promise;
    if (call.method === 'POST') { saved = comment(local, call.payload.text, { clientMessageId: call.payload.clientMessageId }); return { comment: saved }; }
  } });
  const { thread } = ui.mount(); open(thread); await tick(); const stale = ui.api.load(thread);
  send(thread, 'Saved once'); await tick(); oldRead.resolve({ comments: [], nextCursor: null }); await stale;
  assert.equal(thread.comments.length, 1); assert.match(allText(thread.list), /Saved once/);
  await ui.api.load(thread);
  assert.equal(thread.comments.length, 1, 'Refresh preserves a newly appended saved comment');
});

test('existing rendered news articles mount once when the module loads after their snapshot', async () => {
  const entries = [{ id: 'existing', commentCount: 3 }];
  const ui = harness(null, { initialEntries: entries }); await tick();
  const article = ui.elements.get('announcementEntries').children[0];
  assert.equal(article.children.length, 1); assert.equal(article.children[0].tagName, 'DETAILS');
  assert.equal(article.children[0].children[0].textContent, 'Comments (3)');
  ui.api.syncUser(); ui.api.onRoute(); await tick();
  assert.equal(article.children.length, 1); assert.equal(ui.calls.length, 0);
});
