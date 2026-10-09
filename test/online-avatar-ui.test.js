const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function productionFunction(name) {
  const match = new RegExp(`function ${name}\\(`).exec(source);
  assert.ok(match, `Production function ${name} exists`);
  return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}

function harness() {
  const elements = new Map();
  const createNode = tag => {
    const classes = new Set();
    const attributes = new Map();
    let text = '';
    return {
      tagName: tag.toUpperCase(), children: [], parentNode: null, dataset: {}, hidden: false,
      scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      get childNodes() { return this.children; },
      get className() { return [...classes].join(' '); },
      set className(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
      classList: {
        contains: name => classes.has(name),
        toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }
      },
      get textContent() { return text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { text = String(value); this.children.forEach(child => { child.parentNode = null; }); this.children = []; },
      set src(value) { attributes.set('src', value); }, get src() { return attributes.get('src'); },
      setAttribute: (key, value) => attributes.set(key, value),
      getAttribute: key => attributes.get(key) ?? null,
      matches(selector) { return selector.startsWith('.') ? classes.has(selector.slice(1)) : this.tagName === selector.toUpperCase(); },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      append(...children) { children.forEach(child => this.insertBefore(child, null)); },
      insertBefore(child, before) {
        if (child.tagName === '#FRAGMENT') { [...child.children].forEach(item => this.insertBefore(item, before)); return; }
        child.remove();
        const index = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(index, 0, child); child.parentNode = this;
      },
      replaceChildren(...children) { [...this.children].forEach(child => child.remove()); this.append(...children); },
      remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; },
      replaceWith(child) { const parent = this.parentNode; parent.insertBefore(child, this); this.remove(); },
      contains(child) { return child === this || this.children.some(item => item.contains(child)); },
      getBoundingClientRect() { return { top: 0, bottom: 20 }; },
      closest() { return null; }, focus() {},
      get isConnected() { return !!this.parentNode; }
    };
  };
  for (const id of ['chatMessages', 'leaderboardRows', 'leaderboardSummary', 'playerCount', 'mobilePlayerCount', 'onlinePlayersDialog']) elements.set(id, createNode('div'));
  const document = { activeElement: null, getElementById: id => elements.get(id), createElement: createNode, createDocumentFragment: () => createNode('#fragment') };
  const context = vm.createContext({
    document, URL, Date, location: { origin: 'http://localhost:3000' }, window: {},
    state: { user: null, chatMessages: [], chatOutbox: [], chatSignature: null, chatFollowLatest: true, chatReply: null, leaderboardSignature: null },
    presencePlayers: null, chatInFlight: new Set(),
    $: id => elements.get(id), message: (node, value) => { node.textContent = value; },
    scrollChatToLatest() {}, renderOnlinePlayers() {}, clearChatReply() {},
    isOwnChatMessage: () => false
  });
  const functions = ['isOwnProfile', 'profileHref', 'accountRole', 'playerRoleBadges', 'profilePictureUrl', 'setProfileAvatar', 'profileAvatar', 'updateAvatarPresence', 'refreshOnlineAvatars', 'renderPresence', 'createChatRow', 'renderChat', 'renderLeaderboard'];
  vm.runInContext(functions.map(productionFunction).join('\n'), context);
  return { context, elements, presence: players => context.renderPresence(players.length, players), chat: messages => context.renderChat(messages), leaderboard: entries => context.renderLeaderboard({ entries, totalPlayers: entries.length }) };
}
const player = (accountId, username = accountId, extras = {}) => ({ accountId, username, avatarUrl: '/favicon.svg', balance: 10, rank: 1, ...extras });
const message = (person, id) => ({ ...person, id, text: 'Hello', createdAt: '2026-10-08T12:00:00.000Z' });
const indicators = node => node.querySelectorAll('.online-indicator');

test('online status updates existing public chat and leaderboard avatars without replacing rows', () => {
  const ui = harness();
  const pepper = player('permanent-pepper');
  const chatMessages = [message(pepper, 'first'), message(pepper, 'second')];
  ui.chat(chatMessages); ui.leaderboard([pepper]);
  const chatRows = [...ui.elements.get('chatMessages').children];
  const leaderboardRow = ui.elements.get('leaderboardRows').children[0];
  assert.ok(indicators(ui.elements.get('chatMessages')).every(dot => dot.hidden));
  assert.ok(indicators(leaderboardRow).every(dot => dot.hidden));

  ui.presence([pepper]);
  ui.chat(chatMessages); ui.leaderboard([pepper]);
  assert.deepEqual(ui.elements.get('chatMessages').children, chatRows);
  assert.equal(ui.elements.get('leaderboardRows').children[0], leaderboardRow);
  assert.equal(indicators(ui.elements.get('chatMessages')).length, 2);
  assert.ok(indicators(ui.elements.get('chatMessages')).every(dot => !dot.hidden));
  assert.equal(indicators(leaderboardRow)[0].hidden, false);

  ui.presence([]);
  assert.ok(indicators(ui.elements.get('chatMessages')).every(dot => dot.hidden));
  assert.equal(indicators(leaderboardRow)[0].hidden, true);
});

