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
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(user, { storage = new Map(), network, versionNetwork, withPicker = false } = {}) {
  const elements = new Map(), calls = [], versionCalls = [], changelogRefreshes = [], windowListeners = new Map();
  const picker = { config: null, resets: 0, closes: 0, refreshes: 0 };
  let context;
  const node = id => {
    const classes = new Set(), listeners = new Map();
    return {
      id, children: [], dataset: {}, hidden: false, disabled: false, open: false, textContent: '', value: '',
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      addEventListener(type, callback) { listeners.set(type, callback); },
      dispatch(type, target = this) { return listeners.get(type)?.({ preventDefault() {}, target }); },
      setAttribute(name, value) { this[name] = value; }, append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      querySelectorAll() { return []; }, closest(selector) { return selector === '[data-moderation-action]' && this.dataset.moderationAction ? this : null; }, reset() {}, focus() {}, click() { this.dispatch('click'); }
    };
  };
  for (const id of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id[1], node(id[1]));
  const document = { getElementById: id => elements.get(id), createElement: () => node(), activeElement: null, body: node('body'), querySelectorAll: () => [] };
  context = vm.createContext({
    document, window: {
      addEventListener: (name, listener) => windowListeners.set(name, listener),
      ...(withPicker ? { PepperPlayerPicker: { attach(config) {
        picker.config = config;
        return { reset() { picker.resets++; }, close() { picker.closes++; }, refresh() { picker.refreshes++; } };
      } } } : {})
    }, accountBanned: false, changelogRevision: 0,
    state: { user, accountSubmitting: false, chatMessages: [], profile: null, leaderboard: null }, trading: { chatMessages: [] },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    accountRole: value => value?.role || 'player', profileHref: name => `/profile/${name}`, profileAvatar: () => node(), playerRoleBadges: () => node(),
    renderChangelogEditor() {}, renderAnnouncementEditor() {}, setChatOpen() {}, renderChat() {}, renderProfileDetails() {}, renderLeaderboard() {}, renderTradeChat() {}, loadPresence() {}, loadLeaderboard() {}, loadChat() {}, clearChatReply() {}, navigateTo() {},
    loadChangelog: refresh => { changelogRefreshes.push(refresh); },
    message: (target, text) => { target.textContent = text; },
    api: async (route, options = {}) => {
      const call = { route, method: options.method || 'GET', payload: options.body ? JSON.parse(options.body) : undefined };
      if (route === 'version') { versionCalls.push(call); return versionNetwork ? versionNetwork(call) : { version: call.payload?.version || '0.6.1-2' }; }
      calls.push(call); return network ? network(call) : route.startsWith('moderation/players?') ? { players: [] } : {};
    },
    setUser: value => { context.state.user = value; context.window.PepperModeration.syncUser(); }
  });
  vm.runInContext(source.replace(/  syncUser\(\);\s*\}\)\(\);\s*$/, '  Object.assign(window.PepperModeration, { canBan, canDeleteChat, changePlayer, deleteChat, findPlayers, inspect: () => moderation });\n  syncUser();\n})();'), context);
  return { api: context.window.PepperModeration, context, elements, calls, versionCalls, changelogRefreshes, storage, picker, enable: () => elements.get('moderationViewToggle').click(), storageEvent: event => windowListeners.get('storage')?.(event) };
}
function showProfile(ui, player) {
  ui.context.state.profile = player;
  ui.api.renderProfileControls();
}
const profileActions = ui => ui.elements.get('profileModerationActions').children;
const profileLabels = ui => profileActions(ui).map(button => button.textContent).sort();
function clickProfileAction(ui, action) {
  const button = profileActions(ui).find(item => item.dataset.moderationAction === action);
  assert.ok(button, `Profile action ${action} exists`);
  ui.elements.get('profileModerationActions').dispatch('click', button);
  return button;
}

