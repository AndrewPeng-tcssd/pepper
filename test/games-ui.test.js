const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../public/games.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const player = username => ({ accountId: `PPR-${crypto.randomUUID()}`, username, balance: 100 });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const game = (sender, recipient, extra = {}) => ({
  id: crypto.randomBytes(12).toString('hex'), clientRequestId: crypto.randomUUID(), game: 'tic-tac-toe', stake: 10,
  sender, recipient, status: 'pending', version: 1, board: Array(9).fill(null), turnAccountId: sender.accountId,
  yourChoice: null, opponentChosen: false, choices: null, winnerAccountId: null, result: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString(), ...extra
});

// Exercise the whole production module with only DOM and network boundaries replaced.
function harness(user, entries = [], network) {
  const elements = new Map(), calls = [], navigation = [];
  let context;
  const node = (id = '', attrs = '') => {
    const classes = new Set(), listeners = new Map();
    return {
      id, children: [], dataset: {}, textContent: '', value: /value="([^"]*)"/.exec(attrs)?.[1] || '', hidden: /\bhidden\b/.test(attrs), disabled: false,
      classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      dispatch(type, target = this) { return listeners.get(type)?.({ preventDefault() {}, target }); },
      contains(target) { return !!target && (this === target || this.children.includes(target)); },
      closest(selector) { return selector === '[data-game-action]' && this.dataset.gameAction ? this : null; },
      focus() { document.activeElement = this; },
      querySelector() { return radios.find(radio => radio.checked); },
      querySelectorAll(selector) { return selector === 'input' ? [...radios, elements.get('gamesUsername'), elements.get('gamesStake')] : []; },
      reset() { elements.get('gamesUsername').value = ''; elements.get('gamesStake').value = '0'; radios[0].checked = true; radios[1].checked = false; },
      click() { this.dispatch('click'); }
    };
  };
  for (const match of html.matchAll(/<[a-z][a-z0-9]*\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(match[2], node(match[2], match[1]));
  const radios = [{ value: 'tic-tac-toe', checked: true }, { value: 'rock-paper-scissors', checked: false }];
  const document = { getElementById: id => elements.get(id), createElement: () => node(), body: node(), activeElement: null, contains: () => true, querySelectorAll: () => [] };
  const boundary = {
    document, window: {}, crypto, console, setInterval() {}, state: { user: null, accountSubmitting: false }, authRevision: 0, userIdentityRevision: 0, routeRevision: 0, pageKind: 'games',
    profileHref: username => `/profile/${username}`, profileAvatar: () => node(), playerRoleBadges: () => node(), setChatOpen() {}, focusRouteHeading() {},
    navigateTo(route) { navigation.push(route); context.pageKind = 'games'; context.routeRevision++; },
    message(target, text) { target.textContent = text; },
    setUser(value) { if (context.state.user?.accountId !== value?.accountId) context.userIdentityRevision++; context.authRevision++; context.state.user = value; context.window.PepperGames.syncUser(); },
    api: async (route, options = {}) => {
      const call = { route, method: options.method || 'GET', payload: options.body ? JSON.parse(options.body) : null }; calls.push(call);
      const result = network ? await network(call) : undefined;
      if (result !== undefined) return result;
      if (route === 'games' && call.method === 'GET') return { games: entries, user: context.state.user };
      throw new Error(`Unexpected API call ${call.method} ${route}`);
    }
  };
  context = vm.createContext(boundary);
  vm.runInContext(source.replace('window.PepperGames = { syncUser, load, onRoute, renderNotification };', 'window.PepperGames = { syncUser, load, onRoute, renderNotification, inspect: () => games, perform, requestGame, act, render };'), context);
  boundary.setUser(user);
  return { api: context.window.PepperGames, elements, calls, navigation, context, setUser: boundary.setUser, entries };
}

test('game requests freeze the agreed stake and send once during username lookup', async () => {
  const local = player('local'), other = player('other'), lookup = deferred();
  const ui = harness(local, [], call => {
    if (call.route.startsWith('profiles/')) return lookup.promise;
    if (call.method === 'POST') return { game: game(local, other, { clientRequestId: call.payload.clientRequestId, stake: call.payload.stake }), user: local };
  });
  await tick();
  ui.elements.get('gamesUsername').value = 'other'; ui.elements.get('gamesStake').value = '12';
  const submitted = ui.api.requestGame({ preventDefault() {} });
  await ui.api.requestGame({ preventDefault() {} });
  assert.equal(ui.elements.get('gamesSend').disabled, true);
  lookup.resolve({ profile: other }); await submitted; await tick();
  const posts = ui.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].route, 'games');
  assert.equal(posts[0].payload.recipientAccountId, other.accountId); assert.equal(posts[0].payload.stake, 12);
  assert.equal(posts[0].payload.game, 'tic-tac-toe'); assert.match(posts[0].payload.clientRequestId, /^[a-f0-9-]{36}$/);
});

