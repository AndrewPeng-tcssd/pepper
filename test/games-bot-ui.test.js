const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../public/games.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const bot = { accountId: 'BOT', username: 'Bot', isBot: true, avatarUrl: null, role: 'player', banned: false };
const player = username => ({ accountId: `PPR-${crypto.randomUUID()}`, username, balance: 100 });
const match = (sender, extra = {}) => ({
  id: crypto.randomBytes(12).toString('hex'), clientRequestId: crypto.randomUUID(), game: 'tic-tac-toe', opponentType: 'bot', stake: 10,
  sender, recipient: bot, status: 'playing', version: 1, board: Array(9).fill(null), xAccountId: sender.accountId,
  turnAccountId: sender.accountId, yourChoice: null, opponentChosen: false, choices: null, winnerAccountId: null, result: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString(), ...extra
});
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Run production UI against small DOM and network boundaries, including all draft controls.
function harness(user, entries = [], network) {
  const elements = new Map(), calls = [], pickers = [], profileNames = [];
  let context;
  const radios = [{ value: 'tic-tac-toe', checked: true }, { value: 'rock-paper-scissors' }, { value: 'dice' }];
  const node = (id = '', attrs = '', tagName = 'DIV') => {
    const classes = new Set(), listeners = new Map();
    return {
      id, tagName, children: [], dataset: {}, textContent: '', value: /value="([^"]*)"/.exec(attrs)?.[1] || '', hidden: /\bhidden\b/.test(attrs), disabled: false,
      classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, setAttribute(name, value) { this[name] = value; },
      addEventListener(type, listener) { listeners.set(type, listener); }, dispatch(type, target = this) { return listeners.get(type)?.({ preventDefault() {}, target }); },
      contains(target) { return !!target && (this === target || this.children.includes(target)); },
      closest(selector) { return selector === '[data-game-action]' && this.dataset.gameAction ? this : null; },
      focus() { document.activeElement = this; }, querySelector() { return radios.find(radio => radio.checked); },
      querySelectorAll(selector) { return selector === 'input, select' ? [...radios, ...['gamesUsername', 'gamesStake', 'gamesPlayerCount', 'gamesPayoutMode', 'gamesOpponentType'].map(id => elements.get(id))] : []; },
      reset() { elements.get('gamesUsername').value = ''; elements.get('gamesStake').value = '1'; elements.get('gamesPlayerCount').value = '2'; elements.get('gamesPayoutMode').value = 'shared'; elements.get('gamesOpponentType').value = 'player'; radios.forEach((radio, index) => { radio.checked = index === 0; }); },
      click() { this.dispatch('click'); }
    };
  };
  for (const found of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(found[3], node(found[3], found[2], found[1].toUpperCase()));
  const document = { getElementById: id => elements.get(id), createElement: tag => node('', '', tag.toUpperCase()), body: node(), activeElement: null, contains: () => true, querySelectorAll: () => [] };
  const boundary = {
    document, window: { PepperPlayerPicker: { attach(settings) { const picker = { close() {}, reset() {} }; pickers.push({ settings, picker }); return picker; } } },
    crypto, console, setInterval() {}, setTimeout(callback) { callback(); }, state: { user: null, accountSubmitting: false }, authRevision: 0, userIdentityRevision: 0, routeRevision: 0, pageKind: 'games', accountBanned: false,
    profileHref(username) { profileNames.push(username); return `/profile/${username}`; }, profileAvatar: () => node(), playerRoleBadges: () => node(), setChatOpen() {}, focusRouteHeading() {},
    navigateTo() { context.pageKind = 'games'; context.routeRevision++; }, message(target, text) { target.textContent = text; },
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
  return { api: context.window.PepperGames, elements, calls, context, setUser: boundary.setUser, entries, radios, pickers, profileNames };
}
function choose(ui, type, opponent = 'bot') {
  ui.radios.forEach(radio => { radio.checked = radio.value === type; });
  ui.elements.get('gamesOpponentType').value = opponent;
  ui.elements.get('gamesRequestForm').dispatch('change', ui.elements.get('gamesOpponentType'));
}

test('bot selection removes the required username, disables suggestions, and resets for Dice', async () => {
  const ui = harness(player('local')); await tick();
  choose(ui, 'tic-tac-toe');
  assert.equal(ui.elements.get('gamesUsername').required, false);
  assert.equal(ui.elements.get('gamesUsername').disabled, true);
  assert.equal(ui.elements.get('gamesUsernameField').hidden, true);
  assert.equal(ui.elements.get('gamesBotNote').hidden, false);
  assert.equal(ui.elements.get('gamesSend').textContent, 'Start match');
  assert.equal(ui.pickers[0].settings.isEnabled(), false);
  choose(ui, 'dice');
  assert.equal(ui.elements.get('gamesOpponentType').value, 'player');
  assert.equal(ui.elements.get('gamesOpponentOptions').hidden, true);
  assert.equal(ui.elements.get('gamesBotNote').hidden, true);
  assert.equal(ui.elements.get('gamesSend').textContent, 'Send request');
  choose(ui, 'rock-paper-scissors', 'player');
  assert.equal(ui.elements.get('gamesUsername').required, true);
  assert.equal(ui.elements.get('gamesUsernameField').hidden, false);
  assert.equal(ui.elements.get('gamesOpponentOptions').hidden, false);
});

test('both bot games start directly without account lookup or recipient IDs', async () => {
  for (const type of ['tic-tac-toe', 'rock-paper-scissors']) {
    const local = player('local');
    const ui = harness(local, [], call => call.method === 'POST' ? { game: match(local, { ...call.payload }), user: local } : undefined);
    await tick(); choose(ui, type); ui.elements.get('gamesStake').value = '17';
    await ui.api.requestGame({ preventDefault() {} }); await tick();
    const posts = ui.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1); assert.equal(posts[0].route, 'games');
    assert.deepEqual(Object.keys(posts[0].payload).sort(), ['clientRequestId', 'game', 'opponentType', 'stake']);
    assert.equal(posts[0].payload.opponentType, 'bot'); assert.equal(posts[0].payload.game, type); assert.equal(posts[0].payload.stake, 17);
    assert.ok(ui.calls.every(call => call.route === 'games'));
    assert.equal(ui.elements.get('gamesSession').hidden, false);
    assert.equal(ui.elements.get('gamesStakeSummary').textContent, '17 tokens each');
    assert.equal(ui.elements.get('gamesPot').textContent, '34 token pot');
    assert.equal(ui.elements.get('gameNotification').hidden, true);
    assert.equal(ui.elements.get('gamesMessage').textContent, 'Match started.');
    assert.equal(ui.elements.get('gamesOpponentType').value, 'player');
  }
});