test('admin profile actions work without a matching settings search result', async () => {
  let player = { ...person('permanent-id'), username: 'DifferentUsername', balance: 42 };
  const ui = harness(person('admin', 'admin'), {
    network: call => call.method === 'GET' ? { players: [] } : { player: (player = { ...player, ...call.payload }) }
  });
  ui.enable(); await flush();
  const settingsMessage = ui.elements.get('moderationMessage').textContent;
  showProfile(ui, player);
  assert.equal(ui.elements.get('profileModeration').hidden, false);
  assert.deepEqual(profileLabels(ui), ['Ban', 'Make mod']);
  assert.equal(ui.api.inspect().players.length, 0);

  clickProfileAction(ui, 'make-mod'); await flush();
  assert.deepEqual(ui.calls.find(call => call.method === 'PATCH'), { route: 'moderation/players/permanent-id', method: 'PATCH', payload: { role: 'mod' } });
  assert.equal(ui.context.state.profile.role, 'mod');
  assert.equal(ui.context.state.profile.balance, 42);
  assert.deepEqual(profileLabels(ui), ['Ban', 'Remove mod']);
  assert.equal(ui.elements.get('profileModerationMessage').textContent, 'Moderator added.');
  assert.equal(ui.elements.get('moderationMessage').textContent, settingsMessage);

  clickProfileAction(ui, 'ban'); await flush();
  assert.equal(ui.context.state.profile.banned, true);
  assert.deepEqual(profileLabels(ui), ['Remove mod', 'Unban']);
  assert.equal(ui.elements.get('profileModerationMessage').textContent, 'Player banned.');
  clickProfileAction(ui, 'unban'); await flush();
  assert.equal(ui.context.state.profile.banned, false);
  assert.equal(ui.elements.get('profileModerationMessage').textContent, 'Player unbanned.');
  clickProfileAction(ui, 'remove-mod'); await flush();
  assert.equal(ui.context.state.profile.role, 'player');
  assert.deepEqual(profileLabels(ui), ['Ban', 'Make mod']);
});

test('profile moderation follows role hierarchy and management view state', async () => {
  for (const user of [person('admin', 'admin'), person('moderator', 'mod')]) {
    const ui = harness(user); ui.enable(); await flush();
    for (const player of [null, user, person('protected-admin', 'admin')]) {
      showProfile(ui, player);
      assert.equal(ui.elements.get('profileModeration').hidden, true);
      assert.equal(profileActions(ui).length, 0);
    }
    showProfile(ui, person('ordinary'));
    assert.equal(ui.elements.get('profileModeration').hidden, false);
    assert.deepEqual(profileLabels(ui), user.role === 'admin' ? ['Ban', 'Make mod'] : ['Ban']);
    showProfile(ui, person('banned', 'player', true));
    assert.ok(profileLabels(ui).includes('Unban'));
    showProfile(ui, person('other-mod', 'mod'));
    assert.equal(ui.elements.get('profileModeration').hidden, user.role !== 'admin');
    assert.deepEqual(profileLabels(ui), user.role === 'admin' ? ['Ban', 'Remove mod'] : []);
    ui.enable();
    showProfile(ui, person('ordinary'));
    assert.equal(ui.elements.get('profileModeration').hidden, true);
    assert.equal(profileActions(ui).length, 0);
  }
  for (const user of [null, person('ordinary'), person('banned-admin', 'admin', true)]) {
    const ui = harness(user); ui.enable(); await flush(); showProfile(ui, person('target'));
    assert.equal(ui.elements.get('profileModeration').hidden, true);
    assert.equal(profileActions(ui).length, 0);
  }
});

test('profile loading removes stale controls and ignores old target buttons', async () => {
  const ui = harness(person('admin', 'admin')); ui.enable(); await flush();
  const original = person('original'); showProfile(ui, original);
  const stale = profileActions(ui).find(button => button.dataset.moderationAction === 'ban');
  showProfile(ui, null);
  assert.equal(ui.elements.get('profileModeration').hidden, true);
  assert.equal(profileActions(ui).length, 0);
  ui.elements.get('profileModerationActions').dispatch('click', stale);
  assert.equal(ui.calls.filter(call => call.method === 'PATCH').length, 0);
  showProfile(ui, person('new-target'));
  ui.elements.get('profileModerationActions').dispatch('click', stale);
  assert.equal(ui.calls.filter(call => call.method === 'PATCH').length, 0);
});

