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
const diceMatch = (sender, count = 2, extra = {}) => {
  const bots = Array.from({ length: count - 1 }, (_, index) => ({ ...bot, accountId: count === 2 ? 'BOT' : `BOT-${index + 1}`, username: count === 2 ? 'Bot' : `Bot #${index + 1}`, accepted: true }));
  const players = [{ ...sender, accepted: true }, ...bots];
  return match(sender, { game: 'dice', players, recipient: bots[0], pot: count * 10, payoutMode: count === 2 ? 'single-winner' : 'shared',
    dice: { round: 1, rolls: Object.fromEntries(bots.map((entry, index) => [entry.accountId, index + 1])), groups: [players.map(entry => entry.accountId)], history: [] },
    eligibleAccountIds: [sender.accountId], ...extra });
};
const mixedDiceMatch = (sender, invited, count, extra = {}) => {
  const bots = Array.from({ length: count - 1 - invited.length }, (_, index) => ({ ...bot, accountId: `BOT-${index + 1}`, username: `Bot #${index + 1}`, accepted: true }));
  const players = [{ ...sender, accepted: true }, ...invited.map(entry => ({ ...entry, accepted: false })), ...bots];
  return diceMatch(sender, count, { opponentType: 'mixed', status: 'pending', recipient: players[1], players, eligibleAccountIds: [], dice: { round: 1, rolls: {}, groups: [players.map(entry => entry.accountId)], history: [] }, ...extra });
};
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Run production UI against small DOM and network boundaries, including all draft controls.
function harness(user, entries = [], network, fixture = { botsEnabled: true }) {
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
      closest(selector) { return selector === '[data-game-action]' && this.dataset.gameAction || selector === '[data-game-remove-player]' && this.dataset.gameRemovePlayer ? this : null; },
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
    crypto, console, setInterval() {}, setTimeout(callback) { callback(); }, clearTimeout() {}, state: { user: null, accountSubmitting: false }, authRevision: 0, userIdentityRevision: 0, routeRevision: 0, pageKind: 'games', accountBanned: false,
    profileHref(username) { profileNames.push(username); return `/profile/${username}`; }, profileAvatar: () => node(), playerRoleBadges: () => node(), setChatOpen() {}, focusRouteHeading() {},
    navigateTo() { context.pageKind = 'games'; context.routeRevision++; }, message(target, text) { target.textContent = text; },
    setUser(value) { if (context.state.user?.accountId !== value?.accountId) context.userIdentityRevision++; context.authRevision++; context.state.user = value; context.window.PepperGames.syncUser(); },
    api: async (route, options = {}) => {
      const call = { route, method: options.method || 'GET', payload: options.body ? JSON.parse(options.body) : null }; calls.push(call);
      const result = network ? await network(call) : undefined;
      if (result !== undefined) return result;
      if (route === 'games' && call.method === 'GET') return { games: entries, user: context.state.user, ...(fixture.botsEnabled === undefined ? {} : { botsEnabled: fixture.botsEnabled }) };
      throw new Error(`Unexpected API call ${call.method} ${route}`);
    }
  };
  context = vm.createContext(boundary);
  vm.runInContext(source.replace('window.PepperGames = { syncUser, load, onRoute, renderNotification };', 'window.PepperGames = { syncUser, load, onRoute, renderNotification, inspect: () => games, perform, requestGame, addPlayer, act, render };'), context);
  boundary.setUser(user);
  return { api: context.window.PepperGames, elements, calls, context, setUser: boundary.setUser, entries, radios, pickers, profileNames };
}
function choose(ui, type, opponent = 'bot') {
  ui.radios.forEach(radio => { radio.checked = radio.value === type; });
  ui.elements.get('gamesOpponentType').value = opponent;
  ui.elements.get('gamesRequestForm').dispatch('change', ui.elements.get('gamesOpponentType'));
}
function changeCount(ui, count) {
  ui.elements.get('gamesPlayerCount').value = String(count);
  ui.elements.get('gamesRequestForm').dispatch('change', ui.elements.get('gamesPlayerCount'));
}
const fill = ui => ui.elements.get('gamesFillBots').click();
const draft = ui => Array.from(ui.api.inspect().invitees);
const draftIds = ui => draft(ui).map(entry => entry.accountId);
function removeDraft(ui, accountId) {
  const row = ui.elements.get('gamesInvitees').children.find(entry => entry.children[1].dataset.gameRemovePlayer === accountId);
  assert.ok(row, `Missing roster seat ${accountId}`);
  ui.elements.get('gamesPage').dispatch('click', row.children[1]);
}
async function addInvited(ui, entry) {
  ui.elements.get('gamesUsername').value = entry.username;
  await ui.api.addPlayer();
}