test('presence follows permanent identity through renamed and reused usernames', () => {
  const ui = harness();
  const original = player('original', 'OldName');
  const reused = player('different-account', 'OldName');
  const missingId = player('', 'OldName');
  ui.chat([message(original, 'original-message'), message(reused, 'reused-message'), message(missingId, 'legacy-message')]);
  ui.leaderboard([original, reused]);
  ui.presence([player(original.accountId, 'NewName')]);
  assert.deepEqual(indicators(ui.elements.get('chatMessages')).map(dot => dot.hidden), [false, true, true]);
  assert.deepEqual(indicators(ui.elements.get('leaderboardRows')).map(dot => dot.hidden), [false, true]);
});

test('new messages and leaderboard entries reflect already loaded presence', () => {
  const ui = harness();
  const pepper = player('pepper');
  ui.presence([pepper]);
  ui.context.state.chatOutbox = [{ ...message(pepper, 'pending'), clientMessageId: 'pending-id', status: 'pending' }];
  ui.chat([message(pepper, 'saved')]); ui.leaderboard([pepper]);
  assert.deepEqual(indicators(ui.elements.get('chatMessages')).map(dot => dot.hidden), [false, false]);
  assert.equal(indicators(ui.elements.get('leaderboardRows'))[0].hidden, false);
});

test('unavailable presence clears stale online indicators and repeated refreshes do not duplicate dots', () => {
  const ui = harness(); const pepper = player('pepper');
  ui.chat([message(pepper, 'saved')]); ui.leaderboard([pepper]);
  for (let index = 0; index < 5; index += 1) ui.presence([pepper]);
  assert.equal(indicators(ui.elements.get('chatMessages')).length, 1);
  assert.equal(indicators(ui.elements.get('leaderboardRows')).length, 1);
  ui.context.renderPresence(null);
  assert.equal(indicators(ui.elements.get('chatMessages'))[0].hidden, true);
  assert.equal(indicators(ui.elements.get('leaderboardRows'))[0].hidden, true);
  ui.presence([pepper]);
  assert.equal(indicators(ui.elements.get('chatMessages'))[0].hidden, false);
});

test('banned players never receive online indicators from stale presence', () => {
  const ui = harness(); const pepper = player('pepper', 'Pepper', { banned: true });
  ui.presence([player('pepper')]);
  ui.chat([message(pepper, 'saved')]); ui.leaderboard([pepper]);
  assert.equal(indicators(ui.elements.get('chatMessages'))[0].hidden, true);
  assert.equal(indicators(ui.elements.get('leaderboardRows'))[0].hidden, true);
  ui.presence([pepper]);
  assert.equal(indicators(ui.elements.get('chatMessages'))[0].hidden, true);
});

test('online wrapper preserves distinct pictures, safe names, and profile links', () => {
  const ui = harness();
  const custom = player('custom', '<img onerror=alert(1)>', { avatarUrl: '/api/avatars/custom-picture' });
  const invalid = player('invalid', 'Second', { avatarUrl: 'https://external.example/picture.jpg' });
  ui.presence([custom, invalid]); ui.chat([message(custom, 'custom'), message(invalid, 'invalid')]); ui.leaderboard([custom, invalid]);
  const chat = ui.elements.get('chatMessages');
  assert.deepEqual(chat.querySelectorAll('img').map(img => img.src), ['/api/avatars/custom-picture', '/favicon.svg']);
  assert.equal(chat.querySelector('.chat-author').textContent, custom.username);
  assert.equal(chat.querySelector('.chat-author').href, `/profile/${encodeURIComponent(custom.username)}`);
  const links = ui.elements.get('leaderboardRows').querySelectorAll('a');
  assert.equal(links[0].href, `/profile/${encodeURIComponent(custom.username)}`);
  assert.equal(links[0].querySelector('img').src, '/api/avatars/custom-picture');
  assert.equal(links[0].querySelector('.online-indicator').getAttribute('aria-label'), 'Online');
});

test('other profile pictures remain ordinary images without presence decoration', () => {
  const ui = harness(); const pepper = player('pepper'); ui.presence([pepper]);
  const image = ui.context.profileAvatar(pepper);
  assert.equal(image.tagName, 'IMG');
  assert.equal(image.src, '/favicon.svg');
  assert.equal(indicators(image).length, 0);
});