test('profile actions stay pending once and do not overwrite a newly opened profile', async () => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const ui = harness(person('admin', 'admin'), { network: call => call.method === 'GET' ? { players: [] } : response });
  ui.enable(); await flush(); showProfile(ui, person('original'));
  const button = clickProfileAction(ui, 'ban');
  assert.equal(ui.elements.get('profileModerationMessage').textContent, 'Saving…');
  assert.ok(profileActions(ui).every(action => action.disabled));
  ui.elements.get('profileModerationActions').dispatch('click', button);
  assert.equal(ui.calls.filter(call => call.method === 'PATCH').length, 1);
  showProfile(ui, person('new-target'));
  resolve({ player: person('original', 'player', true) }); await flush();
  assert.equal(ui.context.state.profile.accountId, 'new-target');
  assert.equal(ui.context.state.profile.banned, false);
  assert.equal(ui.elements.get('profileModerationMessage').textContent, '');
  assert.deepEqual(profileLabels(ui), ['Ban', 'Make mod']);
  assert.ok(profileActions(ui).every(action => !action.disabled));
});

test('profile moderation errors stay on the profile and allow retry', async () => {
  const ui = harness(person('admin', 'admin'), { network: call => {
    if (call.method === 'GET') return { players: [] };
    throw new Error('Could not save.');
  } });
  ui.enable(); await flush(); showProfile(ui, person('target'));
  const settingsMessage = ui.elements.get('moderationMessage').textContent;
  clickProfileAction(ui, 'ban'); await flush();
  assert.equal(ui.elements.get('profileModerationMessage').textContent, 'Could not save.');
  assert.equal(ui.elements.get('moderationMessage').textContent, settingsMessage);
  assert.equal(ui.context.state.profile.banned, false);
  assert.ok(profileActions(ui).every(action => !action.disabled));
});

test('management view is opt-in and remembered separately for each privileged account', async () => {
  const storage = new Map(), admin = person('admin', 'admin');
  const first = harness(admin, { storage });
  assert.equal(first.api.enabled(), false);
  assert.equal(first.elements.get('moderationViewToggle').textContent, 'Open admin view');
  first.enable(); assert.equal(first.api.enabled(), true);
  await flush();
  assert.equal(first.elements.get('moderationViewToggle').textContent, 'Close admin view');
  assert.equal(harness(admin, { storage }).api.enabled(), true);
  assert.equal(harness(person('mod', 'mod'), { storage }).api.enabled(), false);
  first.context.setUser(person('ordinary')); assert.equal(first.api.enabled(), false);
  assert.equal(first.elements.get('moderationSettings').hidden, true);
});

test('player lists start folded in admin and mod views and preserve expansion during refresh', async () => {
  for (const role of ['admin', 'mod']) {
    const user = person(role, role), storage = new Map();
    const ui = harness(user, { storage, network: () => ({ players: [person('target')] }) });
    const section = ui.elements.get('moderationPlayerSettings'), details = ui.elements.get('moderationPlayerDetails');
    assert.equal(section.hidden, true);
    ui.enable();
    assert.equal(section.hidden, false);
    assert.equal(details.open, false);
    details.open = true;
    await flush();
    assert.equal(details.open, true, 'Loading players preserves the chosen expansion');
    assert.equal(ui.elements.get('moderationPlayers').children.length, 1);
    ui.context.setUser({ ...user, balance: 42 });
    assert.equal(details.open, true, 'Routine account refresh preserves expansion');
    ui.enable();
    assert.equal(section.hidden, true);
    assert.equal(details.open, false);
    ui.enable(); await flush();
    assert.equal(section.hidden, false);
    assert.equal(details.open, false);
    const restored = harness(user, { storage });
    assert.equal(restored.api.enabled(), true);
    assert.equal(restored.elements.get('moderationPlayerDetails').open, false, 'Remembered management view starts folded');
    await flush();
  }
});