test('missing, false, and non-boolean bot capability keep all new bot controls off', async () => {
  for (const botsEnabled of [undefined, false, null, 'true', 1]) {
    const ui = harness(player('local'), [], undefined, { botsEnabled }); await tick();
    assert.equal(ui.api.inspect().botsEnabled, false);
    choose(ui, 'rock-paper-scissors', 'bot');
    assert.equal(ui.elements.get('gamesOpponentOptions').hidden, true);
    assert.equal(ui.elements.get('gamesOpponentType').disabled, true);
    assert.equal(ui.elements.get('gamesOpponentType').value, 'player');
    assert.equal(ui.elements.get('gamesBotOption').hidden, true);
    assert.equal(ui.elements.get('gamesBotOption').disabled, true);
    assert.equal(ui.elements.get('gamesUsername').required, true);
    assert.equal(ui.elements.get('gamesUsernameField').hidden, false);
    assert.equal(ui.pickers[0].settings.isEnabled(), true);
    assert.equal(ui.elements.get('gamesSend').textContent, 'Send request');
    choose(ui, 'dice'); changeCount(ui, 4);
    assert.equal(ui.elements.get('gamesFillBots').hidden, true);
    assert.equal(ui.elements.get('gamesFillBots').disabled, true);
    fill(ui); assert.deepEqual(draftIds(ui), []);
    await ui.api.requestGame({ preventDefault() {} });
    assert.equal(ui.elements.get('gamesMessage').textContent, 'Add 3 more players.');
    assert.ok(ui.calls.every(call => call.method === 'GET'));
  }
});

test('initial loading and failed loading stay off until an enabled response arrives', async () => {
  const local = player('local'), response = deferred();
  const ui = harness(local, [], call => call.method === 'GET' ? response.promise : undefined);
  choose(ui, 'rock-paper-scissors', 'bot');
  assert.equal(ui.api.inspect().botsEnabled, false);
  assert.equal(ui.elements.get('gamesOpponentOptions').hidden, true);
  choose(ui, 'dice'); fill(ui); assert.deepEqual(draftIds(ui), []);
  response.resolve({ games: [], user: local, botsEnabled: true }); await tick();
  assert.equal(ui.api.inspect().botsEnabled, true);
  assert.equal(ui.elements.get('gamesFillBots').hidden, false);
  assert.equal(ui.elements.get('gamesFillBots').disabled, false);
  choose(ui, 'rock-paper-scissors', 'bot');
  assert.equal(ui.elements.get('gamesOpponentOptions').hidden, false);
  assert.equal(ui.elements.get('gamesBotOption').disabled, false);
  assert.equal(ui.elements.get('gamesSend').textContent, 'Start match');
  const failed = harness(local, [], call => { if (call.method === 'GET') throw new Error('Offline'); });
  await tick(); choose(failed, 'dice');
  assert.equal(failed.api.inspect().botsEnabled, false);
  assert.equal(failed.elements.get('gamesFillBots').hidden, true);
  assert.equal(failed.elements.get('gamesFillBots').disabled, true);
});

test('turning bots off or losing a refresh removes draft bots while preserving humans', async () => {
  for (const failed of [false, true]) {
    const local = player('local'), guest = player('guest'); let enabled = true, failRefresh = false;
    const ui = harness(local, [], call => {
      if (call.route === 'profiles/guest') return { profile: guest };
      if (call.method === 'GET') {
        if (failRefresh) throw new Error('Offline');
        return { games: [], user: local, botsEnabled: enabled };
      }
    });
    await tick(); choose(ui, 'dice'); changeCount(ui, 4); await addInvited(ui, guest); fill(ui);
    assert.equal(draft(ui).filter(entry => entry.isBot).length, 2);
    enabled = false; failRefresh = failed; await ui.api.load();
    assert.equal(ui.api.inspect().botsEnabled, false);
    assert.deepEqual(draftIds(ui), [guest.accountId]);
    assert.equal(ui.elements.get('gamesInvitees').children.length, 1);
    assert.equal(ui.elements.get('gamesFillBots').hidden, true);
    assert.equal(ui.elements.get('gamesAddPlayer').disabled, false);
    assert.equal(ui.elements.get('gamesSend').textContent, 'Send request');
    assert.equal(ui.pickers[0].settings.isEnabled(), true);
    ui.elements.get('gamesOpponentType').value = 'bot'; choose(ui, 'rock-paper-scissors', 'bot');
    assert.equal(ui.elements.get('gamesOpponentType').value, 'player');
    assert.equal(ui.elements.get('gamesBotNote').hidden, true);
  }
});

