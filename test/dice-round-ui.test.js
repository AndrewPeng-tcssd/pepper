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
const bot = index => ({ accountId: `BOT-${index}`, username: `Bot #${index}`, isBot: true, accepted: true });
function fixtureGame(people, extra = {}) {
  return {
    id: crypto.randomBytes(12).toString('hex'), clientRequestId: crypto.randomUUID(), game: 'dice', stake: 10,
    sender: people[0], recipient: people[1], players: people.map(entry => ({ ...entry, accepted: true })),
    opponentType: people.some(entry => entry.isBot) ? 'bot' : 'player',
    pot: people.length * 10, payoutMode: people.length > 2 ? 'shared' : 'single-winner', status: 'playing', version: 2,
    dice: { round: 1, groups: [people.map(entry => entry.accountId)], rolls: {}, history: [] },
    eligibleAccountIds: people.map(entry => entry.accountId), payouts: null, placements: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString(),
    ...extra
  };
}
function tieTransition(game, rolls, extra = {}) {
  const [first, second, ...others] = game.players.map(entry => entry.accountId);
  return { ...game, version: game.version + 1,
    dice: { round: 2, groups: [[first, second], ...others.map(entry => [entry])], rolls: {},
      history: [{ round: 1, groups: game.dice.groups, rolls }] },
    eligibleAccountIds: [first, second], ...extra };
}
function harness(user, entries, network, { reducedMotion = false } = {}) {
  const elements = new Map(), calls = [], timers = new Map();
  let context, clock = Date.now(), nextTimer = 1;
  const radios = [{ value: 'tic-tac-toe', checked: true }, { value: 'rock-paper-scissors' }, { value: 'dice' }];
  const node = (id = '', attrs = '') => {
    const classes = new Set(), listeners = new Map();
    return {
      id, children: [], dataset: {}, textContent: '', hidden: /\bhidden\b/.test(attrs), disabled: false,
      value: /value="([^"]*)"/.exec(attrs)?.[1] ?? '',
      classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, setAttribute(name, value) { this[name] = value; },
      addEventListener(type, listener) { listeners.set(type, listener); }, dispatch(type, target = this) { return listeners.get(type)?.({ preventDefault() {}, target }); },
      contains(target) { return !!target && (this === target || this.children.includes(target)); },
      closest(selector) { return selector === '[data-game-action]' && this.dataset.gameAction || selector === '[data-game-remove-player]' && this.dataset.gameRemovePlayer ? this : null; },
      focus() { document.activeElement = this; }, querySelector() { return radios.find(entry => entry.checked); },
      querySelectorAll(selector) { return selector === 'input, select' ? [...radios, ...['gamesUsername', 'gamesStake', 'gamesPlayerCount', 'gamesPayoutMode', 'gamesOpponentType'].map(entry => elements.get(entry))] : []; },
      reset() { elements.get('gamesUsername').value = ''; elements.get('gamesStake').value = '1'; elements.get('gamesPlayerCount').value = '2'; elements.get('gamesPayoutMode').value = 'shared'; elements.get('gamesOpponentType').value = 'player'; radios.forEach((entry, index) => { entry.checked = index === 0; }); },
      click() { return this.dispatch('click'); }
    };
  };
  for (const found of html.matchAll(/<[a-z][a-z0-9]*\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(found[2], node(found[2], found[1]));
  const document = { getElementById: id => elements.get(id), createElement: () => node(), body: node(), activeElement: null, contains: () => true, querySelectorAll: () => [] };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const boundary = {
    document, Date: FakeDate, window: { matchMedia: () => ({ matches: reducedMotion }), PepperPlayerPicker: { attach: () => ({ close() {}, reset() {} }) } },
    crypto, console, setInterval() {}, clearInterval() {},
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    state: { user: null, accountSubmitting: false }, authRevision: 0, userIdentityRevision: 0, routeRevision: 0, pageKind: 'games', accountBanned: false,
    profileHref: username => `/profile/${username}`, profileAvatar: () => node(), playerRoleBadges: () => node(), setChatOpen() {}, focusRouteHeading() {},
    navigateTo() { context.pageKind = 'games'; context.routeRevision++; }, message(target, value) { target.textContent = value; },
    setUser(value) { if (context.state.user?.accountId !== value?.accountId) context.userIdentityRevision++; context.authRevision++; context.state.user = value; context.window.PepperGames.syncUser(); },
    api: async (route, options = {}) => {
      const call = { route, method: options.method ?? 'GET', payload: options.body ? JSON.parse(options.body) : null }; calls.push(call);
      const response = await network?.(call);
      if (response !== undefined) return response;
      if (route === 'games' && call.method === 'GET') return { games: entries, user: context.state.user };
      throw new Error(`Unexpected API call ${route}`);
    }
  };
  context = vm.createContext(boundary);
  vm.runInContext(source.replace('window.PepperGames = { syncUser, load, onRoute, renderNotification };', 'window.PepperGames = { syncUser, load, onRoute, renderNotification, inspect: () => games, perform, act, render };'), context);
  boundary.setUser(user);
  async function advance(milliseconds) {
    const target = clock + milliseconds;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due; timers.delete(id); clock = timer.at; timer.callback(); await tick();
    }
    clock = target; await tick();
  }
  return { api: context.window.PepperGames, elements, calls, context, entries, setUser: boundary.setUser, advance,
    timers: () => Array.from(timers.values()) };
}
const roundLabel = ui => ui.elements.get('gamesDiceRound').textContent;
const faces = ui => ui.elements.get('gamesRolls').children.map(row => row.children[1].dataset.value);
const rollButton = ui => ui.elements.get('gamesRollAction').children[0];
function replaceEntry(ui, game) { ui.entries.splice(ui.entries.findIndex(entry => entry.id === game.id), 1, game); }
async function poll(ui, game) { replaceEntry(ui, game); await ui.api.load(); await tick(); }