test('player lists fold across account, role, storage, and banned view changes', async () => {
  for (const transition of ['account', 'role', 'storage', 'banned']) {
    const storage = new Map([['pepper-moderation-view:other-admin', 'open']]);
    const ui = harness(person('admin', 'admin'), { storage });
    ui.enable(); await flush();
    const details = ui.elements.get('moderationPlayerDetails'); details.open = true;
    if (transition === 'account') ui.context.setUser(person('other-admin', 'admin'));
    if (transition === 'role') ui.context.setUser(person('admin', 'mod'));
    if (transition === 'storage') {
      ui.storageEvent({ key: 'pepper-moderation-view:admin', newValue: 'closed' });
      assert.equal(details.open, false);
      assert.equal(ui.elements.get('moderationPlayerSettings').hidden, true);
      ui.storageEvent({ key: 'pepper-moderation-view:admin', newValue: 'open' });
    }
    if (transition === 'banned') { ui.context.accountBanned = true; ui.api.syncUser(); }
    assert.equal(details.open, false, transition);
    assert.equal(ui.elements.get('moderationPlayerSettings').hidden, transition === 'banned', transition);
    await flush();
  }
});

test('collapsing players closes suggestions while preserving the in-progress player load', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const ui = harness(person('admin', 'admin'), { withPicker: true, network: () => pending });
  ui.enable();
  const details = ui.elements.get('moderationPlayerDetails');
  details.open = true; details.dispatch('toggle');
  const resets = ui.picker.resets;
  details.open = false; details.dispatch('toggle');
  assert.equal(ui.picker.resets, resets + 1);
  assert.equal(ui.api.inspect().busy, true);
  resolve({ players: [person('target')] }); await flush();
  assert.equal(ui.elements.get('moderationPlayers').children.length, 1);
  assert.equal(ui.api.inspect().busy, false);
  assert.equal(details.open, false);
});

test('opening admin view loads players and exposes moderator controls immediately', async () => {
  const players = [person('ordinary'), person('existing_mod', 'mod')];
  const ui = harness(person('admin', 'admin'), { network: () => ({ players }) });
  assert.equal(ui.calls.length, 0);
  ui.enable();
  assert.equal(ui.elements.get('moderationControls').hidden, false);
  await flush();
  assert.deepEqual(ui.calls, [{ route: 'moderation/players?username=', method: 'GET', payload: undefined }]);
  const rows = ui.elements.get('moderationPlayers').children;
  assert.equal(rows.length, 2);
  assert.ok(rows[0].children[1].children.some(button => button.textContent === 'Make mod'));
  assert.ok(rows[1].children[1].children.some(button => button.textContent === 'Remove mod'));
});

test('management suggestions use the moderation endpoint and select exactly one permanent account', async () => {
  const players = [person('e'), { ...person('exact-id', 'player', true), username: 'example' }];
  const ui = harness(person('admin', 'admin'), { withPicker: true, network: () => ({ players }) });
  assert.equal(ui.picker.config.input, ui.elements.get('moderationUsername'));
  assert.equal(ui.picker.config.isEnabled(), false);
  assert.equal((await ui.picker.config.search('e')).length, 0);
  assert.equal(ui.calls.length, 0);
  ui.enable(); await flush();
  assert.equal(ui.picker.config.isEnabled(), true);
  const results = await ui.picker.config.search('ex &');
  assert.equal(results[1].banned, true);
  assert.equal(ui.calls.at(-1).route, 'moderation/players?username=ex%20%26');
  const before = ui.calls.length;
  ui.picker.config.onSelect(results[1]);
  assert.equal(ui.elements.get('moderationUsername').value, 'example');
  assert.deepEqual(Array.from(ui.api.inspect().players, player => player.accountId), ['exact-id']);
  const rows = ui.elements.get('moderationPlayers').children;
  assert.equal(rows.length, 1);
  assert.ok(rows[0].children[1].children.some(button => button.textContent === 'Unban'));
  assert.ok(rows[0].children[1].children.every(button => button.dataset.accountId === 'exact-id'));
  assert.equal(ui.calls.length, before, 'Selection does not ban, change roles, or make another request');
});