test('off mode ignores stale bot selections and draft entries and still allows human invitations', async () => {
  const local = player('local'), first = player('first'), second = player('second');
  const ui = harness(local, [], call => call.route === 'profiles/first' ? { profile: first }
    : call.route === 'profiles/second' ? { profile: second }
      : call.method === 'POST' ? { game: match(local, { game: call.payload.game, recipient: first, opponentType: 'player', status: 'pending' }), user: local } : undefined, {});
  await tick(); choose(ui, 'rock-paper-scissors', 'player');
  ui.elements.get('gamesOpponentType').value = 'bot';
  await ui.api.requestGame({ preventDefault() {} });
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Enter a username.');
  ui.elements.get('gamesUsername').value = 'first';
  await ui.api.requestGame({ preventDefault() {} }); await tick();
  const rps = ui.calls.find(call => call.method === 'POST');
  assert.equal(rps.payload.recipientAccountId, first.accountId);
  assert.equal(rps.payload.opponentType, undefined);
  ui.api.inspect().selectedId = null;
  choose(ui, 'dice'); changeCount(ui, 3); await addInvited(ui, first);
  ui.api.inspect().invitees.push({ ...bot, accountId: 'draft-bot:stale' });
  await ui.api.requestGame({ preventDefault() {} });
  assert.deepEqual(draftIds(ui), [first.accountId]);
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Add 1 more player.');
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  await addInvited(ui, second); await ui.api.requestGame({ preventDefault() {} }); await tick();
  const dice = ui.calls.filter(call => call.method === 'POST')[1];
  assert.deepEqual(dice.payload.recipientAccountIds, [first.accountId, second.accountId]);
  assert.equal(dice.payload.opponentType, undefined); assert.equal(dice.payload.botCount, undefined);
  for (const payload of [{ opponentType: 'bot' }, { opponentType: 'mixed', botCount: 1 }, { botCount: 1 }]) {
    await ui.api.perform({ action: 'request', payload: { ...payload, game: 'dice', stake: 1, clientRequestId: crypto.randomUUID() } });
  }
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 2);
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Bot matches are currently disabled.');
});

test('disabled unsaved bot retries are cleared so human requests can continue', async () => {
  const local = player('local'); let enabled = true;
  const ui = harness(local, [], call => {
    if (call.method === 'GET') return { games: [], user: local, botsEnabled: enabled };
    if (call.method === 'POST') { enabled = false; throw new Error('Response lost'); }
  });
  await tick(); choose(ui, 'dice'); changeCount(ui, 4); fill(ui);
  await ui.api.requestGame({ preventDefault() {} }); await tick();
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(ui.api.inspect().botsEnabled, false); assert.equal(ui.api.inspect().retry, null);
  assert.deepEqual(draftIds(ui), []);
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Bot matches are currently disabled.');
  assert.equal(ui.elements.get('gamesAddPlayer').disabled, false);
  assert.equal(ui.elements.get('gamesStake').disabled, false);
});

test('off mode reconciles a saved bot creation and permits its historical moves', async () => {
  const local = player('local'); let enabled = true, saved = null;
  const ui = harness(local, [], call => {
    if (call.method === 'GET') return { games: saved ? [saved] : [], user: local, botsEnabled: enabled };
    if (call.route === 'games' && call.method === 'POST') {
      saved = match(local, { game: 'rock-paper-scissors', clientRequestId: call.payload.clientRequestId, opponentChosen: true });
      enabled = false; throw new Error('Response lost');
    }
    if (call.method === 'POST') return { game: { ...saved, version: 2, status: 'completed', yourChoice: 'rock', choices: { sender: 'rock', recipient: 'scissors' }, result: 'win', winnerAccountId: local.accountId }, user: local };
  });
  await tick(); choose(ui, 'rock-paper-scissors', 'bot');
  await ui.api.requestGame({ preventDefault() {} }); await tick();
  assert.equal(ui.api.inspect().botsEnabled, false); assert.equal(ui.api.inspect().retry, null);
  assert.equal(ui.api.inspect().entries[0].id, saved.id);
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Match started.');
  ui.api.act('open', saved.id);
  assert.equal(ui.elements.get('gamesChoices').children[0].disabled, false);
  await ui.api.perform({ id: saved.id, action: 'move', payload: { choice: 'rock', clientMoveId: crypto.randomUUID() } });
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 2);
  assert.equal(ui.elements.get('gamesReveal').children[1].textContent, 'Bot: Scissors');
});