test('game invitation shows the equal stake and waits behind a trade notification', async () => {
  const local = player('local'), other = player('other'), invitation = game(other, local, { stake: 25 });
  const ui = harness(local, [invitation]); await tick();
  assert.equal(ui.elements.get('gameNotification').hidden, false);
  assert.equal(ui.elements.get('gameNotificationAccept').textContent, 'Accept · 25 tokens');
  assert.match(ui.elements.get('gameNotificationTerms').textContent, /25 tokens each/);
  ui.elements.get('tradeNotification').hidden = false; ui.api.renderNotification();
  assert.equal(ui.elements.get('gameNotification').hidden, true);
  ui.elements.get('tradeNotification').hidden = true; ui.api.renderNotification();
  assert.equal(ui.elements.get('gameNotification').hidden, false);
});

test('an uncertain game move retries the same ID and blocks new moves until resolved', async () => {
  const local = player('local'), other = player('other'), match = game(local, other, { status: 'playing', version: 2 });
  let attempts = 0;
  const ui = harness(local, [match], call => {
    if (call.method === 'POST') {
      if (++attempts === 1) throw new Error('Response lost');
      return { game: { ...match, version: 3, turnAccountId: other.accountId, board: ['X', ...Array(8).fill(null)] }, user: local };
    }
  });
  await tick();
  const operation = { id: match.id, action: 'move', payload: { clientMoveId: crypto.randomUUID(), position: 0 } };
  await ui.api.perform(operation); await tick();
  assert.equal(ui.api.inspect().retry, operation);
  ui.api.act('move', match.id, { clientMoveId: crypto.randomUUID(), position: 1 });
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  await ui.api.perform(ui.api.inspect().retry); await tick();
  const posts = ui.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2); assert.deepEqual(posts[0].payload, posts[1].payload);
  assert.equal(ui.api.inspect().retry, null); assert.equal(ui.api.inspect().entries[0].board[0], 'X');
  assert.equal(ui.api.inspect().entries[0].version, 3);
});

test('an old account game response cannot change the next account or reopen its session', async () => {
  const local = player('local'), other = player('other'), next = player('next'), match = game(other, local), accepting = deferred();
  const ui = harness(local, [], call => call.method === 'POST' ? accepting.promise : undefined); await tick();
  const pending = ui.api.perform({ id: match.id, action: 'accept', payload: {} });
  ui.setUser(next); await tick();
  accepting.resolve({ game: { ...match, status: 'playing' }, user: { ...local, balance: 90 } });
  await pending; await tick();
  assert.equal(ui.context.state.user.accountId, next.accountId);
  assert.equal(ui.context.state.user.balance, 100);
  assert.equal(ui.api.inspect().entries.length, 0); assert.equal(ui.api.inspect().selectedId, null);
});

test('Rock Paper Scissors keeps the opponent hidden until the completed result arrives', async () => {
  const local = player('local'), other = player('other');
  const match = game(local, other, { game: 'rock-paper-scissors', status: 'playing', version: 3, yourChoice: 'rock', opponentChosen: true });
  const ui = harness(local, [match]); await tick(); ui.api.act('open', match.id);
  assert.equal(ui.elements.get('gamesReveal').children[0].textContent, 'You: Rock');
  assert.equal(ui.elements.get('gamesReveal').children[1].textContent, 'Opponent: Ready');
  assert.ok(ui.elements.get('gamesChoices').children.every(button => button.disabled));
  ui.entries[0] = { ...match, version: 4, status: 'completed', choices: { sender: 'rock', recipient: 'scissors' }, result: 'win', winnerAccountId: local.accountId };
  await ui.api.load();
  assert.equal(ui.elements.get('gamesReveal').children[1].textContent, 'Opponent: Scissors');
  assert.equal(ui.elements.get('gamesTurn').textContent, 'You won 20 tokens');
});