test('editing management search removes old controls and ignores an old target button', async () => {
  const target = person('old-target');
  const ui = harness(person('admin', 'admin'), { withPicker: true, network: () => ({ players: [target] }) });
  ui.enable(); await flush();
  ui.picker.config.onSelect(target);
  const stale = ui.elements.get('moderationPlayers').children[0].children[1].children[0];
  const resets = ui.picker.resets;
  ui.elements.get('moderationUsername').value = 'new';
  ui.elements.get('moderationUsername').dispatch('input');
  assert.equal(ui.picker.resets, resets + 1);
  assert.equal(ui.elements.get('moderationUsername').value, 'new');
  assert.equal(ui.elements.get('moderationPlayers').children.length, 0);
  assert.equal(ui.api.inspect().players.length, 0);
  ui.elements.get('moderationPlayers').dispatch('click', stale);
  assert.equal(ui.calls.filter(call => call.method === 'PATCH').length, 0);
});

test('edited management searches reject late Search form results', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const ui = harness(person('admin', 'admin'), { withPicker: true, network: () => pending });
  ui.enable();
  assert.equal(ui.api.inspect().busy, true);
  ui.elements.get('moderationUsername').value = 'new';
  ui.elements.get('moderationUsername').dispatch('input');
  assert.equal(ui.api.inspect().busy, false);
  resolve({ players: [person('old-target')] }); await flush();
  assert.equal(ui.elements.get('moderationPlayers').children.length, 0);
  assert.equal(ui.elements.get('moderationUsername').disabled, false);
});

test('management picker resets and discards suggestions across account, role, and view changes', async () => {
  for (const transition of ['account', 'role', 'view', 'storage', 'navigation', 'banned']) {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const ui = harness(person('admin', 'admin'), { withPicker: true, network: call => call.route.endsWith('username=') ? { players: [] } : pending });
    ui.enable(); await flush();
    const stale = ui.picker.config.search('ex');
    const resets = ui.picker.resets;
    if (transition === 'account') ui.context.setUser(person('other-admin', 'admin'));
    if (transition === 'role') ui.context.setUser(person('admin', 'mod'));
    if (transition === 'view') ui.enable();
    if (transition === 'storage') ui.storageEvent({ key: 'pepper-moderation-view:admin', newValue: 'closed' });
    if (transition === 'navigation') ui.api.closePlayerPicker();
    if (transition === 'banned') { ui.context.accountBanned = true; ui.api.syncUser(); }
    resolve({ players: [person('private-target')] });
    assert.equal((await stale).length, 0, transition);
    assert.ok(ui.picker.resets > resets, transition);
    assert.equal(ui.api.inspect().players.length, 0, transition);
    if (transition !== 'navigation' && transition !== 'role') assert.equal(ui.picker.config.isEnabled(), false, transition);
  }
});

test('disabled management picker cannot choose a target or expose controls', async () => {
  const ui = harness(person('mod', 'mod'), { withPicker: true });
  ui.picker.config.onSelect(person('target'));
  assert.equal(ui.api.inspect().players.length, 0);
  ui.enable(); await flush();
  ui.context.state.accountSubmitting = true;
  assert.equal(ui.picker.config.isEnabled(), false);
  ui.picker.config.onSelect(person('target'));
  assert.equal(ui.api.inspect().players.length, 0);
  ui.context.state.accountSubmitting = false;
  ui.picker.config.onSelect(person('protected', 'admin'));
  assert.equal(ui.elements.get('moderationPlayers').children[0].children[1].children.length, 0);
});

test('stored-open views load on startup and login without reloading on routine user refresh', async () => {
  for (const loggedInInitially of [true, false]) {
    const admin = person('admin', 'admin');
    const storage = new Map([['pepper-moderation-view:admin', 'open']]);
    const ui = harness(loggedInInitially ? admin : null, { storage });
    if (!loggedInInitially) {
      assert.equal(ui.calls.length, 0);
      ui.context.setUser(admin);
    }
    await flush();
    assert.equal(ui.api.enabled(), true);
    assert.equal(ui.calls.length, 1);
    ui.context.setUser({ ...admin, balance: 42 });
    ui.api.syncUser();
    await flush();
    assert.equal(ui.calls.length, 1);
  }
});

