const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/moderation.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function appFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function ${name}\\(`).exec(appSource);
  assert.ok(match, `Production function ${name} exists`);
  return appSource.slice(match.index, appSource.indexOf('\n}', match.index) + 2);
}
const person = (accountId, role = 'player', banned = false) => ({ accountId, username: accountId, role, banned });
function harness(user, { storage = new Map(), network } = {}) {
  const elements = new Map(), calls = [];
  let context;
  const node = id => {
    const classes = new Set(), listeners = new Map();
    return {
      id, children: [], dataset: {}, hidden: false, disabled: false, textContent: '', value: '',
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      addEventListener(type, callback) { listeners.set(type, callback); },
      dispatch(type) { return listeners.get(type)?.({ preventDefault() {}, target: this }); },
      setAttribute(name, value) { this[name] = value; }, append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      querySelectorAll() { return []; }, closest() { return null; }, reset() {}, focus() {}, click() { this.dispatch('click'); }
    };
  };
  for (const id of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id[1], node(id[1]));
  const document = { getElementById: id => elements.get(id), createElement: () => node(), activeElement: null, body: node('body'), querySelectorAll: () => [] };
  context = vm.createContext({
    document, window: { addEventListener() {} }, accountBanned: false,
    state: { user, accountSubmitting: false, chatMessages: [], profile: null, leaderboard: null }, trading: { chatMessages: [] },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    accountRole: value => value?.role || 'player', profileHref: name => `/profile/${name}`, profileAvatar: () => node(), playerRoleBadges: () => node(),
    renderChangelogEditor() {}, renderAnnouncementEditor() {}, setChatOpen() {}, renderChat() {}, renderProfileDetails() {}, renderLeaderboard() {}, renderTradeChat() {}, loadPresence() {}, loadLeaderboard() {}, loadChat() {}, clearChatReply() {}, navigateTo() {},
    message: (target, text) => { target.textContent = text; },
    api: async (route, options = {}) => { const call = { route, method: options.method || 'GET', payload: options.body ? JSON.parse(options.body) : undefined }; calls.push(call); return network ? network(call) : {}; },
    setUser: value => { context.state.user = value; context.window.PepperModeration.syncUser(); }
  });
  vm.runInContext(source.replace('window.PepperModeration = { enabled, syncUser, showBanned, chatDeleteButton };', 'window.PepperModeration = { enabled, syncUser, showBanned, chatDeleteButton, canBan, canDeleteChat, changePlayer, deleteChat, findPlayers, inspect: () => moderation };'), context);
  return { api: context.window.PepperModeration, context, elements, calls, storage, enable: () => elements.get('moderationViewToggle').click() };
}

test('management view is opt-in and remembered separately for each privileged account', () => {
  const storage = new Map(), admin = person('admin', 'admin');
  const first = harness(admin, { storage });
  assert.equal(first.api.enabled(), false);
  assert.equal(first.elements.get('moderationViewToggle').textContent, 'Open admin view');
  first.enable(); assert.equal(first.api.enabled(), true);
  assert.equal(first.elements.get('moderationViewToggle').textContent, 'Close admin view');
  assert.equal(harness(admin, { storage }).api.enabled(), true);
  assert.equal(harness(person('mod', 'mod'), { storage }).api.enabled(), false);
  first.context.setUser(person('ordinary')); assert.equal(first.api.enabled(), false);
  assert.equal(first.elements.get('moderationSettings').hidden, true);
});

test('moderator gates exclude other moderators and admins while allowing their own chat messages', () => {
  const mod = person('mod', 'mod'), ui = harness(mod); ui.enable();
  assert.equal(ui.api.canBan(person('ordinary')), true);
  assert.equal(ui.api.canBan(person('other_mod', 'mod')), false);
  assert.equal(ui.api.canBan(person('admin', 'admin')), false);
  assert.equal(ui.api.canBan(mod), false);
  assert.equal(ui.api.canDeleteChat({ ...person('ordinary'), id: 'message' }), true);
  assert.equal(ui.api.canDeleteChat({ ...person('other_mod', 'mod'), id: 'message' }), false);
  assert.equal(ui.api.canDeleteChat({ ...person('admin', 'admin'), id: 'message' }), false);
  assert.equal(ui.api.canDeleteChat({ ...mod, id: 'own_message' }), true);
  assert.equal(ui.api.canDeleteChat({ ...mod, id: 'own_message', deleted: true }), false);
  ui.enable(); assert.equal(ui.api.canDeleteChat({ ...mod, id: 'own_message' }), false);
});

test('role changes and bans use permanent IDs and prevent unauthorized client actions', async () => {
  const target = person('target');
  const admin = harness(person('admin', 'admin'), { network: call => ({ player: { ...target, ...call.payload } }) }); admin.enable();
  await admin.api.changePlayer(target, 'make-mod');
  assert.deepEqual(admin.calls[0], { route: 'moderation/players/target', method: 'PATCH', payload: { role: 'mod' } });
  const mod = harness(person('mod', 'mod')); mod.enable();
  await mod.api.changePlayer(person('other_mod', 'mod'), 'ban');
  await mod.api.changePlayer(target, 'make-mod');
  assert.equal(mod.calls.length, 0);
});

test('a moderation response after switching accounts cannot populate the new account', async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const ui = harness(person('admin', 'admin'), { network: () => pending }); ui.enable();
  const finding = ui.api.findPlayers({ preventDefault() {} });
  ui.context.setUser(person('ordinary'));
  resolve({ players: [person('private_target')] }); await finding;
  assert.equal(ui.api.inspect().players.length, 0);
  assert.equal(ui.elements.get('moderationSettings').hidden, true);
});

test('chat deletion confirms inline and preserves the saved message receipt', async () => {
  const ui = harness(person('admin', 'admin')); ui.enable();
  const item = { ...person('writer'), id: 'saved_message', text: 'Saved once', clientMessageId: 'receipt' };
  ui.context.state.chatMessages = [item];
  await ui.api.deleteChat(item); assert.equal(ui.calls.length, 0);
  assert.equal(ui.api.chatDeleteButton(item).textContent, 'Confirm delete');
  await ui.api.deleteChat(item);
  assert.equal(ui.calls[0].route, 'chat/saved_message'); assert.equal(ui.calls[0].method, 'DELETE');
  assert.equal(ui.context.state.chatMessages[0].deleted, true);
  assert.equal(ui.context.state.chatMessages[0].text, 'Message deleted.');
  assert.equal(ui.context.state.chatMessages[0].clientMessageId, 'receipt');
});

test('banned accounts show the banned screen and cannot enable management controls', () => {
  const ui = harness(person('mod', 'mod')); ui.enable();
  ui.context.accountBanned = true; ui.context.setUser(null);
  assert.equal(ui.context.document.body.classList.contains('banned-mode'), true);
  assert.equal(ui.elements.get('bannedScreen').hidden, false);
  assert.equal(ui.api.enabled(), false);
  assert.equal(ui.elements.get('moderationSettings').hidden, true);
});

test('publishing permission errors preserve banned-screen focus after sign-out', () => {
  const focus = [];
  const context = vm.createContext({
    state: { user: null }, accountBanned: true,
    $: () => ({ focus: () => focus.push('button') }),
    message() {}, renderChangelogEditor() {}, renderAnnouncementEditor() {},
    focusChangelogMessage: () => focus.push('changelog'), focusAnnouncementMessage: () => focus.push('announcements'),
    setUser() {}, changelogLoadFailed: false, announcementLoadFailed: false
  });
  vm.runInContext(appFunction('changelogPermissionError') + '\n' + appFunction('announcementPermissionError'), context);
  assert.equal(context.changelogPermissionError({ status: 403, banned: true }), true);
  assert.equal(context.announcementPermissionError({ status: 403, banned: true }), true);
  assert.deepEqual(focus, []);
  context.accountBanned = false;
  context.state.user = { accountId: 'new_admin', canManageChangelog: true, canManageAnnouncements: true };
  assert.equal(context.changelogPermissionError({ status: 403, banned: true }), true);
  assert.equal(context.announcementPermissionError({ status: 403, banned: true }), true);
  assert.equal(context.state.user.canManageChangelog, true);
  assert.equal(context.state.user.canManageAnnouncements, true);
  assert.deepEqual(focus, []);
  context.state.user = null;
  assert.doesNotThrow(() => context.changelogPermissionError({ status: 403, message: 'Access denied.' }));
});

test('late banned API responses cannot replace a newer account with the banned screen', async () => {
  for (const switchedAccount of [false, true]) {
    let resolve; const response = new Promise(done => { resolve = done; });
    let bannedScreens = 0;
    const context = vm.createContext({ userIdentityRevision: 1, fetch: () => response, handleBannedAccount: () => { bannedScreens++; } });
    vm.runInContext(appFunction('api'), context);
    const rejected = assert.rejects(context.api('chat', { method: 'POST' }), error => error.status === 403 && error.banned);
    if (switchedAccount) context.userIdentityRevision++;
    resolve({ ok: false, status: 403, json: async () => ({ error: 'You are banned.', banned: true }) });
    await rejected;
    assert.equal(bannedScreens, switchedAccount ? 0 : 1);
  }
});