test('historical mixed Dice invitations can still be accepted while bots are off', async () => {
  const sender = player('sender'), local = player('local'), pending = mixedDiceMatch(sender, [local], 3);
  const playing = { ...pending, version: 2, status: 'playing', players: pending.players.map(entry => ({ ...entry, accepted: true })), eligibleAccountIds: [local.accountId] };
  const ui = harness(local, [pending], call => call.method === 'POST' ? { game: playing, user: local } : undefined, { botsEnabled: false });
  await tick(); ui.api.act('open', pending.id);
  const accept = ui.elements.get('gamesSessionActions').children.find(entry => entry.dataset.gameAction === 'accept');
  assert.ok(accept); assert.equal(accept.disabled, false);
  await ui.api.perform({ id: pending.id, action: 'accept' });
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(ui.elements.get('gamesRollAction').children[0].disabled, false);
  assert.ok(ui.elements.get('gamesRolls').children.some(row => row.children[0].children[1]?.textContent === 'Bot #1'));
});

test('account changes reset bot capability and stale enabled responses cannot restore it', async () => {
  const local = player('local'), next = player('next'), oldResponse = deferred(), nextResponse = deferred(); let requests = 0;
  const ui = harness(local, [], call => {
    if (call.method !== 'GET') return;
    if (++requests === 1) return { games: [], user: local, botsEnabled: true };
    return requests === 2 ? oldResponse.promise : nextResponse.promise;
  });
  await tick(); assert.equal(ui.api.inspect().botsEnabled, true);
  const oldLoad = ui.api.load(); ui.setUser(next);
  assert.equal(ui.api.inspect().botsEnabled, false);
  choose(ui, 'dice'); assert.equal(ui.elements.get('gamesFillBots').hidden, true);
  oldResponse.resolve({ games: [], user: local, botsEnabled: true }); await oldLoad;
  assert.equal(ui.api.inspect().botsEnabled, false);
  nextResponse.resolve({ games: [], user: next, botsEnabled: false }); await tick();
  assert.equal(ui.context.state.user.accountId, next.accountId);
  assert.equal(ui.api.inspect().botsEnabled, false);
});

test('RPS keeps its bot choice, TTT requires a person, and Dice exposes Fill with bots', async () => {
  const ui = harness(player('local')); await tick();
  assert.equal(ui.elements.get('gamesOpponentOptions').hidden, true);
  choose(ui, 'rock-paper-scissors');
  assert.equal(ui.elements.get('gamesUsername').required, false);
  assert.equal(ui.elements.get('gamesUsername').disabled, true);
  assert.equal(ui.elements.get('gamesUsernameField').hidden, true);
  assert.equal(ui.elements.get('gamesBotNote').hidden, false);
  assert.equal(ui.elements.get('gamesSend').textContent, 'Start match');
  assert.equal(ui.pickers[0].settings.isEnabled(), false);
  assert.equal(ui.elements.get('gamesFillBots').hidden, true);
  choose(ui, 'dice');
  assert.equal(ui.elements.get('gamesOpponentOptions').hidden, true);
  assert.equal(ui.elements.get('gamesFillBots').hidden, false);
  assert.equal(ui.elements.get('gamesFillBots').disabled, false);
  assert.equal(ui.elements.get('gamesDiceOptions').hidden, false);
  assert.equal(ui.elements.get('gamesAddPlayer').hidden, false);
  assert.equal(ui.elements.get('gamesInvitees').hidden, false);
  assert.equal(ui.elements.get('gamesUsernameField').hidden, false);
  assert.equal(ui.elements.get('gamesSend').textContent, 'Send request');
  assert.equal(ui.pickers[0].settings.isEnabled(), true);
  fill(ui);
  assert.equal(ui.elements.get('gamesSend').textContent, 'Start match');
  assert.equal(ui.elements.get('gamesFillBots').disabled, true);
  choose(ui, 'tic-tac-toe', 'bot');
  assert.equal(ui.elements.get('gamesOpponentType').value, 'player');
  assert.equal(ui.elements.get('gamesOpponentOptions').hidden, true);
  assert.equal(ui.elements.get('gamesOpponentType').disabled, true);
  assert.equal(ui.elements.get('gamesUsername').disabled, false);
  assert.equal(ui.elements.get('gamesBotNote').hidden, true);
  assert.equal(ui.elements.get('gamesSend').textContent, 'Send request');
  assert.equal(ui.pickers[0].settings.isEnabled(), true);
  assert.equal(ui.elements.get('gamesUsername').required, true);
  assert.equal(ui.elements.get('gamesUsernameField').hidden, false);
  choose(ui, 'rock-paper-scissors', 'player');
  assert.equal(ui.elements.get('gamesOpponentOptions').hidden, false);
  assert.equal(ui.elements.get('gamesFillBots').hidden, true);
});