test('closed and unprivileged views never load player management data', async () => {
  const cases = [
    { user: person('admin', 'admin'), stored: 'closed' },
    { user: person('ordinary'), stored: 'open' },
    { user: person('banned_mod', 'mod', true), stored: 'open' },
    { user: null, stored: 'open' }
  ];
  for (const { user, stored } of cases) {
    const storage = new Map([[`pepper-moderation-view:${user?.accountId}`, stored]]);
    const ui = harness(user, { storage });
    ui.api.syncUser();
    if (user?.role !== 'admin') ui.enable();
    await flush();
    assert.equal(ui.api.enabled(), false);
    assert.equal(ui.calls.length, 0);
  }
});

test('opening management view in another tab loads players in this tab', async () => {
  const ui = harness(person('admin', 'admin'));
  ui.storageEvent({ key: 'pepper-moderation-view:admin', newValue: 'open' });
  await flush();
  assert.equal(ui.api.enabled(), true);
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].route, 'moderation/players?username=');
  ui.storageEvent({ key: 'pepper-moderation-view:admin', newValue: 'closed' });
  await flush();
  assert.equal(ui.api.enabled(), false);
  assert.equal(ui.calls.length, 1);
});

test('moderator gates exclude other moderators and admins while allowing their own chat messages', async () => {
  const mod = person('mod', 'mod'), ui = harness(mod); ui.enable();
  await flush();
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
  const admin = harness(person('admin', 'admin'), { network: call => call.method === 'GET' ? { players: [target] } : { player: { ...target, ...call.payload } } }); admin.enable();
  await flush();
  await admin.api.changePlayer(target, 'make-mod');
  assert.deepEqual(admin.calls.find(call => call.method === 'PATCH'), { route: 'moderation/players/target', method: 'PATCH', payload: { role: 'mod' } });
  const mod = harness(person('mod', 'mod')); mod.enable();
  await flush();
  await mod.api.changePlayer(person('other_mod', 'mod'), 'ban');
  await mod.api.changePlayer(target, 'make-mod');
  assert.equal(mod.calls.filter(call => call.method !== 'GET').length, 0);
});

test('a moderation response after switching accounts cannot populate the new account', async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const ui = harness(person('admin', 'admin'), { network: () => pending }); ui.enable();
  ui.context.setUser(person('ordinary'));
  resolve({ players: [person('private_target')] }); await flush();
  assert.equal(ui.api.inspect().players.length, 0);
  assert.equal(ui.elements.get('moderationSettings').hidden, true);
});

