const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const person = (accountId, role = 'player') => ({ accountId, username: accountId, role, canManageAnnouncements: role !== 'player' });
const entry = (id = 'news', author = person('creator', 'mod')) => ({ id, author, authorAccountId: author.accountId, contributors: [author], title: 'Original title', description: 'Original details', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, commentCount: 4 });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function appFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function ${name}\\(`).exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}

function harness({ user = person('admin', 'admin'), entries = [entry()], network, enabled = true } = {}) {
  const elements = new Map(), calls = [], userChanges = [], commentMounts = [], popupSnapshots = [];
  let context, accountRevision = 0;
  const matches = (element, selector) => {
    const attribute = /\[data-([\w-]+)(?:="([^"]+)")?\]/.exec(selector);
    if (attribute) {
      const key = attribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (!(key in element.dataset) || attribute[2] && element.dataset[key] !== attribute[2]) return false;
    }
    const classMatch = /\.([\w-]+)/.exec(selector);
    if (classMatch && !element.className.split(/\s+/).includes(classMatch[1])) return false;
    const tag = /^[a-z]+/.exec(selector);
    return !tag || element.tagName === tag[0];
  };
  const node = (tagName = 'div', id = '') => {
    const listeners = new Map();
    const item = {
      tagName, id, children: [], dataset: {}, hidden: false, disabled: false, textContent: '', value: '', className: '', parentNode: null,
      classList: { add(name) { item.className = `${item.className} ${name}`.trim(); }, contains(name) { return item.className.split(/\s+/).includes(name); } },
      setAttribute(name, value) { this[name] = value; },
      append(...children) { for (const child of children.flatMap(value => value.tagName === 'fragment' ? value.children : [value])) { child.parentNode = this; this.children.push(child); } },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      addEventListener(type, callback) { listeners.set(type, callback); },
      dispatch(type, target = this) { return listeners.get(type)?.({ preventDefault() {}, target }); },
      closest(selector) { for (let element = this; element; element = element.parentNode) if (matches(element, selector)) return element; return null; },
      querySelectorAll(selector) {
        const parts = selector.split(' '), result = [];
        const visit = element => {
          for (const child of element.children) {
            if (matches(child, parts.at(-1))) {
              let ancestor = child.parentNode, index = parts.length - 2;
              while (ancestor && index >= 0) { if (matches(ancestor, parts[index])) index--; ancestor = ancestor.parentNode; }
              if (index < 0) result.push(child);
            }
            visit(child);
          }
        };
        visit(this); return result;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      focus() { document.activeElement = this; }, scrollIntoView() { this.scrolled = true; },
      reset() { elements.get('announcementTitle').value = ''; elements.get('announcementDescription').value = ''; }
    };
    return item;
  };
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], node('div', match[1]));
  const document = { activeElement: null, getElementById: id => elements.get(id), createElement: tag => node(tag), createDocumentFragment: () => node('fragment') };
  const state = { user, announcementEntries: entries, announcementSignature: null, announcementSubmitting: false, accountSubmitting: false };
  context = vm.createContext({
    document, console, state, userIdentityRevision: 0, routeRevision: 0, pageKind: 'announcements', accountBanned: false,
    announcementRevision: 0, announcementLoadPromise: null, announcementLoadFailed: false,
    $: id => elements.get(id), accountRole: value => value?.role || 'player', moderationViewEnabled: () => enabled,
    message: (target, text) => { target.textContent = text; },
    profileHref: name => `/profile/${name}`, profileAvatar: () => node(), playerRoleBadges: () => node(),
    setAccountSubmitting(value, expectedRevision = null) { if (expectedRevision !== null && expectedRevision !== accountRevision) return; state.accountSubmitting = value; return ++accountRevision; },
    setUser(value) { userChanges.push(value); context.userIdentityRevision++; state.user = value; context.renderAnnouncementEditor(); },
    window: {
      PepperNewsComments: { reconcile() {}, mount(article, kind, value) { commentMounts.push({ article, kind, entry: value }); } },
      PepperAnnouncementPopup: { syncEntries(values) { popupSnapshots.push(values); } }
    },
    api: async (route, options = {}) => {
      const call = { route, method: options.method || 'GET', body: options.body && JSON.parse(options.body) }; calls.push(call);
      const result = network && await network(call);
      return result ?? { entries: state.announcementEntries };
    }
  });
  const start = source.indexOf('const announcementEditing =');
  const end = source.indexOf('\nfunction renderOnlinePlayers()', start);
  vm.runInContext(appFunction('canEditAnnouncement') + '\nfunction canDeleteAnnouncement(entry) { return canEditAnnouncement(entry); }\n' + appFunction('newsEntryAuthor') + '\n' + source.slice(start, end) + '\nthis.editing = announcementEditing;', context);
  context.renderAnnouncements(entries);
  return {
    context, state, elements, calls, userChanges, popupSnapshots, commentMounts,
    edit: id => context.beginAnnouncementEdit(id),
    submit: () => context.submitAnnouncement({ preventDefault() {} }),
    cancel: () => elements.get('announcementCancel').dispatch('click'),
    setView(value) { enabled = value; context.renderAnnouncementEditor(); },
    setUser(value) { context.setUser(value); },
    render(values) { state.announcementEntries = values; context.renderAnnouncements(values); },
    draft(title, description) { elements.get('announcementTitle').value = title; elements.get('announcementDescription').value = description; }
  };
}

test('announcement editing and deletion follow the staff hierarchy', () => {
  const ui = harness();
  for (const actor of ['admin', 'senior_mod', 'mod', 'player']) {
    ui.state.user = person('viewer', actor);
    for (const author of ['admin', 'senior_mod', 'mod', 'player']) {
      const expected = actor === 'admin' || actor === 'senior_mod' && ['mod', 'player'].includes(author);
      assert.equal(ui.context.canEditAnnouncement(entry('news', person('author', author))), expected, `${actor} edits ${author}`);
      assert.equal(ui.context.canDeleteAnnouncement(entry('news', person('author', author))), expected, `${actor} deletes ${author}`);
    }
    assert.equal(ui.context.canEditAnnouncement(entry('own', person('viewer', actor))), actor !== 'player');
  }
});

test('Edit fills the existing form and Cancel restores the publication draft', () => {
  const ui = harness();
  ui.draft('Next announcement', 'Draft news'); ui.edit('news');
  assert.equal(ui.elements.get('announcementTitle').value, 'Original title');
  assert.equal(ui.elements.get('announcementDescription').value, 'Original details');
  assert.equal(ui.elements.get('announcementEditorTitle').textContent, 'Edit announcement');
  assert.equal(ui.elements.get('announcementSubmit').textContent, 'Save');
  assert.equal(ui.elements.get('announcementCancel').hidden, false);
  ui.cancel();
  assert.equal(ui.context.editing.id, null);
  assert.equal(ui.elements.get('announcementTitle').value, 'Next announcement');
  assert.equal(ui.elements.get('announcementDescription').value, 'Draft news');
  assert.equal(ui.elements.get('announcementCancel').hidden, true);
});

test('fresh announcement snapshots preserve edits and show each contributor once', () => {
  const original = entry(), editor = person('editor', 'admin');
  const ui = harness({ entries: [original] }); ui.edit('news'); ui.draft('Unfinished edit', 'Unfinished details');
  ui.render([{ ...original, contributors: [original.author, editor, editor], commentCount: 5 }]);
  assert.equal(ui.elements.get('announcementTitle').value, 'Unfinished edit');
  assert.equal(ui.elements.get('announcementDescription').value, 'Unfinished details');
  const authors = ui.elements.get('announcementEntries').querySelector('.news-entry-authors').children;
  assert.deepEqual(authors.map(author => author.children[1].textContent), ['creator', 'editor']);
  assert.deepEqual(authors.map(author => author.href), ['/profile/creator', '/profile/editor']);
  assert.equal(ui.commentMounts.at(-1).entry.commentCount, 5);
});

test('Save sends a PATCH and retains the original author, date, and comments', async () => {
  const original = entry(), editor = person('admin', 'admin');
  const changed = { ...original, title: 'Updated title', description: 'Updated details', updatedAt: '2026-10-09T00:00:00.000Z', contributors: [original.author, editor] };
  const ui = harness({ entries: [original], network: call => call.method === 'PATCH' ? { entries: [changed] } : { entries: [changed] } });
  ui.edit('news'); ui.draft(' Updated title ', ' Updated details '); await ui.submit(); await tick();
  assert.equal(ui.calls[0].route, 'announcements/news'); assert.equal(ui.calls[0].method, 'PATCH');
  assert.deepEqual(ui.calls[0].body, { title: 'Updated title', description: 'Updated details' });
  assert.equal(ui.state.announcementEntries[0].author.accountId, 'creator');
  assert.equal(ui.state.announcementEntries[0].createdAt, original.createdAt);
  assert.equal(ui.state.announcementEntries[0].commentCount, 4);
  assert.equal(ui.context.editing.id, null);
  assert.equal(ui.state.announcementSubmitting, false);
  assert.equal(ui.elements.get('announcementFormMessage').textContent, 'Announcement saved.');
});

test('failed saves retain the draft and can retry without returning to publication', async () => {
  let fail = true;
  const ui = harness({ network: call => { if (call.method === 'PATCH' && fail) throw Object.assign(new Error('Try again.'), { status: 500 }); } });
  ui.edit('news'); ui.draft('Changed', 'Still writing'); await ui.submit();
  assert.equal(ui.context.editing.id, 'news'); assert.equal(ui.elements.get('announcementTitle').value, 'Changed');
  assert.equal(ui.elements.get('announcementDescription').value, 'Still writing');
  assert.equal(ui.elements.get('announcementFormMessage').textContent, 'Try again.');
  assert.equal(ui.state.accountSubmitting, false);
  fail = false; await ui.submit();
  assert.deepEqual(ui.calls.filter(call => call.method !== 'GET').map(call => call.method), ['PATCH', 'PATCH']);
});

test('invalid edits and disabled staff views cannot submit or start an edit', async () => {
  const ui = harness(); ui.edit('news'); ui.draft('   ', 'Details'); await ui.submit();
  assert.equal(ui.calls.length, 0); assert.equal(ui.elements.get('announcementFormMessage').textContent, 'Title: 1–120 characters.');
  ui.draft('Valid', 'a'.repeat(5001)); await ui.submit(); assert.equal(ui.calls.length, 0);
  ui.cancel(); ui.setView(false); ui.edit('news'); assert.equal(ui.context.editing.id, null);
  ui.draft('Valid', 'Details'); await ui.submit(); assert.equal(ui.calls.length, 0);
});

test('stale save responses cannot alter a new account, role, view, or route draft', async () => {
  for (const change of ['identity', 'role', 'role restored', 'view', 'route']) {
    const waiting = deferred(); const ui = harness({ network: call => call.method === 'PATCH' ? waiting.promise : undefined });
    ui.edit('news'); ui.draft('First draft', 'First details'); const saving = ui.submit();
    if (change === 'identity') ui.setUser(person('next', 'admin'));
    if (change === 'role') ui.setUser(person('admin', 'senior_mod'));
    if (change === 'role restored') { ui.setUser(person('admin', 'senior_mod')); ui.setUser(person('admin', 'admin')); }
    if (change === 'view') { ui.setView(false); ui.setView(true); }
    if (change === 'route') ui.context.routeRevision++;
    ui.draft('Current draft', 'Current details');
    waiting.resolve({ entries: [{ ...entry(), title: 'Late saved title' }] }); await saving;
    assert.equal(ui.state.announcementEntries[0].title, 'Original title', change);
    assert.equal(ui.elements.get('announcementTitle').value, 'Current draft', change);
    assert.equal(ui.elements.get('announcementDescription').value, 'Current details', change);
    assert.equal(ui.state.announcementSubmitting, false, change);
  }
});

test('a stale permission rejection cannot sign out a replacement account', async () => {
  const waiting = deferred(); const ui = harness({ network: call => call.method === 'PATCH' ? waiting.promise : undefined });
  ui.edit('news'); ui.draft('Changed', 'Details'); const saving = ui.submit();
  const replacement = person('replacement', 'admin'); ui.setUser(replacement);
  waiting.reject(Object.assign(new Error('Sign in required.'), { status: 401 })); await saving;
  assert.equal(ui.state.user, replacement); assert.deepEqual(ui.userChanges, [replacement]);
});

test('permission rejections refresh staff roles without treating an entry denial as a demotion', async () => {
  for (const role of ['admin', 'player']) {
    const current = person('admin', role);
    const ui = harness({ network: call => {
      if (call.method === 'PATCH') throw Object.assign(new Error('Action unavailable.'), { status: 403 });
      if (call.route === 'me') return { user: current };
    } });
    ui.edit('news'); ui.draft('Changed', 'Details'); await ui.submit(); await tick();
    assert.equal(ui.state.user.role, role);
    assert.equal(ui.elements.get('announcementEditor').hidden, role === 'player');
    assert.equal(ui.context.editing.id, role === 'admin' ? 'news' : null);
    assert.equal(ui.calls.some(call => call.route === 'me'), true);
  }
});

test('a public read started before a save cannot restore the old announcement', async () => {
  const waiting = deferred(), original = entry();
  const saved = { ...original, title: 'Saved title' }; let reads = 0;
  const ui = harness({ network: call => call.method === 'GET' && ++reads === 1 ? waiting.promise : { entries: [saved] } });
  const loading = ui.context.loadAnnouncements(); ui.edit('news'); ui.draft('Saved title', 'Details'); await ui.submit();
  waiting.resolve({ entries: [original] }); await loading; await tick();
  assert.equal(ui.state.announcementEntries[0].title, 'Saved title');
  assert.equal(ui.context.announcementRevision, 1);
  assert.equal(ui.calls[0].method, 'GET'); assert.equal(ui.calls[1].method, 'PATCH');
});

test('deleted entries end editing while preserving an unfinished publication', () => {
  const ui = harness(); ui.draft('Next title', 'Next details'); ui.edit('news'); ui.draft('Lost edit', 'Lost details');
  ui.render([]);
  assert.equal(ui.context.editing.id, null); assert.equal(ui.elements.get('announcementTitle').value, 'Next title');
  assert.equal(ui.elements.get('announcementDescription').value, 'Next details');
  assert.equal(ui.elements.get('announcementFormMessage').textContent, 'Announcement unavailable.');
});
