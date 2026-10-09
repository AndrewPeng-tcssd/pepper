const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

// Run the production handlers, using a DOM double and fake network/render boundaries.
// These tests verify async flows rather than duplicating the client implementation.
function balancedEnd(start, opening, closing) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === '\\') index += 1;
        else if (source[index] === quote) break;
      }
    } else if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index);
      if (index < 0) break;
    } else if (char === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2) + 1;
    } else if (char === opening) depth += 1;
    else if (char === closing && --depth === 0) return index;
  }
  throw new Error(`Unclosed source block at ${start}`);
}

function productionFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `Production function ${name} exists`);
  const parameters = source.indexOf('(', match.index);
  const body = source.indexOf('{', balancedEnd(parameters, '(', ')') + 1);
  return source.slice(match.index, balancedEnd(body, '{', '}') + 1);
}

function productionListener(id, event) {
  const start = source.indexOf(`$('${id}').addEventListener('${event}'`);
  assert.ok(start >= 0, `Production ${id} ${event} listener exists`);
  const parameters = source.indexOf('(', source.indexOf('.addEventListener', start));
  return source.slice(start, balancedEnd(parameters, '(', ')') + 1) + ';';
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const account = (username, balance = 20) => ({ username, accountId: `PPR-${crypto.randomUUID().toUpperCase()}`, balance });

function request(sender, recipient, extra = {}) {
  return {
    id: crypto.randomBytes(12).toString('hex'), clientOfferId: crypto.randomUUID(),
    sender: { username: sender.username, accountId: sender.accountId },
    recipient: { username: recipient.username, accountId: recipient.accountId },
    status: 'pending', requestAccepted: false, version: 1,
    offeredTokens: 0, requestedTokens: 0, offeredCards: [], requestedCards: [],
    senderConfirmed: false, recipientConfirmed: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra
  };
}

function harness({ user = account('local_player'), page = 'trading', network, sessionRendering = false } = {}) {
  const elements = new Map();
  const calls = [];
  const opened = [];
  const navigated = [];
  const chatChanges = [];
  let context;
  const element = (id, attributes = '') => {
    const classes = new Set();
    const listeners = new Map();
    return {
      id, value: /\bvalue="([^"]*)"/.exec(attributes)?.[1] || '', hidden: /\bhidden\b/.test(attributes),
      disabled: false, open: false, textContent: '', href: '', dataset: {}, children: [],
      classList: {
        contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
        toggle: (name, enabled) => { if (enabled) classes.add(name); else classes.delete(name); }
      },
      addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) || []), listener]); },
      async dispatch(type) { await Promise.all((listeners.get(type) || []).map(listener => listener({ preventDefault() {}, target: this }))); },
      focus() { document.activeElement = this; },
      reset() { if (id === 'tradingForm') elements.get('tradingRecipient').value = ''; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      closest() { return null; },
      querySelectorAll() { return []; },
      contains(target) { return target === this || this.children.includes(target) || (id === 'tradeNotification' && target?.id?.startsWith('tradeNotification')); },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; }
    };
  };
  for (const match of html.matchAll(/<[a-z][a-z0-9]*\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(match[2], element(match[2], match[1]));
  const document = { getElementById: id => elements.get(id) || null, createElement: tag => element(tag), body: element('body'), activeElement: null, querySelectorAll: () => [], querySelector: () => null };
  const boundary = {
    document, crypto, console, URLSearchParams,
    location: { pathname: page === 'trading' ? '/trading' : '/', search: '' },
    api: async (route, options = {}) => {
      const call = { route, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call);
      const result = network ? await network(call) : undefined;
      if (result !== undefined) return result;
      if (route === 'trades' && call.method === 'GET') return { trades: vm.runInContext('trading.trades || []', context), user: vm.runInContext('state.user', context) };
      throw new Error(`Unexpected network call ${call.method} ${route}`);
    },
    renderTradeLists() {}, renderTradeSession() {}, renderOverviewProfile() {}, renderChangelogEditor() {}, renderAnnouncementEditor() {}, syncPictureSettings() {}, setProfileAvatar() {},
    clearClaimReward() {}, clearChatReply() {}, renderChat() {}, renderProfileDetails() {}, removeTurnstile() {}, renderClaim() {},
    renderLeaderboard() {}, scrollChatToLatest() {}, loadPresence() {},
    isOwnChatMessage: () => false, refreshTradeInventories() {}, loadTradeSession() {}, loadTradeChat() {},
    renderOwnCardPicker() {}, renderTradeChat() {}, unavailableTradeCards: () => [], tradeCardArtwork: () => null,
    tradeCardMetadata: card => { const metadata = element('card'); metadata.textContent = card.name; metadata.dataset.cardId = card.id; return metadata; },
    profileHref: username => `/profile/${username}`, formatProfileDate: value => value || 'Not available',
    setChatOpen: open => { chatChanges.push(open); elements.get('chat').classList.toggle('open', open); },
    focusRouteHeading: () => elements.get(vm.runInContext("pageKind === 'trading'", context) ? 'tradingTitle' : 'overviewTitle').focus(),
    navigateTo: route => {
      navigated.push(route);
      vm.runInContext(`pageKind = ${JSON.stringify(route === '/trading' ? 'trading' : 'home')}; routeRevision++;`, context);
    },
    openTradeSession: (id, trade) => {
      opened.push({ id, trade });
      vm.runInContext('trading.sessionRevision++;', context);
      const trading = vm.runInContext('trading', context);
      trading.sessionId = id; trading.session = trade;
    },
    updateTradeSession: trade => {
      const trading = vm.runInContext('trading', context);
      if (trading.sessionId === trade.id) trading.session = trade;
    }
  };
  context = vm.createContext(boundary);
  const functions = [
    'newTradeInventory', 'message', 'setUser', 'tradingIdentityIsCurrent', 'tradingBusy', 'mergeTradingUser', 'activeTrade',
    'newestTrade', 'rememberTrade', 'syncTradingUser', 'tradeStatusLabel', 'reconcileTradeAction',
    'renderTradeNotification', 'acceptTradeNotification', 'renderTradingState', 'loadTrades',
    'invalidateTradeReview', 'findTradingRecipient', 'finishSendingTrade', 'sendTradingOffer', 'actOnTrade',
    'prefillTradingRecipient', 'renderRoute'
  ];
  if (sessionRendering) functions.push('renderTradeSession', 'renderTradeAssets', 'ownTradeSide', 'partnerTradeSide', 'acceptedTradeRequest', 'tradeButton');
  const prefix = source.slice(0, source.indexOf('\nfunction newTradeInventory'));
  vm.runInContext(prefix + '\n' + functions.map(productionFunction).join('\n') + '\n' + [
    productionListener('tradingRecipient', 'input'), productionListener('tradingForm', 'submit'),
    productionListener('tradeNotificationAccept', 'click'), productionListener('tradeNotificationDismiss', 'click')
  ].join('\n'), context);
  const shared = vm.runInContext('({ state, trading, tradeNotification })', context);
  shared.state.user = user;
  shared.trading.identity = user?.accountId || null;
  context.initialPage = page;
  vm.runInContext('pageKind = initialPage;', context);
  return {
    ...shared, calls, opened, navigated, chatChanges, elements,
    call: (name, ...args) => context[name](...args),
    evaluate: code => vm.runInContext(code, context),
    submit: () => elements.get('tradingForm').dispatch('submit')
  };
}

test('one form submit resolves a username and sends only one empty invitation', async () => {
  const local = account('local_player');
  const partner = account('partner');
  const trade = request(local, partner);
  const ui = harness({ user: local, network: call => {
    if (call.route.startsWith('profiles/')) return { profile: partner };
    if (call.method === 'POST') return { trade: { ...trade, clientOfferId: call.body.clientOfferId }, user: local };
  } });
  ui.elements.get('tradingRecipient').value = '  partner  ';
  await ui.submit();
  const actions = ui.calls.filter(call => call.route.startsWith('profiles/') || call.method === 'POST');
  assert.deepEqual(actions.map(call => [call.method, call.route]), [['GET', 'profiles/partner'], ['POST', 'trades']]);
  assert.equal(actions[1].body.recipientAccountId, partner.accountId);
  assert.match(actions[1].body.clientOfferId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  assert.equal(actions[1].body.offeredTokens ?? 0, 0);
  assert.deepEqual(actions[1].body.offeredCardIds ?? [], []);
  assert.equal(actions[1].body.requestedTokens, undefined);
  assert.equal(actions[1].body.requestedCardIds, undefined);
  assert.equal(ui.opened.length, 1);
  assert.equal(ui.opened[0].trade.status, 'pending');
  assert.equal(ui.trading.sendUncertain, false);
  assert.equal(ui.trading.review, null);
  assert.equal(ui.elements.get('tradingRecipient').value, '');
});

test('double submission during username lookup sends one request and releases the form afterward', async () => {
  const lookup = deferred();
  const local = account('local_player');
  const partner = account('partner');
  const ui = harness({ user: local, network: call => {
    if (call.route.startsWith('profiles/')) return lookup.promise;
    if (call.method === 'POST') return { trade: request(local, partner), user: local };
  } });
  ui.elements.get('tradingRecipient').value = 'partner';
  const first = ui.submit();
  await ui.submit();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.elements.get('tradingSend').disabled, true);
  lookup.resolve({ profile: partner });
  await first;
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(ui.elements.get('tradingSend').disabled, false);
});

test('an uncertain send retries the frozen recipient and UUID without repeating username lookup', async () => {
  const local = account('local_player');
  const partner = account('partner');
  let attempts = 0;
  const ui = harness({ user: local, network: call => {
    if (call.route.startsWith('profiles/')) return { profile: partner };
    if (call.method === 'POST') {
      if (++attempts === 1) throw new Error('Connection interrupted');
      return { trade: request(local, partner, { clientOfferId: call.body.clientOfferId }), user: local };
    }
  } });
  ui.elements.get('tradingRecipient').value = 'partner';
  await ui.submit();
  assert.equal(ui.trading.sendUncertain, true);
  assert.equal(ui.elements.get('tradingRecipient').disabled, true);
  const frozen = plain(ui.trading.review);
  ui.evaluate("location.search = '?to=different_player';");
  ui.call('renderRoute');
  assert.deepEqual(plain(ui.trading.review), frozen);
  assert.equal(ui.elements.get('tradingRecipient').value, partner.username);
  ui.elements.get('tradingRecipient').value = 'different_player';
  await ui.elements.get('tradingRecipient').dispatch('input');
  assert.deepEqual(plain(ui.trading.review), frozen);
  await ui.submit();
  const posts = ui.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(ui.calls.filter(call => call.route.startsWith('profiles/')).length, 1);
  assert.equal(ui.trading.sendUncertain, false);
});

test('navigation or edited input during lookup cannot send a request for the stale username', async () => {
  for (const change of ['navigate', 'edit']) {
    const lookup = deferred();
    const partner = account('partner');
    const ui = harness({ network: call => call.route.startsWith('profiles/') ? lookup.promise : undefined });
    ui.elements.get('tradingRecipient').value = 'partner';
    const submitted = ui.submit();
    if (change === 'navigate') ui.evaluate("pageKind = 'home'; routeRevision++;");
    else { ui.elements.get('tradingRecipient').value = 'new_player'; await ui.elements.get('tradingRecipient').dispatch('input'); }
    lookup.resolve({ profile: partner });
    await submitted;
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(ui.opened.length, 0);
    assert.equal(ui.trading.lookupLoading, false);
  }
});

test('a send that finishes after navigation does not reopen the trading page', async () => {
  const sent = deferred();
  const local = account('local_player');
  const partner = account('partner');
  const ui = harness({ user: local, network: call => {
    if (call.route.startsWith('profiles/')) return { profile: partner };
    if (call.method === 'POST') return sent.promise;
  } });
  ui.elements.get('tradingRecipient').value = 'partner';
  const submitted = ui.submit();
  await tick();
  ui.evaluate("pageKind = 'home'; routeRevision++;");
  sent.resolve({ trade: request(local, partner), user: local });
  await submitted;
  assert.equal(ui.opened.length, 0);
  assert.equal(ui.trading.trades.length, 1);
  assert.equal(ui.trading.sendUncertain, false);
});

test('a profile trade link opens the new recipient form while preserving the previous server trade and chat receipts', async () => {
  const local = account('local_player');
  const previous = request(local, account('previous_player'), { status: 'negotiating', requestAccepted: true });
  const ui = harness({ user: local });
  const outboxEntry = { tradeId: previous.id, clientMessageId: crypto.randomUUID(), body: 'Still pending' };
  Object.assign(ui.trading, { trades: [previous], sessionId: previous.id, session: previous, sessionDraft: { tokens: 10, cards: [], dirty: true }, chatOutbox: [outboxEntry] });
  ui.elements.get('tradingRecipient').value = 'previous_player';
  ui.evaluate("location.search = '?to=new_player';");
  ui.call('renderRoute');
  await tick();
  assert.equal(ui.trading.sessionId, null);
  assert.equal(ui.trading.session, null);
  assert.equal(ui.elements.get('tradingSession').hidden, true);
  assert.equal(ui.elements.get('tradingForm').hidden, false);
  assert.equal(ui.elements.get('tradingRecipient').value, 'new_player');
  assert.equal(ui.trading.trades[0].id, previous.id);
  assert.equal(ui.trading.chatOutbox[0], outboxEntry);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('ordinary Trading navigation preserves the selected session and routine refreshes do not reopen the request form', async () => {
  const local = account('local_player');
  const trade = request(local, account('partner'), { status: 'negotiating', requestAccepted: true });
  const ui = harness({ user: local });
  Object.assign(ui.trading, { trades: [trade], sessionId: trade.id, session: trade });
  ui.call('renderRoute');
  await tick();
  assert.equal(ui.trading.sessionId, trade.id);
  ui.evaluate("location.search = '?to=partner';");
  ui.call('syncTradingUser');
  assert.equal(ui.trading.sessionId, trade.id);
  assert.equal(ui.elements.get('tradingRecipient').value, '');
});

test('switching profile recipients during lookup cannot send the previous username', async () => {
  const lookup = deferred();
  const partner = account('previous_player');
  const ui = harness({ network: call => call.route.startsWith('profiles/') ? lookup.promise : undefined });
  ui.elements.get('tradingRecipient').value = partner.username;
  const submitted = ui.submit();
  ui.evaluate("location.search = '?to=new_player';");
  ui.call('renderRoute');
  lookup.resolve({ profile: partner });
  await submitted;
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(ui.elements.get('tradingRecipient').value, 'new_player');
  assert.equal(ui.trading.lookupLoading, false);
});

test('a profile trade link preserves an unresolved request and recovers the newly selected username after success', async () => {
  const sent = deferred();
  const local = account('local_player');
  const partner = account('previous_player');
  const ui = harness({ user: local, network: call => {
    if (call.route.startsWith('profiles/')) return { profile: partner };
    if (call.method === 'POST') return sent.promise;
  } });
  ui.elements.get('tradingRecipient').value = partner.username;
  const submitted = ui.submit();
  await tick();
  const frozenRequest = plain(ui.trading.review);
  ui.evaluate("location.search = '?to=new_player';");
  ui.call('renderRoute');
  assert.deepEqual(plain(ui.trading.review), frozenRequest);
  assert.equal(ui.elements.get('tradingRecipient').value, partner.username);
  assert.equal(ui.elements.get('tradingRecipient').disabled, true);
  sent.resolve({ trade: request(local, partner, { clientOfferId: frozenRequest.clientOfferId }), user: local });
  await submitted;
  assert.equal(ui.opened.length, 0);
  assert.equal(ui.elements.get('tradingRecipient').value, 'new_player');
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
});

test('global polling shows received pending requests outside Trading and dismissal advances the queue', async () => {
  const local = account('local_player');
  const sender = account('sender');
  const first = request(sender, local, { createdAt: new Date(1000).toISOString() });
  const second = request(sender, local, { createdAt: new Date(2000).toISOString() });
  const outgoing = request(local, sender);
  const joined = request(sender, local, { status: 'negotiating', requestAccepted: true, version: 2 });
  const ui = harness({ user: local, page: 'home', network: call => call.route === 'trades' ? { trades: [second, outgoing, joined, first], user: local } : undefined });
  await ui.call('loadTrades');
  assert.equal(ui.elements.get('tradeNotification').hidden, false);
  assert.equal(ui.tradeNotification.id, first.id);
  assert.equal(ui.elements.get('tradeNotificationCount').textContent, '2 requests waiting');
  await ui.elements.get('tradeNotificationDismiss').dispatch('click');
  assert.equal(ui.tradeNotification.id, second.id);
  await ui.call('loadTrades');
  assert.equal(ui.tradeNotification.id, second.id);
  await ui.elements.get('tradeNotificationDismiss').dispatch('click');
  assert.equal(ui.elements.get('tradeNotification').hidden, true);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('popup acceptance closes mobile chat, joins once, and opens the accepted session', async () => {
  const local = account('local_player');
  const sender = account('sender');
  const trade = request(sender, local);
  const joining = deferred();
  const ui = harness({ user: local, page: 'home', network: call => call.method === 'POST' ? joining.promise : undefined });
  ui.trading.trades = [trade];
  ui.call('renderTradingState');
  const accepting = ui.call('acceptTradeNotification');
  await ui.call('acceptTradeNotification');
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(ui.calls.find(call => call.method === 'POST').route, `trades/${trade.id}/join`);
  assert.deepEqual(ui.chatChanges, [false]);
  assert.deepEqual(ui.navigated, ['/trading']);
  assert.equal(ui.elements.get('tradeNotificationAccept').disabled, true);
  assert.equal(ui.elements.get('tradeNotificationDismiss').disabled, true);
  joining.resolve({ trade: { ...trade, status: 'negotiating', requestAccepted: true, version: 2 }, user: local });
  await accepting;
  await tick();
  assert.equal(ui.trading.sessionId, trade.id);
  assert.equal(ui.trading.session.status, 'negotiating');
  assert.equal(ui.elements.get('tradeNotification').hidden, true);
});

test('popup acceptance preserves a retryable join after connection failure and never sends a different action', async () => {
  const local = account('local_player');
  const sender = account('sender');
  const trade = request(sender, local);
  let attempts = 0;
  const ui = harness({ user: local, page: 'home', network: call => {
    if (call.method === 'POST') {
      if (++attempts === 1) throw new Error('Connection interrupted');
      return { trade: { ...trade, status: 'negotiating', requestAccepted: true, version: 2 }, user: local };
    }
  } });
  ui.trading.trades = [trade];
  ui.call('renderTradingState');
  await ui.call('acceptTradeNotification');
  await tick();
  assert.equal(ui.trading.actionRetry.action, 'join');
  assert.equal(ui.trading.actionRetry.id, trade.id);
  assert.equal(ui.elements.get('tradeNotificationAccept').textContent, 'Retry acceptance');
  assert.equal(ui.elements.get('tradeNotificationAccept').disabled, false);
  await ui.call('acceptTradeNotification');
  await tick();
  assert.equal(ui.trading.actionRetry, null);
  assert.equal(ui.elements.get('tradeNotification').hidden, true);
  assert.deepEqual(ui.calls.filter(call => call.method === 'POST').map(call => call.route), [`trades/${trade.id}/join`, `trades/${trade.id}/join`]);
});

test('old account poll and lookup responses cannot populate a new account or send a stale invitation', async () => {
  const poll = deferred();
  const lookup = deferred();
  const local = account('local_player');
  const other = account('other_player');
  const sender = account('sender');
  const ui = harness({ user: local, page: 'trading', network: call => {
    if (call.route.startsWith('profiles/')) return lookup.promise;
    if (call.route === 'trades' && call.method === 'GET' && ui.calls.filter(item => item.route === 'trades').length === 1) return poll.promise;
  } });
  const polling = ui.call('loadTrades');
  ui.elements.get('tradingRecipient').value = 'sender';
  const submitted = ui.submit();
  ui.call('setUser', other);
  lookup.resolve({ profile: sender });
  poll.resolve({ trades: [request(sender, local)], user: local });
  await Promise.all([polling, submitted]);
  await tick();
  assert.equal(ui.state.user.accountId, other.accountId);
  assert.equal(ui.tradeNotification.id, null);
  assert.equal(ui.elements.get('tradeNotification').hidden, true);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('dismissal or remote cancellation restores focus without stealing focus from an unrelated form', async () => {
  for (const mode of ['dismiss', 'remote', 'unfocused']) {
    const local = account('local_player');
    const ui = harness({ user: local, page: 'home' });
    const trade = request(account('sender'), local);
    ui.trading.trades = [trade];
    ui.call('renderTradingState');
    if (mode === 'dismiss') {
      ui.elements.get('tradeNotificationDismiss').focus();
      await ui.elements.get('tradeNotificationDismiss').dispatch('click');
      assert.equal(ui.evaluate('document.activeElement.id'), 'overviewTitle');
    } else {
      const focused = mode === 'remote' ? 'tradeNotificationAccept' : 'newUsername';
      ui.elements.get(focused).focus();
      ui.elements.get('chat').classList.add('open');
      ui.trading.trades = [{ ...trade, status: 'cancelled' }];
      ui.call('renderTradingState');
      assert.equal(ui.evaluate('document.activeElement.id'), mode === 'remote' ? 'chatClose' : 'newUsername');
    }
    assert.equal(ui.elements.get('tradeNotification').hidden, true);
  }
});

test('popup acceptance finishing after an account switch cannot reopen or populate the old account’s session', async () => {
  const local = account('local_player');
  const other = account('other_player');
  const joining = deferred();
  const trade = request(account('sender'), local);
  const ui = harness({ user: local, page: 'home', network: call => call.method === 'POST' ? joining.promise : undefined });
  ui.trading.trades = [trade];
  ui.call('renderTradingState');
  const accepted = ui.call('acceptTradeNotification');
  ui.call('setUser', other);
  joining.resolve({ trade: { ...trade, status: 'negotiating', version: 2, requestAccepted: true }, user: local });
  await accepted;
  await tick();
  assert.equal(ui.state.user.accountId, other.accountId);
  assert.equal(ui.trading.sessionId, null);
  assert.equal(ui.trading.actionRetry, null);
  assert.equal(ui.tradeNotification.id, null);
  assert.equal(ui.elements.get('tradeNotification').hidden, true);
  assert.ok(!(ui.trading.trades || []).some(item => item.id === trade.id));
});

test('background trade balance refreshes preserve an unsaved Settings username draft', async () => {
  const local = account('local_player');
  const ui = harness({ user: local, page: 'home' });
  ui.elements.get('newUsername').value = 'unsaved_new_name';
  const before = ui.evaluate('authRevision');
  ui.call('mergeTradingUser', { ...local });
  assert.equal(ui.evaluate('authRevision'), before);
  ui.call('mergeTradingUser', { ...local, balance: 31 });
  assert.equal(ui.state.user.balance, 31);
  assert.equal(ui.elements.get('newUsername').value, 'unsaved_new_name');
  assert.equal(ui.elements.get('menuBalance').textContent, '31');
});

function displayedAssets(ui, id) {
  const panel = ui.elements.get(id);
  const cardIds = [];
  const visit = node => { if (node.dataset.cardId) cardIds.push(node.dataset.cardId); node.children.forEach(visit); };
  visit(panel);
  return { tokens: panel.children[0]?.textContent, count: panel.children[1]?.textContent, cardIds };
}

test('each participant sees their own assets first and the other participant’s assets second', () => {
  const sender = account('sender');
  const recipient = account('recipient');
  const senderCard = { id: 'sender-copy', name: 'Jalapeño' };
  const recipientCard = { id: 'recipient-copy', name: 'Habanero' };
  const trade = request(sender, recipient, { status: 'negotiating', requestAccepted: true, offeredTokens: 12, requestedTokens: 38, offeredCards: [senderCard], requestedCards: [recipientCard] });
  for (const [user, partner, ownTokens, ownCard, partnerTokens, partnerCard] of [
    [sender, recipient, 12, senderCard, 38, recipientCard],
    [recipient, sender, 38, recipientCard, 12, senderCard]
  ]) {
    const ui = harness({ user, sessionRendering: true });
    Object.assign(ui.trading, { session: trade, sessionId: trade.id, sessionDraft: { tokens: ownTokens, cards: [ownCard], baseVersion: trade.version, dirty: false } });
    ui.call('renderTradeSession');
    assert.deepEqual(displayedAssets(ui, 'tradingOwnReadonly'), { tokens: `${ownTokens} tokens`, count: '1 card', cardIds: [ownCard.id] });
    assert.deepEqual(displayedAssets(ui, 'tradingPartnerAssets'), { tokens: `${partnerTokens} tokens`, count: '1 card', cardIds: [partnerCard.id] });
    assert.equal(ui.elements.get('tradingSessionTitle').textContent, `Trade with ${partner.username}`);
    assert.equal(ui.elements.get('tradingOwnOffer').hidden, false);
    assert.equal(ui.elements.get('tradingPartnerOffer').hidden, false);
    assert.equal(ui.elements.get('tradingOfferEditor').hidden, false);
  }
});

test('an unsaved own offer previews new assets without inheriting a previous confirmation or changing the partner offer', () => {
  const sender = account('sender');
  const trade = request(sender, account('recipient'), {
    status: 'negotiating', requestAccepted: true, offeredTokens: 12, requestedTokens: 38,
    offeredCards: [{ id: 'old-copy', name: 'Old card' }], requestedCards: [{ id: 'partner-copy', name: 'Partner card' }],
    senderConfirmed: true, recipientConfirmed: true
  });
  const ui = harness({ user: sender, sessionRendering: true });
  Object.assign(ui.trading, { session: trade, sessionId: trade.id, sessionDraft: { tokens: '17', cards: [{ id: 'new-copy', name: 'New card' }], baseVersion: trade.version, dirty: true } });
  ui.call('renderTradeSession');
  assert.deepEqual(displayedAssets(ui, 'tradingOwnReadonly'), { tokens: '17 tokens', count: '1 card', cardIds: ['new-copy'] });
  assert.deepEqual(displayedAssets(ui, 'tradingPartnerAssets'), { tokens: '38 tokens', count: '1 card', cardIds: ['partner-copy'] });
  assert.equal(ui.elements.get('tradingOwnConfirmed').textContent, 'Unsaved changes');
  assert.equal(ui.elements.get('tradingOwnConfirmed').classList.contains('success'), false);
  assert.equal(ui.elements.get('tradingPartnerConfirmed').textContent, 'Confirmed');
  assert.equal(ui.elements.get('tradingPartnerConfirmed').classList.contains('success'), true);
  assert.equal(ui.elements.get('tradingConfirmReview').hidden, true);
  assert.equal(ui.elements.get('tradingConfirmFinal').disabled, true);
});

test('pending requests hide and clear both asset panels and the editor after a previous session', () => {
  const sender = account('sender');
  const recipient = account('recipient');
  const previous = request(sender, recipient, { status: 'negotiating', requestAccepted: true, offeredTokens: 12, requestedTokens: 38 });
  for (const user of [sender, recipient]) {
    const ui = harness({ user, sessionRendering: true });
    Object.assign(ui.trading, { session: previous, sessionId: previous.id, sessionDraft: { tokens: 12, cards: [], baseVersion: previous.version, dirty: false } });
    ui.call('renderTradeSession');
    assert.equal(ui.elements.get('tradingOwnReadonly').children.length, 2);
    const pending = request(sender, recipient);
    Object.assign(ui.trading, { session: pending, sessionId: pending.id, sessionDraft: { tokens: 0, cards: [], baseVersion: pending.version, dirty: false } });
    ui.call('renderTradeSession');
    for (const id of ['tradingOwnOffer', 'tradingPartnerOffer', 'tradingOfferEditor', 'tradingContributionForm', 'tradingPrivateChat']) assert.equal(ui.elements.get(id).hidden, true, `${id} is hidden`);
    for (const id of ['tradingOwnReadonly', 'tradingPartnerAssets', 'tradingSessionCards']) assert.equal(ui.elements.get(id).children.length, 0, `${id} is cleared`);
    assert.equal(ui.elements.get('tradingSessionTokens').value, '0');
  }
});

test('closed trades display persisted assets even when an unsaved draft remains in memory', () => {
  const local = account('local_player');
  for (const status of ['accepted', 'cancelled']) {
    const trade = request(local, account('partner'), {
      status, requestAccepted: true, offeredTokens: 12, requestedTokens: 38,
      offeredCards: [{ id: 'saved-copy', name: 'Saved card' }], requestedCards: []
    });
    const ui = harness({ user: local, sessionRendering: true });
    Object.assign(ui.trading, { session: trade, sessionId: trade.id, sessionDraft: { tokens: 999, cards: [{ id: 'unsaved-copy', name: 'Unsaved card' }], baseVersion: trade.version, dirty: true } });
    ui.call('renderTradeSession');
    assert.deepEqual(displayedAssets(ui, 'tradingOwnReadonly'), { tokens: '12 tokens', count: '1 card', cardIds: ['saved-copy'] });
    assert.deepEqual(displayedAssets(ui, 'tradingPartnerAssets'), { tokens: '38 tokens', count: '0 cards', cardIds: [] });
    assert.equal(ui.elements.get('tradingOfferEditor').hidden, true);
    assert.equal(ui.elements.get('tradingOwnConfirmed').textContent, status === 'accepted' ? 'Completed' : 'Not confirmed');
    assert.equal(ui.elements.get('tradingChatForm').hidden, true);
  }
});

test('invalid token drafts stay visibly invalid rather than appearing as an offered amount', () => {
  const local = account('local_player');
  const trade = request(local, account('partner'), { status: 'negotiating', requestAccepted: true });
  const ui = harness({ user: local, sessionRendering: true });
  for (const tokens of ['-2', '1.5', 'invalid']) {
    Object.assign(ui.trading, { session: trade, sessionId: trade.id, sessionDraft: { tokens, cards: [], baseVersion: trade.version, dirty: true } });
    ui.call('renderTradeSession');
    assert.deepEqual(displayedAssets(ui, 'tradingOwnReadonly'), { tokens: '— tokens', count: '0 cards', cardIds: [] });
  }
});