test('a stale hidden Bot selection cannot start Tic-Tac-Toe or omit its real invitee', async () => {
  const local = player('local'), guest = player('guest');
  const ui = harness(local, [], call => call.route === 'profiles/guest' ? { profile: guest }
    : call.method === 'POST' ? { game: match(local, { game: 'tic-tac-toe', recipient: guest, opponentType: 'player', status: 'pending' }), user: local } : undefined);
  await tick(); choose(ui, 'rock-paper-scissors', 'bot'); choose(ui, 'tic-tac-toe');
  ui.elements.get('gamesOpponentType').value = 'bot';
  await ui.api.requestGame({ preventDefault() {} });
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Enter a username.');
  ui.elements.get('gamesUsername').value = 'guest'; ui.elements.get('gamesStake').value = '13';
  await ui.api.requestGame({ preventDefault() {} }); await tick();
  const posts = ui.calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 1);
  assert.equal(posts[0].payload.game, 'tic-tac-toe'); assert.equal(posts[0].payload.recipientAccountId, guest.accountId);
  assert.equal(posts[0].payload.opponentType, undefined); assert.equal(posts[0].payload.botCount, undefined);
  assert.equal(posts[0].payload.stake, 13);
  assert.ok(ui.calls.some(call => call.route === 'profiles/guest'));
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Request sent.');
});

test('Dice bot requests fill two, three, and four player matches without recipient IDs', async () => {
  for (const [count, payoutMode] of [[2, 'shared'], [3, 'shared'], [4, 'single-winner']]) {
    const local = player('local');
    const ui = harness(local, [], call => call.method === 'POST' ? { game: diceMatch(local, count, { stake: call.payload.stake, pot: count * call.payload.stake, payoutMode: count === 2 ? 'single-winner' : call.payload.payoutMode }), user: local } : undefined);
    await tick(); choose(ui, 'dice');
    ui.elements.get('gamesPlayerCount').value = String(count);
    ui.elements.get('gamesPayoutMode').value = payoutMode;
    ui.elements.get('gamesRequestForm').dispatch('change', ui.elements.get('gamesPlayerCount'));
    fill(ui);
    ui.elements.get('gamesStake').value = '17';
    assert.equal(ui.elements.get('gamesPayoutModeField').hidden, count === 2);
    await ui.api.requestGame({ preventDefault() {} }); await tick();
    const posts = ui.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual(Object.keys(posts[0].payload).sort(), ['botCount', 'clientRequestId', 'game', 'opponentType', ...(count > 2 ? ['payoutMode'] : []), 'stake'].sort());
    assert.equal(posts[0].payload.opponentType, 'bot');
    assert.equal(posts[0].payload.game, 'dice');
    assert.equal(posts[0].payload.botCount, count - 1);
    assert.equal(posts[0].payload.stake, 17);
    assert.equal(posts[0].payload.payoutMode, count > 2 ? payoutMode : undefined);
    assert.ok(ui.calls.every(call => call.route === 'games'));
    assert.equal(ui.elements.get('gamesSession').hidden, false);
    assert.equal(ui.elements.get('gamesStakeSummary').textContent, '17 tokens each');
    assert.equal(ui.elements.get('gamesPot').textContent, `${17 * count} token pot · ${count === 2 || payoutMode === 'single-winner' ? 'Single winner' : 'Shared'}`);
    assert.equal(ui.elements.get('gamesMessage').textContent, 'Match started.');
  }
});

test('Dice bot names remain distinct and unlinked while only the human can roll', async () => {
  for (const count of [2, 3, 4]) {
    const local = player('local'), game = diceMatch(local, count);
    const ui = harness(local, [game]); await tick(); ui.api.act('open', game.id);
    const rows = ui.elements.get('gamesRolls').children;
    assert.equal(rows.length, count);
    for (let index = 1; index < count; index++) {
      const identity = rows[index].children[0];
      assert.equal(identity.tagName, 'SPAN'); assert.equal(identity.href, undefined);
      assert.equal(identity.children[1].textContent, count === 2 ? 'Bot' : `Bot #${index}`);
      assert.equal(rows[index].children[1].dataset.value, String(index));
    }
    assert.ok(ui.profileNames.every(name => !name.startsWith('Bot')));
    assert.equal(ui.elements.get('gamesRollAction').children.length, 1);
    assert.equal(ui.elements.get('gamesRollAction').children[0].textContent, 'Roll');
    assert.equal(ui.elements.get('gamesRollAction').children[0].disabled, false);
    assert.equal(ui.elements.get('gamesTurn').textContent, 'Roll your dice');
  }
});