test('bot bets enforce whole tokens and the player balance before sending', async () => {
  const ui = harness(player('local')); await tick(); choose(ui, 'tic-tac-toe');
  for (const stake of ['', '0', '-1', '1.5', '2251799813685248']) {
    ui.elements.get('gamesStake').value = stake;
    await ui.api.requestGame({ preventDefault() {} });
    assert.equal(ui.elements.get('gamesMessage').textContent, 'Bet at least 1 token.');
  }
  ui.elements.get('gamesStake').value = '101'; await ui.api.requestGame({ preventDefault() {} });
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Not enough tokens.');
  assert.ok(ui.calls.every(call => call.method === 'GET'));
});

test('Bot has no profile link, and an opening bot move leaves the player immediately able to play', async () => {
  const local = player('local'), board = Array(9).fill(null); board[4] = 'X';
  const game = match(local, { xAccountId: 'BOT', board });
  const ui = harness(local, [game]); await tick(); ui.api.act('open', game.id);
  const botIdentity = ui.elements.get('gamesPlayers').children[1].children[1];
  assert.equal(botIdentity.tagName, 'SPAN'); assert.equal(botIdentity.href, undefined);
  assert.equal(botIdentity.children[1].textContent, 'Bot');
  assert.ok(!ui.profileNames.includes('Bot'));
  assert.equal(ui.elements.get('gamesPlayers').children[1].children[2].textContent, 'X');
  assert.equal(ui.elements.get('gamesPlayers').children[0].children[2].textContent, 'O');
  assert.equal(ui.elements.get('gamesTurn').textContent, 'Your turn');
  assert.equal(ui.elements.get('gamesBoard').children[4].disabled, true);
  assert.ok(ui.elements.get('gamesBoard').children.filter((_, index) => index !== 4).every(square => !square.disabled));
});