test('chat deletion confirms inline and preserves the saved message receipt', async () => {
  const ui = harness(person('admin', 'admin')); ui.enable();
  await flush();
  const item = { ...person('writer'), id: 'saved_message', text: 'Saved once', clientMessageId: 'receipt' };
  ui.context.state.chatMessages = [item];
  await ui.api.deleteChat(item); assert.equal(ui.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(ui.api.chatDeleteButton(item).textContent, 'Confirm delete');
  await ui.api.deleteChat(item);
  assert.equal(ui.calls.find(call => call.method === 'DELETE').route, 'chat/saved_message');
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

function editVersion(ui, value) {
  ui.elements.get('adminVersion').value = value;
  ui.elements.get('adminVersion').dispatch('input');
}
const submitVersion = ui => ui.elements.get('adminVersionForm').dispatch('submit');

test('site version controls and reads require an enabled admin view', async () => {
  for (const user of [null, person('ordinary'), person('mod', 'mod'), person('banned', 'admin', true)]) {
    const ui = harness(user); ui.enable(); await flush();
    assert.equal(ui.elements.get('adminVersionSettings').hidden, true);
    assert.equal(ui.elements.get('adminVersionSave').disabled, true);
    editVersion(ui, '0.6.1-3'); submitVersion(ui); await flush();
    assert.equal(ui.versionCalls.length, 0);
  }
  const admin = person('admin', 'admin'), ui = harness(admin);
  assert.equal(ui.elements.get('adminVersionSettings').hidden, true);
  assert.equal(ui.versionCalls.length, 0);
  ui.enable(); await flush();
  assert.equal(ui.elements.get('adminVersionSettings').hidden, false);
  assert.equal(ui.elements.get('adminVersion').value, '0.6.1-2');
  assert.deepEqual(ui.versionCalls, [{ route: 'version', method: 'GET', payload: undefined }]);
  ui.context.setUser({ ...admin, balance: 75 }); ui.api.syncUser(); await flush();
  assert.equal(ui.versionCalls.length, 1, 'Routine account refresh does not fetch the version again');
  ui.enable(); ui.enable(); await flush();
  assert.equal(ui.versionCalls.length, 2, 'Reopening fetches the current version once');
});

test('saving the site version sends only a version and refreshes the public version immediately', async () => {
  const ui = harness(person('admin', 'admin')); ui.enable(); await flush();
  editVersion(ui, ' V0.6.1-3 '); submitVersion(ui); await flush();
  assert.deepEqual(ui.versionCalls.at(-1), { route: 'version', method: 'PATCH', payload: { version: '0.6.1-3' } });
  assert.equal(ui.calls.filter(call => call.route.startsWith('changelog')).length, 0);
  assert.equal(ui.elements.get('siteVersion').textContent, '0.6.1-3');
  assert.equal(ui.elements.get('adminVersion').value, '0.6.1-3');
  assert.equal(ui.elements.get('adminVersionMessage').textContent, 'Version saved.');
  assert.equal(ui.context.changelogRevision, 1);
  assert.deepEqual(ui.changelogRefreshes, [true]);
});

test('invalid standalone versions cannot reach the server', async () => {
  const ui = harness(person('admin', 'admin')); ui.enable(); await flush();
  for (const value of ['', '0.6.1', '0.6.1--1', '0.6.01-2', '0.6.1-2 trailing', `${'9'.repeat(32)}.1.1-0`]) {
    editVersion(ui, value); submitVersion(ui); await flush();
    assert.match(ui.elements.get('adminVersionMessage').textContent, /0\.6\.1-2/);
  }
  assert.equal(ui.versionCalls.filter(call => call.method === 'PATCH').length, 0);
  assert.equal(ui.context.changelogRevision, 0);
});

test('pending version saves disable repeated submissions and keep the submitted draft', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const ui = harness(person('admin', 'admin'), { versionNetwork: call => call.method === 'GET' ? { version: '0.6.1-2' } : pending });
  ui.enable(); await flush(); editVersion(ui, '0.6.1-3'); submitVersion(ui);
  assert.equal(ui.elements.get('adminVersion').disabled, true);
  assert.equal(ui.elements.get('adminVersionSave').disabled, true);
  assert.equal(ui.elements.get('adminVersionSave').textContent, 'Saving…');
  ui.api.syncVersion('0.6.1-8'); submitVersion(ui);
  assert.equal(ui.elements.get('adminVersion').value, '0.6.1-3');
  assert.equal(ui.versionCalls.filter(call => call.method === 'PATCH').length, 1);
  resolve({ version: '0.6.1-3' }); await flush();
  assert.equal(ui.elements.get('adminVersionSave').disabled, false);
  assert.equal(ui.elements.get('adminVersionSave').textContent, 'Save version');
  assert.equal(ui.elements.get('siteVersion').textContent, '0.6.1-3');
});

test('version drafts survive public refreshes and view toggles but clear on account or role changes', async () => {
  const ui = harness(person('admin', 'admin')); ui.enable(); await flush();
  ui.api.syncVersion('0.6.1-4');
  assert.equal(ui.elements.get('adminVersion').value, '0.6.1-4');
  editVersion(ui, '0.6.1-9'); ui.api.syncVersion('0.6.1-5');
  assert.equal(ui.elements.get('adminVersion').value, '0.6.1-9');
  ui.enable(); ui.enable(); await flush();
  assert.equal(ui.elements.get('adminVersion').value, '0.6.1-9');
  ui.context.setUser(person('other-admin', 'admin'));
  assert.equal(ui.elements.get('adminVersion').value, '');
  ui.enable(); await flush();
  assert.equal(ui.elements.get('adminVersion').value, '0.6.1-2');
  editVersion(ui, '0.6.1-8'); ui.context.setUser(person('other-admin', 'mod'));
  assert.equal(ui.elements.get('adminVersion').value, '');
  assert.equal(ui.elements.get('adminVersionSettings').hidden, true);
});

test('late version reads cannot cross admin account, role, or view changes', async () => {
  for (const transition of ['account', 'role', 'view', 'storage', 'banned']) {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const ui = harness(person('admin', 'admin'), { versionNetwork: () => pending }); ui.enable(); await flush();
    if (transition === 'account') ui.context.setUser(person('another', 'admin'));
    if (transition === 'role') ui.context.setUser(person('admin', 'mod'));
    if (transition === 'view') ui.enable();
    if (transition === 'storage') ui.storageEvent({ key: 'pepper-moderation-view:admin', newValue: 'closed' });
    if (transition === 'banned') { ui.context.accountBanned = true; ui.api.syncUser(); }
    ui.api.syncVersion('0.6.1-8');
    resolve({ version: '0.6.1-2' }); await flush();
    assert.equal(ui.elements.get('adminVersion').value, '0.6.1-8', transition);
    assert.equal(ui.elements.get('adminVersionSettings').hidden, true, transition);
    assert.equal(ui.elements.get('adminVersionMessage').textContent.includes('unavailable'), false, transition);
  }
});

test('a standalone save invalidates an older version read', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const ui = harness(person('admin', 'admin'), { versionNetwork: call => call.method === 'GET' ? pending : { version: call.payload.version } });
  ui.enable(); editVersion(ui, '0.6.1-3'); submitVersion(ui); await flush();
  resolve({ version: '0.6.1-2' }); await flush();
  assert.equal(ui.elements.get('adminVersion').value, '0.6.1-3');
  assert.equal(ui.elements.get('siteVersion').textContent, '0.6.1-3');
  assert.equal(ui.elements.get('adminVersionMessage').textContent, 'Version saved.');
  assert.equal(ui.context.changelogRevision, 1);
});

test('late version saves cannot overwrite a newer account or closed management view', async () => {
  for (const transition of ['account', 'role', 'view', 'storage', 'banned']) {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const ui = harness(person('admin', 'admin'), { versionNetwork: call => call.method === 'GET' ? { version: '0.6.1-2' } : pending });
    ui.enable(); await flush(); ui.elements.get('siteVersion').textContent = '0.6.1-2';
    editVersion(ui, '0.6.1-3'); submitVersion(ui);
    if (transition === 'account') ui.context.setUser(person('another', 'admin'));
    if (transition === 'role') ui.context.setUser(person('admin', 'mod'));
    if (transition === 'view') ui.enable();
    if (transition === 'storage') ui.storageEvent({ key: 'pepper-moderation-view:admin', newValue: 'closed' });
    if (transition === 'banned') { ui.context.accountBanned = true; ui.api.syncUser(); }
    resolve({ version: '0.6.1-3' }); await flush();
    assert.equal(ui.elements.get('siteVersion').textContent, '0.6.1-2', transition);
    assert.equal(ui.context.changelogRevision, 0, transition);
    assert.equal(ui.changelogRefreshes.length, 0, transition);
    assert.equal(ui.elements.get('adminVersionSettings').hidden, true, transition);
    assert.equal(ui.elements.get('adminVersionMessage').textContent.includes('saved'), false, transition);
  }
});

test('failed version saves preserve the draft and allow retry', async () => {
  let fail = true;
  const ui = harness(person('admin', 'admin'), { versionNetwork: call => {
    if (call.method === 'GET') return { version: '0.6.1-2' };
    if (fail) throw new Error('Could not save.');
    return { version: call.payload.version };
  } });
  ui.enable(); await flush(); editVersion(ui, '0.6.1-3'); submitVersion(ui); await flush();
  assert.equal(ui.elements.get('adminVersionMessage').textContent, 'Could not save.');
  assert.equal(ui.elements.get('adminVersion').value, '0.6.1-3');
  assert.equal(ui.elements.get('adminVersionSave').disabled, false);
  assert.equal(ui.context.changelogRevision, 0);
  ui.api.syncVersion('0.6.1-7');
  assert.equal(ui.elements.get('adminVersion').value, '0.6.1-3');
  fail = false; submitVersion(ui); await flush();
  assert.equal(ui.elements.get('siteVersion').textContent, '0.6.1-3');
  assert.equal(ui.context.changelogRevision, 1);
});