test('Fill with bots adds only vacant seats and never duplicates a full roster', async () => {
  for (const humans of [0, 1, 2]) {
    const local = player('local'), invited = Array.from({ length: humans }, (_, index) => player(`guest${index + 1}`));
    const ui = harness(local, [], call => call.route.startsWith('profiles/') ? { profile: invited.find(entry => call.route === `profiles/${entry.username}`) } : undefined);
    await tick(); choose(ui, 'dice'); changeCount(ui, 4);
    for (const entry of invited) await addInvited(ui, entry);
    fill(ui);
    assert.equal(draft(ui).length, 3);
    assert.deepEqual(draft(ui).filter(entry => !entry.isBot).map(entry => entry.accountId), invited.map(entry => entry.accountId));
    const bots = draft(ui).filter(entry => entry.isBot);
    assert.equal(bots.length, 3 - humans); assert.equal(new Set(bots.map(entry => entry.accountId)).size, bots.length);
    assert.deepEqual(bots.map(entry => entry.username), Array.from({ length: bots.length }, (_, index) => `Bot #${index + 1}`));
    assert.equal(ui.elements.get('gamesFillBots').disabled, true);
    assert.equal(ui.elements.get('gamesAddPlayer').disabled, true);
    const before = draftIds(ui); fill(ui); assert.deepEqual(draftIds(ui), before);
    assert.ok(ui.profileNames.every(name => !name.startsWith('Bot')));
    for (const row of ui.elements.get('gamesInvitees').children.slice(humans)) {
      assert.equal(row.children[0].tagName, 'SPAN'); assert.equal(row.children[0].href, undefined);
      assert.equal(row.children[1].disabled, false);
    }
  }
});

test('a bot can be removed, replaced by a real invitee, and refilled with consecutive names', async () => {
  const local = player('local'), guest = player('guest');
  const ui = harness(local, [], call => call.route === 'profiles/guest' ? { profile: guest } : undefined);
  await tick(); choose(ui, 'dice'); changeCount(ui, 4); fill(ui);
  const removed = draft(ui)[1].accountId;
  removeDraft(ui, removed);
  assert.equal(draft(ui).length, 2); assert.equal(ui.elements.get('gamesFillBots').disabled, false);
  assert.deepEqual(draft(ui).map(entry => entry.username), ['Bot #1', 'Bot #2']);
  await addInvited(ui, guest);
  assert.equal(draft(ui).length, 3); assert.equal(draft(ui).filter(entry => !entry.isBot)[0].accountId, guest.accountId);
  assert.equal(ui.elements.get('gamesSend').textContent, 'Send request');
  const botId = draft(ui).find(entry => entry.isBot).accountId;
  removeDraft(ui, botId); fill(ui);
  assert.equal(draft(ui).length, 3);
  assert.deepEqual(draft(ui).filter(entry => entry.isBot).map(entry => entry.username), ['Bot #1', 'Bot #2']);
  assert.ok(!draftIds(ui).includes(botId));
  assert.ok(ui.profileNames.every(name => !name.startsWith('Bot')));
});

test('Dice count changes remove bots before humans and growth leaves open seats for filling', async () => {
  const local = player('local'), first = player('first'), second = player('second');
  const ui = harness(local, [], call => call.route === 'profiles/first' ? { profile: first } : call.route === 'profiles/second' ? { profile: second } : undefined);
  await tick(); choose(ui, 'dice'); changeCount(ui, 4);
  await addInvited(ui, first); await addInvited(ui, second); fill(ui);
  changeCount(ui, 3);
  assert.deepEqual(draftIds(ui), [first.accountId, second.accountId]);
  assert.equal(ui.elements.get('gamesFillBots').disabled, true);
  changeCount(ui, 2);
  assert.deepEqual(draftIds(ui), [first.accountId]);
  changeCount(ui, 4);
  assert.deepEqual(draftIds(ui), [first.accountId]);
  assert.equal(ui.elements.get('gamesFillBots').disabled, false);
  fill(ui);
  assert.deepEqual(draft(ui).filter(entry => !entry.isBot).map(entry => entry.accountId), [first.accountId]);
  assert.deepEqual(draft(ui).filter(entry => entry.isBot).map(entry => entry.username), ['Bot #1', 'Bot #2']);
});

test('all-bot rosters rename the sole opponent Bot when reduced to two players', async () => {
  const ui = harness(player('local')); await tick(); choose(ui, 'dice'); changeCount(ui, 4); fill(ui);
  changeCount(ui, 2);
  assert.equal(draft(ui).length, 1); assert.equal(draft(ui)[0].username, 'Bot');
  changeCount(ui, 4);
  assert.equal(draft(ui).length, 1); assert.equal(draft(ui)[0].username, 'Bot #1');
  fill(ui);
  assert.deepEqual(draft(ui).map(entry => entry.username), ['Bot #1', 'Bot #2', 'Bot #3']);
});