test('a local final roll finishes its animation, then displays every round result for exactly two seconds', async () => {
  const people = [player('local'), player('other'), player('third')];
  const rolls = { [people[0].accountId]: 6, [people[1].accountId]: 6, [people[2].accountId]: 1 };
  const game = fixtureGame(people, { dice: { round: 1, groups: [people.map(entry => entry.accountId)], rolls: { [people[1].accountId]: 6, [people[2].accountId]: 1 }, history: [] }, eligibleAccountIds: [people[0].accountId] });
  const next = tieTransition(game, rolls);
  const entries = [game];
  const ui = harness(people[0], entries, call => {
    if (call.method === 'POST') { entries.splice(0, 1, next); return { game: next, user: people[0] }; }
  });
  await tick(); ui.api.act('open', game.id);
  const pending = ui.api.perform({ id: game.id, action: 'move', payload: { round: 1, clientMoveId: crypto.randomUUID() } });
  await tick(); assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  await ui.advance(699);
  assert.equal(ui.elements.get('gamesRolls').children[0].children[1].classList.contains('is-rolling'), true);
  await ui.advance(1); await pending; await tick();
  assert.match(roundLabel(ui), /Round 1/); assert.deepEqual(faces(ui), ['6', '6', '1']);
  assert.equal(ui.elements.get('gamesRolls').children[0].children[1].classList.contains('is-rolling'), false);
  assert.equal(rollButton(ui).disabled, true);
  const posts = ui.calls.filter(call => call.method === 'POST').length;
  ui.elements.get('gamesPage').dispatch('click', rollButton(ui));
  ui.api.act('move', game.id, { round: 2, clientMoveId: crypto.randomUUID() }); await tick();
  await ui.api.perform({ id: game.id, action: 'move', payload: { round: 2, clientMoveId: crypto.randomUUID() } });
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, posts);
  await ui.advance(1999); assert.match(roundLabel(ui), /Round 1/); assert.deepEqual(faces(ui), ['6', '6', '1']);
  await ui.advance(1); assert.match(roundLabel(ui), /Round 2/); assert.equal(rollButton(ui).disabled, false);
});