test('uncertain bot creation freezes the original stake and request ID across a safe retry', async () => {
  const local = player('local'); let attempts = 0;
  const response = deferred();
  const ui = harness(local, [], call => {
    if (call.method !== 'POST') return;
    if (++attempts === 1) return response.promise;
    return { game: match(local, { ...call.payload }), user: local };
  });
  await tick(); choose(ui, 'rock-paper-scissors'); ui.elements.get('gamesStake').value = '29';
  const pending = ui.api.requestGame({ preventDefault() {} });
  assert.equal(ui.elements.get('gamesOpponentType').disabled, true);
  assert.equal(ui.elements.get('gamesStake').disabled, true);
  assert.equal(ui.elements.get('gamesSend').textContent, 'Starting…');
  await ui.api.requestGame({ preventDefault() {} });
  response.resolve(Promise.reject(new Error('Response lost'))); await pending; await tick();
  const retry = ui.api.inspect().retry;
  assert.ok(retry); assert.equal(ui.elements.get('gamesOpponentType').disabled, true);
  await ui.api.perform(retry); await tick();
  const posts = ui.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2); assert.deepEqual(posts[0].payload, posts[1].payload);
  assert.equal(posts[1].payload.stake, 29); assert.equal(posts[1].payload.opponentType, 'bot');
  assert.equal(ui.api.inspect().retry, null);
});

test('a bot RPS response reveals both moves and the result immediately', async () => {
  const local = player('local'), game = match(local, { game: 'rock-paper-scissors', opponentChosen: true });
  const finished = { ...game, version: 2, status: 'completed', yourChoice: 'rock', choices: { sender: 'rock', recipient: 'paper' }, result: 'win', winnerAccountId: 'BOT' };
  const ui = harness(local, [game], call => call.method === 'POST' ? { game: finished, user: { ...local, balance: 90 } } : undefined);
  await tick(); ui.api.act('open', game.id);
  assert.equal(ui.elements.get('gamesReveal').children[1].textContent, 'Bot: Ready');
  await ui.api.perform({ id: game.id, action: 'move', payload: { choice: 'rock', clientMoveId: crypto.randomUUID() } });
  assert.equal(ui.elements.get('gamesReveal').children[0].textContent, 'You: Rock');
  assert.equal(ui.elements.get('gamesReveal').children[1].textContent, 'Bot: Paper');
  assert.equal(ui.elements.get('gamesTurn').textContent, 'Bot won the pot');
  assert.ok(ui.elements.get('gamesChoices').children.every(choice => choice.disabled));
});

test('an old bot response cannot reopen the match or change the next account', async () => {
  const local = player('local'), next = player('next'), response = deferred();
  const ui = harness(local, [], call => call.method === 'POST' ? response.promise : undefined);
  await tick(); choose(ui, 'tic-tac-toe');
  const pending = ui.api.requestGame({ preventDefault() {} }); ui.setUser(next);
  response.resolve({ game: match(local), user: { ...local, balance: 90 } }); await pending; await tick();
  assert.equal(ui.context.state.user.accountId, next.accountId);
  assert.equal(ui.context.state.user.balance, 100);
  assert.equal(ui.api.inspect().selectedId, null);
  assert.equal(ui.api.inspect().entries.length, 0);
  assert.equal(ui.elements.get('gamesOpponentType').value, 'player');
});