test('Dice requires a full roster and supports human-only requests with no bot terms', async () => {
  for (const count of [2, 3, 4]) {
    const local = player('local'), invited = Array.from({ length: count - 1 }, (_, index) => player(`guest${index + 1}`));
    const ui = harness(local, [], call => call.route.startsWith('profiles/') ? { profile: invited.find(entry => call.route === `profiles/${entry.username}`) }
      : call.method === 'POST' ? { game: mixedDiceMatch(local, invited, count, { opponentType: 'player' }), user: local } : undefined);
    await tick(); choose(ui, 'dice'); changeCount(ui, count);
    await ui.api.requestGame({ preventDefault() {} });
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
    assert.match(ui.elements.get('gamesMessage').textContent, /Add|Fill|place|seat/i);
    for (const entry of invited) await addInvited(ui, entry);
    assert.equal(ui.elements.get('gamesFillBots').disabled, true);
    const before = draftIds(ui); fill(ui); assert.deepEqual(draftIds(ui), before);
    ui.elements.get('gamesStake').value = '12';
    ui.elements.get('gamesPayoutMode').value = 'single-winner';
    await ui.api.requestGame({ preventDefault() {} }); await tick();
    const posts = ui.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].payload.recipientAccountIds, invited.map(entry => entry.accountId));
    assert.equal(posts[0].payload.botCount, undefined); assert.equal(posts[0].payload.opponentType, undefined);
    assert.equal(posts[0].payload.payoutMode, 'single-winner'); assert.equal(posts[0].payload.stake, 12);
    assert.equal(ui.elements.get('gamesMessage').textContent, 'Request sent.');
  }
});

test('Fill with bots is unavailable in RPS and TTT and cannot mutate their drafts', async () => {
  const ui = harness(player('local')); await tick();
  for (const type of ['tic-tac-toe', 'rock-paper-scissors']) {
    choose(ui, type, 'player');
    assert.equal(ui.elements.get('gamesFillBots').hidden, true);
    const before = draftIds(ui); fill(ui); assert.deepEqual(draftIds(ui), before);
  }
});

test('mixed Dice sends real invitees and fills remaining places with matching bots', async () => {
  for (const [count, humans, payoutMode] of [[3, 1, 'shared'], [4, 1, 'single-winner'], [4, 2, 'shared']]) {
    const local = player('local'), invited = Array.from({ length: humans }, (_, index) => player(`guest${index + 1}`));
    const ui = harness(local, [], call => call.route.startsWith('profiles/') ? { profile: invited.find(entry => call.route === `profiles/${entry.username}`) } : call.method === 'POST' ? { game: mixedDiceMatch(local, invited, count, { stake: call.payload.stake }), user: local } : undefined);
    await tick(); choose(ui, 'dice');
    ui.elements.get('gamesPlayerCount').value = String(count); ui.elements.get('gamesPayoutMode').value = payoutMode;
    ui.elements.get('gamesRequestForm').dispatch('change', ui.elements.get('gamesPlayerCount'));
    for (const entry of invited) { ui.elements.get('gamesUsername').value = entry.username; await ui.api.addPlayer(); }
    const botCount = count - 1 - humans; fill(ui);
    assert.equal(ui.elements.get('gamesAddPlayer').disabled, true);
    assert.equal(ui.elements.get('gamesFillBots').disabled, true);
    ui.elements.get('gamesStake').value = '13'; await ui.api.requestGame({ preventDefault() {} }); await tick();
    const posts = ui.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].payload.recipientAccountIds, invited.map(entry => entry.accountId));
    assert.equal(posts[0].payload.opponentType, 'mixed'); assert.equal(posts[0].payload.botCount, botCount);
    assert.equal(posts[0].payload.game, 'dice'); assert.equal(posts[0].payload.stake, 13); assert.equal(posts[0].payload.payoutMode, payoutMode);
    assert.equal(ui.elements.get('gamesMessage').textContent, 'Request sent.');
    const rows = ui.elements.get('gamesPlayers').children;
    for (let index = humans + 1; index < count; index++) {
      const identity = rows[index].children[1];
      assert.equal(identity.tagName, 'SPAN'); assert.equal(identity.href, undefined);
      assert.equal(identity.children[1].textContent, `Bot #${index - humans}`);
      assert.equal(rows[index].children[2].textContent, 'Accepted');
    }
  }
});