test('opponent polling holds the finished round and duplicate polls do not restart its two-second timer', async () => {
  const people = [player('local'), player('other'), player('third')], game = fixtureGame(people);
  const rolls = { [people[0].accountId]: 5, [people[1].accountId]: 5, [people[2].accountId]: 2 };
  const next = tieTransition(game, rolls);
  const ui = harness(people[0], [game]); await tick(); ui.api.act('open', game.id);
  await poll(ui, next);
  assert.match(roundLabel(ui), /Round 1/); assert.deepEqual(faces(ui), ['5', '5', '2']); assert.equal(rollButton(ui).disabled, true);
  await ui.advance(1000); await poll(ui, next);
  const later = { ...next, version: next.version + 1, dice: { ...next.dice, rolls: { [people[1].accountId]: 3 } }, eligibleAccountIds: [people[0].accountId] };
  await poll(ui, later);
  assert.match(roundLabel(ui), /Round 1/); assert.deepEqual(faces(ui), ['5', '5', '2']);
  await ui.advance(999); assert.match(roundLabel(ui), /Round 1/);
  await ui.advance(1); assert.match(roundLabel(ui), /Round 2/); assert.deepEqual(faces(ui), ['', '3', '2']);
  assert.equal(rollButton(ui).disabled, false); assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('a nonfinal roll is revealed after its animation without adding a round pause', async () => {
  const people = [player('local'), player('other'), player('third')], game = fixtureGame(people);
  const rolled = { ...game, version: 3, dice: { ...game.dice, rolls: { [people[0].accountId]: 4 } }, eligibleAccountIds: [people[1].accountId, people[2].accountId] };
  const entries = [game];
  const ui = harness(people[0], entries, call => { if (call.method === 'POST') { entries.splice(0, 1, rolled); return { game: rolled, user: people[0] }; } });
  await tick(); ui.api.act('open', game.id);
  const pending = ui.api.perform({ id: game.id, action: 'move', payload: { round: 1, clientMoveId: crypto.randomUUID() } });
  await ui.advance(700); await pending; await tick();
  assert.match(roundLabel(ui), /Round 1/); assert.deepEqual(faces(ui), ['4', '', '']);
  assert.equal(rollButton(ui).textContent, 'Rolled'); assert.equal(ui.timers().filter(timer => timer.delay === 2000).length, 0);
});

test('reduced motion skips the spin but still keeps a finished round visible for two seconds', async () => {
  const people = [player('local'), player('other'), player('third')], game = fixtureGame(people);
  const next = tieTransition(game, { [people[0].accountId]: 6, [people[1].accountId]: 6, [people[2].accountId]: 1 });
  const entries = [game];
  const ui = harness(people[0], entries, call => { if (call.method === 'POST') { entries.splice(0, 1, next); return { game: next, user: people[0] }; } }, { reducedMotion: true });
  await tick(); ui.api.act('open', game.id);
  await ui.api.perform({ id: game.id, action: 'move', payload: { round: 1, clientMoveId: crypto.randomUUID() } }); await tick();
  assert.equal(ui.timers().filter(timer => timer.delay === 700).length, 0);
  assert.match(roundLabel(ui), /Round 1/); assert.deepEqual(faces(ui), ['6', '6', '1']);
  await ui.advance(1999); assert.match(roundLabel(ui), /Round 1/);
  await ui.advance(1); assert.match(roundLabel(ui), /Round 2/);
});

test('account switching cancels the paused round and its timer cannot reopen old game state', async () => {
  const people = [player('local'), player('other'), player('third')], game = fixtureGame(people);
  const next = tieTransition(game, { [people[0].accountId]: 6, [people[1].accountId]: 6, [people[2].accountId]: 1 });
  const ui = harness(people[0], [game]); await tick(); ui.api.act('open', game.id); await poll(ui, next);
  assert.match(roundLabel(ui), /Round 1/);
  const nextUser = player('next'); ui.entries.splice(0); ui.setUser(nextUser); await tick();
  assert.equal(ui.api.inspect().selectedId, null); assert.equal(ui.elements.get('gamesSession').hidden, true);
  assert.equal(ui.timers().filter(timer => timer.delay === 2000).length, 0);
  await ui.advance(2000);
  assert.equal(ui.api.inspect().selectedId, null); assert.equal(ui.context.state.user.accountId, nextUser.accountId);
  assert.equal(ui.elements.get('gamesSession').hidden, true);
});

test('opening another game or leaving the Games route cancels the old round presentation', async () => {
  for (const action of ['another-game', 'leave-route']) {
    const people = [player('local'), player('other'), player('third')], game = fixtureGame(people), other = fixtureGame(people);
    const next = tieTransition(game, { [people[0].accountId]: 6, [people[1].accountId]: 6, [people[2].accountId]: 1 });
    const ui = harness(people[0], [game, other]); await tick(); ui.api.act('open', game.id); await poll(ui, next);
    assert.match(roundLabel(ui), /Round 1/);
    if (action === 'another-game') ui.api.act('open', other.id);
    else { ui.context.pageKind = 'packs'; ui.context.routeRevision++; ui.api.onRoute(); }
    assert.equal(ui.timers().filter(timer => timer.delay === 2000).length, 0);
    await ui.advance(2000);
    if (action === 'another-game') {
      assert.equal(ui.api.inspect().selectedId, other.id); assert.match(roundLabel(ui), /Round 1/); assert.deepEqual(faces(ui), ['', '', '']);
    } else {
      ui.context.pageKind = 'games'; ui.context.routeRevision++; ui.api.onRoute(); await tick();
      assert.match(roundLabel(ui), /Round 2/);
    }
  }
});

test('successive bot-only playoff rounds show each completed set of rolls for two seconds', async () => {
  const people = [player('local'), bot(1), bot(2)], game = fixtureGame(people);
  const ids = people.map(entry => entry.accountId);
  const history = [
    { round: 1, groups: [ids], rolls: { [ids[0]]: 1, [ids[1]]: 6, [ids[2]]: 6 } },
    { round: 2, groups: [[ids[1], ids[2]], [ids[0]]], rolls: { [ids[1]]: 4, [ids[2]]: 4 } },
    { round: 3, groups: [[ids[1], ids[2]], [ids[0]]], rolls: { [ids[1]]: 2, [ids[2]]: 5 } }
  ];
  const finished = { ...game, status: 'completed', version: 5, result: 'ranked', winnerAccountId: ids[2], eligibleAccountIds: [],
    dice: { round: 3, groups: [[ids[2]], [ids[1]], [ids[0]]], rolls: history[2].rolls, history },
    placements: [{ accountId: ids[2], place: 1, payout: 20 }, { accountId: ids[1], place: 2, payout: 10 }, { accountId: ids[0], place: 3, payout: 0 }],
    payouts: { [ids[2]]: 20, [ids[1]]: 10, [ids[0]]: 0 } };
  const ui = harness(people[0], [game]); await tick(); ui.api.act('open', game.id); await poll(ui, finished);
  assert.match(roundLabel(ui), /Round 1/); assert.deepEqual(faces(ui), ['1', '6', '6']);
  await ui.advance(1999); assert.match(roundLabel(ui), /Round 1/);
  await ui.advance(1); assert.match(roundLabel(ui), /Round 2/); assert.deepEqual(faces(ui), ['1', '4', '4']);
  await ui.advance(1999); assert.match(roundLabel(ui), /Round 2/);
  await ui.advance(1); assert.match(roundLabel(ui), /Round 3/); assert.deepEqual(faces(ui), ['1', '2', '5']);
  assert.equal(ui.elements.get('gamesPlacements').children.length, 3);
});

test('the final match result appears after the spin without an extra next-round delay', async () => {
  const people = [player('local'), player('other')], game = fixtureGame(people);
  const rolls = { [people[0].accountId]: 6, [people[1].accountId]: 2 };
  const finished = { ...game, status: 'completed', version: 3, result: 'win', winnerAccountId: people[0].accountId,
    eligibleAccountIds: [], dice: { ...game.dice, rolls, history: [{ round: 1, groups: game.dice.groups, rolls }] },
    payouts: { [people[0].accountId]: 20, [people[1].accountId]: 0 },
    placements: [{ accountId: people[0].accountId, place: 1, payout: 20 }, { accountId: people[1].accountId, place: 2, payout: 0 }] };
  const entries = [game];
  const ui = harness(people[0], entries, call => { if (call.method === 'POST') { entries.splice(0, 1, finished); return { game: finished, user: people[0] }; } });
  await tick(); ui.api.act('open', game.id);
  const pending = ui.api.perform({ id: game.id, action: 'move', payload: { round: 1, clientMoveId: crypto.randomUUID() } });
  await ui.advance(700); await pending; await tick();
  assert.equal(ui.elements.get('gamesSessionStatus').textContent, 'You won');
  assert.equal(ui.elements.get('gamesTurn').textContent, '20 tokens received');
  assert.deepEqual(faces(ui), ['6', '2']); assert.equal(ui.elements.get('gamesPlacements').children.length, 2);
  assert.equal(ui.elements.get('gamesRollAction').children.length, 0);
  assert.equal(ui.timers().filter(timer => timer.delay === 2000).length, 0);
});

test('opening a game already in a later round displays its current state without replaying old results', async () => {
  const people = [player('local'), player('other'), player('third')], game = fixtureGame(people);
  const next = tieTransition(game, { [people[0].accountId]: 6, [people[1].accountId]: 6, [people[2].accountId]: 1 });
  const ui = harness(people[0], [next]); await tick(); ui.api.act('open', next.id);
  assert.match(roundLabel(ui), /Round 2/); assert.deepEqual(faces(ui), ['', '', '1']);
  assert.equal(rollButton(ui).disabled, false); assert.equal(ui.elements.get('gamesDiceHistory').children.length, 1);
  assert.equal(ui.timers().filter(timer => timer.delay === 2000).length, 0);
  await ui.advance(2000); assert.match(roundLabel(ui), /Round 2/);
});

test('cancellation interrupts a held round immediately and cannot be undone by its old timer', async () => {
  const people = [player('local'), player('other'), player('third')], game = fixtureGame(people);
  const next = tieTransition(game, { [people[0].accountId]: 6, [people[1].accountId]: 6, [people[2].accountId]: 1 });
  const ui = harness(people[0], [game]); await tick(); ui.api.act('open', game.id); await poll(ui, next);
  assert.match(roundLabel(ui), /Round 1/);
  await ui.advance(500);
  const cancelled = { ...next, version: 4, status: 'cancelled', reason: 'account-banned', eligibleAccountIds: [] };
  await poll(ui, cancelled);
  assert.equal(ui.elements.get('gamesSessionStatus').textContent, 'Cancelled');
  assert.equal(ui.elements.get('gamesTurn').textContent, 'Cancelled'); assert.equal(ui.elements.get('gamesDice').hidden, true);
  assert.equal(ui.timers().filter(timer => timer.delay === 2000).length, 0);
  await ui.advance(2000);
  assert.equal(ui.elements.get('gamesSessionStatus').textContent, 'Cancelled'); assert.equal(ui.elements.get('gamesDice').hidden, true);
});
