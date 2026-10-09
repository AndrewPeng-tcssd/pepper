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
function harness(user, entries = [], network, options = {}) {
  const elements = new Map(), calls = [], navigation = [], playerPickers = [], timers = [];
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
      closest(selector) { return selector === '[data-game-action]' && this.dataset.gameAction || selector === '[data-game-remove-player]' && this.dataset.gameRemovePlayer ? this : null; },
      focus() { document.activeElement = this; },
      querySelector() { return radios.find(radio => radio.checked); },
      querySelectorAll(selector) { return selector === 'input' || selector === 'input, select' ? [...radios, elements.get('gamesUsername'), elements.get('gamesStake'), elements.get('gamesPlayerCount'), elements.get('gamesPayoutMode')] : []; },
      reset() { elements.get('gamesUsername').value = ''; elements.get('gamesStake').value = '1'; elements.get('gamesPlayerCount').value = '2'; elements.get('gamesPayoutMode').value = 'shared'; radios.forEach((radio, index) => { radio.checked = index === 0; }); },
      click() { this.dispatch('click'); }
    };
  };
  for (const match of html.matchAll(/<[a-z][a-z0-9]*\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(match[2], node(match[2], match[1]));
  const radios = [{ value: 'tic-tac-toe', checked: true }, { value: 'rock-paper-scissors', checked: false }, { value: 'dice', checked: false }];
  const document = { getElementById: id => elements.get(id), createElement: () => node(), body: node(), activeElement: null, contains: () => true, querySelectorAll: () => [] };
  const boundary = {
    document, window: { matchMedia: () => ({ matches: !!options.reducedMotion }), PepperPlayerPicker: {
      attach(settings) { const picker = { closed: 0, close() { this.closed++; }, reset() { this.closed++; } }; playerPickers.push({ settings, picker }); return picker; }
    } }, crypto, console, setInterval() {}, setTimeout(callback, delay) { if (options.manualTimers) timers.push({ callback, delay }); else callback(); }, state: { user: null, accountSubmitting: false }, authRevision: 0, userIdentityRevision: 0, routeRevision: 0, pageKind: 'games', accountBanned: false,
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
  vm.runInContext(source.replace('window.PepperGames = { syncUser, load, onRoute, renderNotification };', 'window.PepperGames = { syncUser, load, onRoute, renderNotification, inspect: () => games, perform, requestGame, addPlayer, act, render };'), context);
  boundary.setUser(user);
  return { api: context.window.PepperGames, elements, calls, navigation, context, setUser: boundary.setUser, entries, radios, playerPickers, timers };
}

test('game suggestions choose a player without sending an invitation or changing the bet', async () => {
  const other = player('example');
  const ui = harness(player('local'), [], call => call.route.startsWith('players?') ? { players: [other] } : undefined);
  await tick();
  const { settings } = ui.playerPickers[0];
  assert.equal(settings.input, ui.elements.get('gamesUsername')); assert.equal(settings.isEnabled(), true);
  assert.equal((await settings.search('ex'))[0].accountId, other.accountId);
  assert.equal(ui.calls.at(-1).route, 'players?username=ex');
  settings.input.value = other.username; settings.onSelect(other);
  assert.equal(settings.input.value, 'example'); assert.equal(ui.elements.get('gamesStake').value, '1');
  assert.equal(ui.calls.filter(call => call.method !== 'GET').length, 0);
});

test('game suggestion responses cannot survive account or route changes', async () => {
  const response = deferred();
  const ui = harness(player('local'), [], call => call.route.startsWith('players?') ? response.promise : undefined);
  await tick();
  const { settings, picker } = ui.playerPickers[0];
  const pending = settings.search('ex');
  ui.context.routeRevision++; ui.context.pageKind = 'trading';
  response.resolve({ players: [player('example')] });
  assert.equal((await pending).length, 0); assert.equal(settings.isEnabled(), false);
  ui.context.pageKind = 'games'; ui.context.state.accountSubmitting = true; ui.api.render();
  assert.equal(settings.isEnabled(), false); assert.ok(picker.closed > 0);
  ui.context.state.accountSubmitting = false; ui.setUser(null);
  assert.equal(settings.isEnabled(), false);
});

test('bets default to one token and invalid amounts never look up a player or send requests', async () => {
  const ui = harness(player('local')); await tick();
  assert.equal(ui.elements.get('gamesStake').value, '1');
  assert.match(html, /id="gamesStake"[^>]*min="1"[^>]*step="1"[^>]*value="1"/);
  ui.elements.get('gamesUsername').value = 'other';
  for (const radio of ui.radios) {
    ui.radios.forEach(entry => { entry.checked = entry === radio; });
    for (const stake of ['0', '-0', '-1', '-10', '', '0.5', 'NaN', '2251799813685248']) {
      ui.elements.get('gamesStake').value = stake;
      await ui.api.requestGame({ preventDefault() {} });
      assert.equal(ui.elements.get('gamesMessage').textContent, 'Bet at least 1 token.');
    }
  }
  assert.ok(ui.calls.every(call => call.route === 'games' && call.method === 'GET'));
});

test('legacy invalid invitations disable acceptance in the popup and session while permitting decline', async () => {
  const local = player('local'), other = player('other');
  for (const stake of [0, -1]) {
    const invitation = game(other, local, { stake });
    const ui = harness(local, [invitation]); await tick();
    assert.equal(ui.elements.get('gameNotificationAccept').disabled, true);
    assert.equal(ui.elements.get('gameNotificationAccept').textContent, 'Invalid bet');
    assert.equal(ui.elements.get('gameNotificationDecline').disabled, false);
    assert.match(ui.elements.get('gameNotificationTerms').textContent, /Invalid bet/);
    ui.api.act('open', invitation.id);
    const actions = ui.elements.get('gamesSessionActions').children;
    assert.equal(actions.find(button => button.dataset.gameAction === 'accept').disabled, true);
    assert.equal(actions.find(button => button.dataset.gameAction === 'decline').disabled, false);
    assert.equal(ui.elements.get('gamesStakeSummary').textContent, 'Invalid bet');
    ui.api.act('accept', invitation.id); await tick();
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('either game can send a one-token request and resets to the same positive default', async () => {
  const local = player('local'), other = player('other');
  for (const gameType of ['tic-tac-toe', 'rock-paper-scissors']) {
    const ui = harness(local, [], call => {
      if (call.route.startsWith('profiles/')) return { profile: other };
      if (call.method === 'POST') return { game: game(local, other, { ...call.payload }), user: local };
    });
    await tick();
    ui.elements.get('gamesUsername').value = 'other';
    ui.radios.forEach(radio => { radio.checked = radio.value === gameType; });
    await ui.api.requestGame({ preventDefault() {} }); await tick();
    const post = ui.calls.find(call => call.method === 'POST');
    assert.equal(post.payload.stake, 1); assert.equal(post.payload.game, gameType);
    assert.equal(ui.elements.get('gamesStake').value, '1');
  }
});

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

test('pending tic tac toe requests leave symbols unassigned until acceptance', async () => {
  const sender = player('sender'), recipient = player('recipient');
  const invitation = game(sender, recipient, { turnAccountId: null, xAccountId: null });
  for (const viewer of [sender, recipient]) {
    const ui = harness(viewer, [invitation]); await tick(); ui.api.act('open', invitation.id);
    assert.ok(ui.elements.get('gamesPlayers').children.every(side => !side.children.some(child => child.className === 'games-player-symbol')));
    assert.equal(ui.elements.get('gamesTurn').textContent, 'Awaiting acceptance');
    assert.equal(ui.elements.get('gamesBoard').hidden, true);
  }
});

test('recipient-first tic tac toe shows the chosen X and enables only the current player', async () => {
  const sender = player('sender'), recipient = player('recipient');
  const match = game(sender, recipient, { status: 'playing', version: 2, xAccountId: recipient.accountId, turnAccountId: recipient.accountId });
  const symbols = ui => ui.elements.get('gamesPlayers').children.map(side => side.children.find(child => child.className === 'games-player-symbol').textContent);
  const senderUi = harness(sender, [match]), recipientUi = harness(recipient, [match]);
  await tick();
  for (const ui of [senderUi, recipientUi]) ui.api.act('open', match.id);
  assert.deepEqual(symbols(senderUi), ['O', 'X']); assert.deepEqual(symbols(recipientUi), ['X', 'O']);
  assert.equal(senderUi.elements.get('gamesTurn').textContent, 'Opponent’s turn');
  assert.ok(senderUi.elements.get('gamesBoard').children.every(square => square.disabled));
  assert.equal(recipientUi.elements.get('gamesTurn').textContent, 'Your turn');
  assert.ok(recipientUi.elements.get('gamesBoard').children.every(square => !square.disabled));
  for (const ui of [senderUi, recipientUi]) {
    ui.entries[0] = { ...match, version: 3, turnAccountId: sender.accountId, board: ['X', ...Array(8).fill(null)] };
    await ui.api.load();
  }
  assert.deepEqual(symbols(senderUi), ['O', 'X']);
  assert.equal(senderUi.elements.get('gamesBoard').children[0].textContent, 'X');
  assert.equal(senderUi.elements.get('gamesBoard').children[0].disabled, true);
  assert.ok(senderUi.elements.get('gamesBoard').children.slice(1).every(square => !square.disabled));
  assert.ok(recipientUi.elements.get('gamesBoard').children.every(square => square.disabled));
});

test('legacy active tic tac toe responses retain sender X without an assigned symbol field', async () => {
  const sender = player('sender'), recipient = player('recipient');
  const match = game(sender, recipient, { status: 'playing', version: 3, turnAccountId: recipient.accountId, board: ['X', ...Array(8).fill(null)] });
  const ui = harness(recipient, [match]); await tick(); ui.api.act('open', match.id);
  const symbols = ui.elements.get('gamesPlayers').children.map(side => side.children.find(child => child.className === 'games-player-symbol').textContent);
  assert.deepEqual(symbols, ['O', 'X']);
  assert.equal(ui.elements.get('gamesTurn').textContent, 'Your turn');
  assert.equal(ui.elements.get('gamesBoard').children[0].disabled, true);
  assert.ok(ui.elements.get('gamesBoard').children.slice(1).every(square => !square.disabled));
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

function selectDice(ui, count = 2, mode = 'shared') {
  ui.radios.forEach(radio => { radio.checked = radio.value === 'dice'; });
  ui.elements.get('gamesPlayerCount').value = String(count);
  ui.elements.get('gamesPayoutMode').value = mode;
  ui.elements.get('gamesRequestForm').dispatch('change');
}
function diceGame(players, extra = {}) {
  return game(players[0], players[1], {
    game: 'dice', players: players.map((player, index) => ({ ...player, accepted: index === 0 })),
    payoutMode: players.length === 2 ? 'single-winner' : 'shared', pot: players.length * 10,
    dice: { round: 1, groups: [players.map(player => player.accountId)], rolls: {}, history: [] },
    eligibleAccountIds: [], placements: [], payouts: {}, ...extra
  });
}
async function addSelected(ui, player) {
  ui.elements.get('gamesUsername').value = player.username;
  ui.playerPickers[0].settings.onSelect(player);
  ui.elements.get('gamesRequestForm').dispatch('change', ui.elements.get('gamesUsername'));
  await ui.api.addPlayer();
}

test('Dice shows its roster and player options without changing other game forms', async () => {
  const ui = harness(player('local')); await tick();
  assert.equal(ui.elements.get('gamesDiceOptions').hidden, true);
  assert.equal(ui.elements.get('gamesUsername').required, true);
  selectDice(ui);
  assert.equal(ui.elements.get('gamesDiceOptions').hidden, false);
  assert.equal(ui.elements.get('gamesAddPlayer').hidden, false);
  assert.equal(ui.elements.get('gamesUsername').required, false);
  assert.equal(ui.elements.get('gamesPayoutModeField').hidden, true);
  selectDice(ui, 4);
  assert.equal(ui.elements.get('gamesPayoutModeField').hidden, false);
});

test('Dice invitations keep selected account IDs and request exactly the chosen roster', async () => {
  const local = player('local'), first = player('first'), second = player('second'), third = player('third');
  const ui = harness(local, [], call => call.method === 'POST' ? { game: diceGame([local, first, second, third], { ...call.payload }), user: local } : undefined);
  await tick(); selectDice(ui, 4, 'single-winner');
  await addSelected(ui, first); await addSelected(ui, second); await addSelected(ui, third);
  assert.equal(ui.calls.filter(call => call.route.startsWith('profiles/')).length, 0);
  assert.equal(ui.elements.get('gamesInvitees').children.length, 3);
  assert.equal(ui.elements.get('gamesAddPlayer').disabled, true);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
  ui.elements.get('gamesStake').value = '7';
  await ui.api.requestGame({ preventDefault() {} }); await tick();
  const post = ui.calls.find(call => call.method === 'POST');
  assert.deepEqual(post.payload.recipientAccountIds, [first.accountId, second.accountId, third.accountId]);
  assert.equal(post.payload.game, 'dice'); assert.equal(post.payload.payoutMode, 'single-winner'); assert.equal(post.payload.stake, 7);
  assert.equal(ui.api.inspect().invitees.length, 0); assert.equal(ui.elements.get('gamesStake').value, '1');
});

test('Dice roster rejects self, duplicates, and missing players; removing allows a replacement', async () => {
  const local = player('local'), other = player('other');
  const ui = harness(local); await tick(); selectDice(ui, 3);
  await addSelected(ui, local);
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Choose another player.');
  await addSelected(ui, other); await addSelected(ui, other);
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Player already added.');
  assert.equal(ui.api.inspect().invitees.length, 1);
  await ui.api.requestGame({ preventDefault() {} });
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Add 1 more player.');
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
  const remove = ui.elements.get('gamesInvitees').children[0].children[1];
  ui.elements.get('gamesPage').dispatch('click', remove);
  assert.equal(ui.api.inspect().invitees.length, 0);
  await addSelected(ui, other); assert.equal(ui.api.inspect().invitees.length, 1);
});

test('Dice manual player lookup cannot populate another route or account', async () => {
  for (const change of ['route', 'account']) {
    const lookup = deferred(), local = player('local'), other = player('other');
    const ui = harness(local, [], call => call.route.startsWith('profiles/') ? lookup.promise : undefined);
    await tick(); selectDice(ui, 3); ui.elements.get('gamesUsername').value = 'other';
    const pending = ui.api.addPlayer();
    assert.equal(ui.elements.get('gamesSend').disabled, true);
    assert.equal(ui.elements.get('gamesPlayerCount').disabled, true);
    if (change === 'route') { ui.context.routeRevision++; ui.context.pageKind = 'trading'; }
    else ui.setUser(player('next'));
    lookup.resolve({ profile: other }); await pending; await tick();
    assert.equal(ui.api.inspect().invitees.length, 0);
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('Dice suggestions omit self and roster members and two-player requests force single-winner', async () => {
  const local = player('local'), other = player('other'), available = player('available');
  const ui = harness(local, [], call => {
    if (call.route.startsWith('players?')) return { players: [local, other, available] };
    if (call.method === 'POST') return { game: diceGame([local, other], { ...call.payload }), user: local };
  });
  await tick(); selectDice(ui); await addSelected(ui, other);
  assert.deepEqual(Array.from(await ui.playerPickers[0].settings.search('')), [available]);
  await ui.api.requestGame({ preventDefault() {} }); await tick();
  assert.equal(ui.calls.find(call => call.method === 'POST').payload.payoutMode, 'single-winner');
});

test('Third and fourth Dice invitees receive popups and accepted players wait for everyone', async () => {
  const people = [player('host'), player('second'), player('third'), player('fourth')], match = diceGame(people);
  for (const viewer of people.slice(1)) {
    const ui = harness(viewer, [match]); await tick();
    assert.equal(ui.elements.get('gameNotification').hidden, false);
    ui.api.act('open', match.id);
    assert.equal(ui.elements.get('gamesPlayers').children.length, 4);
    assert.equal(ui.elements.get('gamesPot').textContent, '40 token pot · Shared');
    assert.match(ui.elements.get('gameNotificationTerms').textContent, /4 players · Shared/);
    assert.ok(ui.elements.get('gamesSessionActions').children.some(button => button.dataset.gameAction === 'accept'));
    ui.entries[0] = { ...match, version: 2, players: match.players.map(player => ({ ...player, accepted: player.accepted || player.accountId === viewer.accountId })) };
    await ui.api.load();
    assert.equal(ui.elements.get('gameNotification').hidden, true);
    assert.equal(ui.elements.get('gamesSessionActions').children[0].textContent, 'Waiting for players');
    assert.ok(ui.elements.get('gamesSessionActions').children.every(button => !button.dataset.gameAction));
  }
  const hostUi = harness(people[0], [match]); await tick(); hostUi.api.act('open', match.id);
  assert.equal(hostUi.elements.get('gamesSessionActions').children[0].dataset.gameAction, 'cancel');
});

test('Dice rolls have no first player and send the visible round only once', async () => {
  const people = [player('host'), player('second'), player('third')];
  const match = diceGame(people, { status: 'playing', version: 2, eligibleAccountIds: people.map(player => player.accountId) });
  for (const viewer of people) {
    const rolled = { ...match, version: 3, dice: { ...match.dice, rolls: { [viewer.accountId]: 6 } }, eligibleAccountIds: people.filter(player => player !== viewer).map(player => player.accountId) };
    const ui = harness(viewer, [match], call => call.method === 'POST' ? { game: rolled, user: viewer } : undefined);
    await tick(); ui.api.act('open', match.id);
    assert.equal(ui.elements.get('gamesRollAction').children[0].disabled, false);
    assert.equal(ui.elements.get('gamesTurn').textContent, 'Roll your dice');
    assert.equal(ui.elements.get('gamesPlayers').hidden, true);
    assert.equal(ui.elements.get('gamesSessionActions').children.length, 0);
    const roll = ui.elements.get('gamesRollAction').children[0];
    ui.elements.get('gamesPage').dispatch('click', roll); await tick(); await tick();
    const post = ui.calls.find(call => call.method === 'POST');
    assert.equal(post.route, `games/${match.id}/move`); assert.equal(post.payload.round, 1);
    assert.ok(post.payload.clientMoveId); assert.equal(post.payload.choice, undefined);
    assert.equal(ui.elements.get('gamesRollAction').children[0].disabled, true);
    ui.api.act('move', match.id, { round: 1, clientMoveId: crypto.randomUUID() });
    ui.api.act('resign', match.id);
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('Dice faces and earlier rounds show dot cells with accessible roll values', async () => {
  const people = [player('local'), player('other')];
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  for (let value = 1; value <= 6; value++) {
    const match = diceGame(people, { status: 'playing', version: 3,
      dice: { round: 2, groups: [people.map(player => player.accountId)], rolls: { [people[0].accountId]: value }, history: [{ round: 1, rolls: { [people[0].accountId]: value, [people[1].accountId]: value } }] },
      eligibleAccountIds: [people[1].accountId]
    });
    const ui = harness(people[0], [match]); await tick(); ui.api.act('open', match.id);
    const face = ui.elements.get('gamesRolls').children[0].children[1];
    assert.equal(face.role, 'img'); assert.equal(face.dataset.value, String(value));
    assert.equal(face['aria-label'], `Your roll: ${value}`); assert.equal(face.textContent, '');
    assert.deepEqual(face.children.map(pip => pip.dataset.position), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    assert.ok(face.children.every(pip => pip['aria-hidden'] === 'true' && !pip.textContent));
    const historicalFaces = descendants(ui.elements.get('gamesDiceHistory')).filter(node => node.className?.split(' ').includes('games-die'));
    assert.equal(historicalFaces.length, 2);
    assert.ok(historicalFaces.every(face => face.dataset.value === String(value) && face.children.length === 9 && !face.textContent));
  }
});

test('A dice roll sends immediately and animates only locally until both animation and response finish', async () => {
  for (const responseFirst of [false, true]) {
    const people = [player('local'), player('other')], response = deferred();
    const match = diceGame(people, { status: 'playing', version: 2, eligibleAccountIds: people.map(player => player.accountId) });
    const rolled = { ...match, version: 3, dice: { ...match.dice, rolls: { [people[0].accountId]: 6 } }, eligibleAccountIds: [people[1].accountId] };
    const ui = harness(people[0], [match], call => call.method === 'POST' ? response.promise : undefined, { manualTimers: true });
    await tick(); ui.api.act('open', match.id);
    let finished = false;
    const pending = ui.api.perform({ id: match.id, action: 'move', payload: { round: 1, clientMoveId: crypto.randomUUID() } }).then(() => { finished = true; });
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(ui.timers.length, 1); assert.equal(ui.timers[0].delay, 700);
    const localFace = () => ui.elements.get('gamesRolls').children[0].children[1];
    assert.equal(localFace().classList.contains('is-rolling'), true);
    assert.equal(localFace().dataset.value, '6'); assert.equal(localFace()['aria-label'], 'Your roll: rolling');
    assert.equal(ui.elements.get('gamesRolls').children[1].children[1].classList.contains('is-rolling'), false);
    assert.equal(ui.elements.get('gamesRollAction').children[0].textContent, 'Rolling…');
    assert.equal(ui.elements.get('gamesRollAction').children[0].disabled, true);
    assert.equal(ui.elements.get('gamesTurn').textContent, 'Rolling…');
    ui.api.act('move', match.id, { round: 1, clientMoveId: crypto.randomUUID() });
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
    if (responseFirst) response.resolve({ game: rolled, user: people[0] });
    else ui.timers[0].callback();
    await tick(); assert.equal(finished, false); assert.equal(localFace().classList.contains('is-rolling'), true);
    if (responseFirst) ui.timers[0].callback();
    else response.resolve({ game: rolled, user: people[0] });
    await pending; await tick();
    assert.equal(localFace().classList.contains('is-rolling'), false);
    assert.equal(localFace().dataset.value, '6'); assert.equal(localFace()['aria-label'], 'Your roll: 6');
  }
});

test('A rejected dice roll stops its animation and leaves the original round playable', async () => {
  const people = [player('local'), player('other')], response = deferred();
  const match = diceGame(people, { status: 'playing', version: 2, eligibleAccountIds: people.map(player => player.accountId) });
  const ui = harness(people[0], [match], call => call.method === 'POST' ? response.promise : undefined, { manualTimers: true });
  await tick(); ui.api.act('open', match.id);
  const pending = ui.api.perform({ id: match.id, action: 'move', payload: { round: 1, clientMoveId: crypto.randomUUID() } });
  response.resolve(Promise.reject(Object.assign(new Error('Roll rejected.'), { status: 409 })));
  await pending; await tick();
  assert.equal(ui.elements.get('gamesRolls').children[0].children[1].classList.contains('is-rolling'), false);
  assert.equal(ui.elements.get('gamesRolls').children[0].children[1].dataset.value, '');
  assert.equal(ui.elements.get('gamesRollAction').children[0].disabled, false);
  assert.equal(ui.api.inspect().retry, null);
});

test('Reduced motion reveals dice results without waiting for an animation timer', async () => {
  const people = [player('local'), player('other')];
  const match = diceGame(people, { status: 'playing', version: 2, eligibleAccountIds: people.map(player => player.accountId) });
  const rolled = { ...match, version: 3, dice: { ...match.dice, rolls: { [people[0].accountId]: 4 } }, eligibleAccountIds: [people[1].accountId] };
  const ui = harness(people[0], [match], call => call.method === 'POST' ? { game: rolled, user: people[0] } : undefined, { manualTimers: true, reducedMotion: true });
  await tick(); ui.api.act('open', match.id);
  await ui.api.perform({ id: match.id, action: 'move', payload: { round: 1, clientMoveId: crypto.randomUUID() } }); await tick();
  assert.equal(ui.timers.length, 0);
  assert.equal(ui.elements.get('gamesRolls').children[0].children[1].dataset.value, '4');
  assert.equal(ui.elements.get('gamesRolls').children[0].children[1].classList.contains('is-rolling'), false);
});

test('Dice rerolls show fixed places and only the remaining tied players can roll', async () => {
  const people = [player('host'), player('second'), player('third')];
  const match = diceGame(people, { status: 'playing', version: 3,
    dice: { round: 2, groups: [[people[0].accountId, people[1].accountId], [people[2].accountId]], rolls: {}, history: [{ round: 1, groups: [people.map(player => player.accountId)], rolls: { [people[0].accountId]: 6, [people[1].accountId]: 6, [people[2].accountId]: 1 } }] },
    eligibleAccountIds: [people[0].accountId, people[1].accountId]
  });
  const tiedUi = harness(people[0], [match]), placedUi = harness(people[2], [match]); await tick();
  for (const ui of [tiedUi, placedUi]) { ui.api.act('open', match.id); assert.equal(ui.elements.get('gamesDiceRound').textContent, 'Roll again · Round 2'); assert.equal(ui.elements.get('gamesDiceHistory').children.length, 1); }
  assert.equal(tiedUi.elements.get('gamesRollAction').children[0].disabled, false);
  assert.equal(placedUi.elements.get('gamesRollAction').children[0].disabled, true);
  assert.equal(tiedUi.elements.get('gamesRolls').children[0].children[1].dataset.value, '');
  assert.equal(placedUi.elements.get('gamesRolls').children[0].children[1].dataset.value, '1');
  assert.equal(placedUi.elements.get('gamesRolls').children[0].children[2].textContent, 'Place 3');
  tiedUi.api.act('move', match.id, { round: 1, clientMoveId: crypto.randomUUID() });
  assert.equal(tiedUi.calls.filter(call => call.method === 'POST').length, 0);
});

test('Dice result displays each whole-token payout and retains hidden roll placeholders', async () => {
  const people = [player('host'), player('second'), player('third'), player('fourth')];
  const match = diceGame(people, { stake: 1, pot: 4, status: 'completed', version: 6, result: 'ranked', winnerAccountId: people[0].accountId,
    dice: { round: 2, groups: people.map(player => [player.accountId]), rolls: { [people[0].accountId]: 6, [people[1].accountId]: 5, [people[2].accountId]: 3, [people[3].accountId]: 1 }, history: [] },
    placements: people.map((player, index) => ({ accountId: player.accountId, place: index + 1, payout: index < 2 ? 1 : 0 })), payouts: { [people[0].accountId]: 1, [people[1].accountId]: 1, [people[2].accountId]: 0, [people[3].accountId]: 0 }
  });
  const ui = harness(people[1], [match]); await tick(); ui.api.act('open', match.id);
  assert.equal(ui.elements.get('gamesSessionStatus').textContent, '2nd place');
  assert.equal(ui.elements.get('gamesDiceRound').textContent, 'Round 2');
  assert.deepEqual(ui.elements.get('gamesRolls').children.map(row => row.children[2].textContent), ['Place 2', 'Place 1', 'Place 3', 'Place 4']);
  assert.equal(ui.elements.get('gamesTurn').textContent, '1 tokens received');
  assert.equal(ui.elements.get('gamesPlacements').children.length, 4);
  assert.deepEqual(ui.elements.get('gamesPlacements').children.map(row => row.children[2].textContent), ['1 tokens', '1 tokens', '0 tokens', '0 tokens']);
  assert.equal(ui.elements.get('gamesRollAction').children.length, 0);
});

test('Single-winner Dice only claims a winning place after unresolved losing ties', async () => {
  const people = [player('host'), player('second'), player('third')];
  const match = diceGame(people, { payoutMode: 'single-winner', status: 'completed', version: 6, result: 'win', winnerAccountId: people[0].accountId,
    placements: people.map((player, index) => ({ accountId: player.accountId, place: index + 1, payout: index === 0 ? 30 : 0 }))
  });
  const ui = harness(people[1], [match]); await tick(); ui.api.act('open', match.id);
  assert.deepEqual(ui.elements.get('gamesPlacements').children.map(row => row.children[0].textContent), ['Winner', 'Player', 'Player']);
  assert.equal(ui.elements.get('gamesSessionStatus').textContent, 'You lost');
});

test('Dice draws show every refund and eliminated single-winner players retain their roll', async () => {
  const people = [player('host'), player('second'), player('third')];
  const match = diceGame(people, { status: 'playing', version: 3, payoutMode: 'single-winner',
    dice: { round: 2, groups: [[people[0].accountId, people[1].accountId], [people[2].accountId]], rolls: {}, history: [{ round: 1, rolls: { [people[0].accountId]: 6, [people[1].accountId]: 6, [people[2].accountId]: 1 } }] },
    eligibleAccountIds: [people[0].accountId, people[1].accountId]
  });
  const ui = harness(people[2], [match]); await tick(); ui.api.act('open', match.id);
  assert.equal(ui.elements.get('gamesRolls').children[0].children[1].dataset.value, '1');
  assert.equal(ui.elements.get('gamesRolls').children[0].children[2].textContent, 'Eliminated');
  ui.entries[0] = { ...match, version: 4, status: 'completed', result: 'draw', placements: [], payouts: Object.fromEntries(people.map(player => [player.accountId, 10])) };
  await ui.api.load();
  assert.equal(ui.elements.get('gamesTurn').textContent, 'Draw · stakes returned');
  assert.deepEqual(ui.elements.get('gamesPlacements').children.map(row => [row.children[0].textContent, row.children[2].textContent]), [['Draw', '10 tokens'], ['Draw', '10 tokens'], ['Draw', '10 tokens']]);
});

test('An uncertain Dice request retains exact account IDs and mode across retry', async () => {
  const local = player('local'), second = player('second'), third = player('third'); let attempts = 0;
  const ui = harness(local, [], call => {
    if (call.method !== 'POST') return;
    if (++attempts === 1) throw new Error('Response lost');
    return { game: diceGame([local, second, third], { ...call.payload }), user: local };
  });
  await tick(); selectDice(ui, 3, 'shared'); await addSelected(ui, second); await addSelected(ui, third);
  await ui.api.requestGame({ preventDefault() {} }); await tick();
  const operation = ui.api.inspect().retry;
  assert.equal(ui.elements.get('gamesPayoutMode').disabled, true);
  assert.equal(ui.api.inspect().invitees.length, 2);
  await ui.api.perform(operation); await tick();
  const posts = ui.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2); assert.deepEqual(posts[0].payload, posts[1].payload);
  assert.deepEqual(posts[1].payload.recipientAccountIds, [second.accountId, third.accountId]);
});