test('Dice bot and mixed retries keep the original participants and prize mode', async () => {
  for (const opponent of ['bot', 'mixed']) {
    const local = player('local'), guest = player('guest'); let attempts = 0;
    const ui = harness(local, [], call => {
      if (call.route === 'profiles/guest') return { profile: guest };
      if (call.method !== 'POST') return;
      if (++attempts === 1) throw new Error('Response lost');
      return { game: opponent === 'mixed' ? mixedDiceMatch(local, [guest], 4) : diceMatch(local, 4), user: local };
    });
    await tick(); choose(ui, 'dice');
    ui.elements.get('gamesPlayerCount').value = '4'; ui.elements.get('gamesPayoutMode').value = 'single-winner';
    ui.elements.get('gamesRequestForm').dispatch('change', ui.elements.get('gamesPlayerCount'));
    if (opponent === 'mixed') { ui.elements.get('gamesUsername').value = 'guest'; await ui.api.addPlayer(); }
    fill(ui);
    ui.elements.get('gamesStake').value = '29'; await ui.api.requestGame({ preventDefault() {} }); await tick();
    const retry = ui.api.inspect().retry; assert.ok(retry);
    for (const id of ['gamesPlayerCount', 'gamesPayoutMode', 'gamesOpponentType', 'gamesStake']) assert.equal(ui.elements.get(id).disabled, true);
    assert.equal(ui.elements.get('gamesFillBots').disabled, true);
    const before = draftIds(ui); fill(ui);
    removeDraft(ui, before[before.length - 1]);
    ui.elements.get('gamesUsername').value = 'guest'; await ui.api.addPlayer();
    assert.deepEqual(draftIds(ui), before);
    await ui.api.perform(retry); await tick();
    const posts = ui.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 2); assert.deepEqual(posts[0].payload, posts[1].payload);
    assert.equal(posts[1].payload.botCount, opponent === 'mixed' ? 2 : 3);
    assert.equal(posts[1].payload.stake, 29); assert.equal(posts[1].payload.payoutMode, 'single-winner');
    assert.equal(ui.api.inspect().retry, null);
  }
});

test('RPS bot games start directly without account lookup or recipient IDs', async () => {
  for (const type of ['rock-paper-scissors']) {
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
  const ui = harness(player('local')); await tick(); choose(ui, 'rock-paper-scissors');
  for (const stake of ['', '0', '-1', '1.5', '2251799813685248']) {
    ui.elements.get('gamesStake').value = stake;
    await ui.api.requestGame({ preventDefault() {} });
    assert.equal(ui.elements.get('gamesMessage').textContent, 'Bet at least 1 token.');
  }
  ui.elements.get('gamesStake').value = '101'; await ui.api.requestGame({ preventDefault() {} });
  assert.equal(ui.elements.get('gamesMessage').textContent, 'Not enough tokens.');
  assert.ok(ui.calls.every(call => call.method === 'GET'));
});

test('historical TTT Bot has no profile link and its saved opening board remains playable', async () => {
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
  await tick(); choose(ui, 'rock-paper-scissors');
  const pending = ui.api.requestGame({ preventDefault() {} }); ui.setUser(next);
  response.resolve({ game: match(local), user: { ...local, balance: 90 } }); await pending; await tick();
  assert.equal(ui.context.state.user.accountId, next.accountId);
  assert.equal(ui.context.state.user.balance, 100);
  assert.equal(ui.api.inspect().selectedId, null);
  assert.equal(ui.api.inspect().entries.length, 0);
  assert.equal(ui.elements.get('gamesOpponentType').value, 'player');
});

test('switching accounts clears a filled Dice roster and ignores an old request response', async () => {
  const local = player('local'), next = player('next'), response = deferred();
  const ui = harness(local, [], call => call.method === 'POST' ? response.promise : undefined);
  await tick(); choose(ui, 'dice'); changeCount(ui, 4); fill(ui);
  assert.equal(draft(ui).length, 3);
  const pending = ui.api.requestGame({ preventDefault() {} });
  assert.equal(ui.elements.get('gamesFillBots').disabled, true);
  ui.setUser(next);
  assert.deepEqual(draftIds(ui), []); assert.equal(ui.api.inspect().retry, null);
  assert.equal(ui.elements.get('gamesPlayerCount').value, '2');
  assert.equal(ui.elements.get('gamesFillBots').hidden, true);
  response.resolve({ game: diceMatch(local, 4), user: { ...local, balance: 90 } });
  await pending; await tick();
  assert.equal(ui.context.state.user.accountId, next.accountId); assert.equal(ui.context.state.user.balance, 100);
  assert.equal(ui.api.inspect().selectedId, null); assert.equal(ui.api.inspect().entries.length, 0);
  choose(ui, 'dice');
  assert.deepEqual(draftIds(ui), []); assert.equal(ui.elements.get('gamesFillBots').disabled, false);
});
