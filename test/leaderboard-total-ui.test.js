const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function productionFunction(name) {
  const match = new RegExp(`function ${name}\\(`).exec(source);
  assert.ok(match, `Production function ${name} exists`);
  return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const entry = { accountId: 'PPR-example', username: 'Example', rank: 1, balance: 17, role: 'player', banned: false };
const snapshot = (totalTokens, entries = [entry], totalPlayers = entries.length) => ({ entries, totalPlayers, totalTokens });
function harness(network) {
  const elements = new Map(), calls = [];
  const node = (tag = 'div', attrs = '') => ({
    tagName: tag.toUpperCase(), children: [], dataset: {}, textContent: '', hidden: /\bhidden\b/.test(attrs),
    classList: { toggle() {} }, setAttribute(name, value) { this[name] = value; },
    append(...children) { this.children.push(...children.flatMap(child => child.tagName === '#FRAGMENT' ? child.children : [child])); },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    closest() { return null; }, focus() {}, querySelector() { return null; }
  });
  for (const found of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(found[3], node(found[1], found[2]));
  elements.get('leaderboardMessage').textContent = 'Loading leaderboard…';
  const document = { activeElement: null, createElement: node, createDocumentFragment: () => node('#fragment') };
  const context = vm.createContext({
    document, BigInt, state: { user: null, leaderboard: null, leaderboardSignature: null, leaderboardRowsSignature: null },
    pageKind: 'leaderboard', leaderboardLoadPromise: null, leaderboardRefreshQueued: false, leaderboardRevision: 0,
    $: id => elements.get(id), profileHref: username => `/profile/${username}`, profileAvatar: () => node('img'), playerRoleBadges: () => node('span'),
    message: (target, text) => { target.textContent = text; },
    api: async route => { calls.push(route); return network?.(calls.length) ?? snapshot('17'); }
  });
  vm.runInContext(['renderLeaderboard', 'loadLeaderboard'].map(productionFunction).join('\n'), context);
  return { context, elements, calls, render: value => context.renderLeaderboard(value), load: refresh => context.loadLeaderboard(refresh) };
}
const total = ui => ui.elements.get('leaderboardTotalTokens').textContent;

test('the economy counter formats an exact decimal string beyond safe integer precision', () => {
  const ui = harness(); const value = '900719925474099312345678901234567890';
  ui.render(snapshot(value));
  assert.equal(ui.elements.get('leaderboardTotal').hidden, false);
  assert.equal(total(ui), BigInt(value).toLocaleString());
  assert.equal(ui.elements.get('leaderboardRows').children.length, 1);
  assert.equal(ui.elements.get('leaderboardRows').children[0].children[2].textContent, '17');
});

test('economy-only updates refresh the counter without replacing unchanged leaderboard rows', async () => {
  let value = '1700000'; const ui = harness(() => snapshot(value));
  await ui.load();
  const rows = ui.elements.get('leaderboardRows').children; const firstRow = rows[0];
  value = '1800001'; await ui.load();
  assert.equal(total(ui), BigInt(value).toLocaleString());
  assert.equal(ui.elements.get('leaderboardRows').children, rows);
  assert.equal(ui.elements.get('leaderboardRows').children[0], firstRow);
  assert.equal(ui.elements.get('leaderboardSummary').textContent, '1 of 1 player');
  assert.deepEqual(ui.calls, ['leaderboard', 'leaderboard']);
});

test('loading never invents a total and an empty successful leaderboard displays zero', async () => {
  const response = deferred(); const ui = harness(() => response.promise);
  assert.equal(ui.elements.get('leaderboardTotal').hidden, true); assert.equal(total(ui), '');
  const pending = ui.load(); await tick();
  assert.equal(ui.elements.get('leaderboardTotal').hidden, true); assert.equal(total(ui), '');
  assert.equal(ui.elements.get('leaderboardMessage').textContent, 'Loading leaderboard…');
  response.resolve(snapshot('0', [])); await pending;
  assert.equal(ui.elements.get('leaderboardTotal').hidden, false); assert.equal(total(ui), '0');
  assert.equal(ui.elements.get('leaderboardRows').children.length, 0);
  assert.equal(ui.elements.get('leaderboardSummary').textContent, '0 of 0 players');
  assert.equal(ui.elements.get('leaderboardMessage').textContent, 'No players yet.');
  assert.equal(ui.elements.get('leaderboardRetry').hidden, true);
});

test('missing or malformed totals hide the counter without breaking the player list', () => {
  const ui = harness();
  for (const invalid of [undefined, null, 42, '-1', '1.2', '1e9', 'bad', '<script>1</script>', '']) {
    ui.render(snapshot('29')); assert.equal(total(ui), '29');
    const row = ui.elements.get('leaderboardRows').children[0];
    ui.render(snapshot(invalid));
    assert.equal(ui.elements.get('leaderboardTotal').hidden, true); assert.equal(total(ui), '');
    assert.equal(ui.elements.get('leaderboardRows').children[0], row);
  }
});

test('an initial load error keeps the unknown counter hidden and retry restores it', async () => {
  let fail = true; const ui = harness(() => { if (fail) throw new Error('Offline'); return snapshot('12345'); });
  await ui.load();
  assert.equal(ui.elements.get('leaderboardTotal').hidden, true); assert.equal(total(ui), '');
  assert.equal(ui.elements.get('leaderboardMessage').textContent, 'Leaderboard unavailable. Try again.');
  assert.equal(ui.elements.get('leaderboardRetry').hidden, false);
  fail = false; await ui.load(true);
  assert.equal(ui.elements.get('leaderboardTotal').hidden, false); assert.equal(total(ui), (12345n).toLocaleString());
  assert.equal(ui.elements.get('leaderboardRetry').hidden, true);
});

test('a failed refresh retains the last successful total together with its visible rows', async () => {
  let fail = false; const ui = harness(() => { if (fail) throw new Error('Offline'); return snapshot('2500000'); });
  await ui.load(); const row = ui.elements.get('leaderboardRows').children[0];
  fail = true; await ui.load();
  assert.equal(ui.elements.get('leaderboardTotal').hidden, false); assert.equal(total(ui), (2500000n).toLocaleString());
  assert.equal(ui.elements.get('leaderboardRows').children[0], row);
  assert.equal(ui.elements.get('leaderboardRetry').hidden, false);
});

test('stale leaderboard responses cannot replace a newer economy total', async () => {
  const response = deferred(); const ui = harness(() => response.promise);
  ui.render(snapshot('40'));
  const pending = ui.load(); ui.context.leaderboardRevision++;
  ui.render(snapshot('75')); response.resolve(snapshot('10')); await pending;
  assert.equal(total(ui), '75'); assert.equal(ui.elements.get('leaderboardTotal').hidden, false);
});
