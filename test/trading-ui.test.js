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

function harness({ user = account('local_player'), page = 'trading', network, sessionRendering = false, claimRendering = false } = {}) {
  const elements = new Map();
  const calls = [];
  const opened = [];
  const navigated = [];
  const chatChanges = [];
  const playerPickers = [];
  const verification = { renders: [], removed: [], resets: [] };
  const timers = new Map(); let timerId = 0, clock = Date.now();
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
      async dispatch(type, target = this) { await Promise.all((listeners.get(type) || []).map(listener => listener({ preventDefault() {}, target }))); },
      focus() { document.activeElement = this; },
      reset() { if (id === 'tradingForm') elements.get('tradingRecipient').value = ''; },
      replaceChildren(...children) { this.children = children; },
      append(...children) {
        for (const child of children) {
          child.remove?.(); child.parentNode = this; this.children.push(child);
        }
      },
      before(...children) {
        for (const child of children) {
          child.remove?.(); child.parentNode = this.parentNode;
          this.parentNode.children.splice(this.parentNode.children.indexOf(this), 0, child);
        }
      },
      remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
      },
      closest() { return null; },
      querySelector(selector) { return id === 'claimForm' && selector === 'button' ? claimButton : selector === 'iframe' ? this.children.find(child => child.id === 'iframe') : null; },
      querySelectorAll() { return []; },
      contains(target) { return target === this || this.children.includes(target) || (id === 'tradeNotification' && target?.id?.startsWith('tradeNotification')); },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; }
    };
  };
  for (const match of html.matchAll(/<[a-z][a-z0-9]*\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(match[2], element(match[2], match[1]));
  const claimButton = element('claim-button');
  element('main').append(elements.get('tokens'), elements.get('packsPage'));
  const document = { getElementById: id => elements.get(id) || null, createElement: tag => element(tag), body: element('body'), activeElement: null, querySelectorAll: () => [], querySelector: () => null };
  const boundary = {
    document, crypto, console, URLSearchParams, Date: class extends Date { static now() { return clock; } }, window: { setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; }, clearTimeout(id) { timers.delete(id); }, PepperPlayerPicker: {
      attach(settings) { const picker = { closed: 0, close() { this.closed++; }, reset() { this.closed++; } }; playerPickers.push({ settings, picker }); return picker; },
      closeAll() { playerPickers.forEach(({ picker }) => picker.reset()); }
    }, matchMedia: () => ({ matches: false }), turnstile: {
      render(selector, settings) {
        verification.renders.push({ selector, settings });
        elements.get('turnstileWidget').append(element('iframe'));
        return 'claim-verification';
      },
      remove(id) { verification.removed.push(id); elements.get('turnstileWidget').replaceChildren(); },
      reset(id) { verification.resets.push(id); }
    } },
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
    clearClaimReward() {}, clearChatReply() {}, resetChatSending() {}, renderChat() {}, renderProfileDetails() {}, removeTurnstile() {}, renderClaim() {},
    renderLeaderboard() {}, scrollChatToLatest() {}, loadPresence() {},
    loadProfile() {}, loadLeaderboard() {}, revealClaimReward: async () => true,
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
    'accountRole', 'playerRoleBadges', 'claimRouteVisible', 'isOwnProfile', 'routeProfileUsername',
    'newTradeInventory', 'message', 'setUser', 'tradingIdentityIsCurrent', 'tradingBusy', 'mergeTradingUser', 'activeTrade',
    'newestTrade', 'rememberTrade', 'syncTradingUser', 'tradeStatusLabel', 'reconcileTradeAction',
    'renderTradeNotification', 'acceptTradeNotification', 'declineTradeNotification', 'renderTradingState', 'loadTrades',
    'invalidateTradeReview', 'findTradingRecipient', 'finishSendingTrade', 'sendTradingOffer', 'actOnTrade',
    'prefillTradingRecipient', 'renderRoute', 'setupTradingPlayerPicker', 'cancelTradeAutosave', 'syncTradeAutosaveRoute', 'scheduleTradeAutosave'
  ];
  if (claimRendering) functions.push('formatTime', 'renderClaim', 'setClaimToken', 'removeTurnstile', 'resetTurnstile', 'loadTurnstileScript', 'loadTurnstile');
  if (sessionRendering) functions.push('renderTradeSession', 'renderTradeAssets', 'ownTradeSide', 'partnerTradeSide', 'acceptedTradeRequest', 'tradeButton', 'tradeCardSnapshot', 'newSessionDraft', 'sameContribution', 'updateTradeSession', 'tradeDraftPayload', 'validateTradeDraft', 'changeTradeDraft', 'saveTradeContribution', 'unavailableTradeCards', 'openTradeSession');
  const prefix = source.slice(0, source.indexOf('\nfunction newTradeInventory'));
  vm.runInContext(prefix + '\n' + functions.map(productionFunction).join('\n') + '\n' + [
    productionListener('tradingRecipient', 'input'), productionListener('tradingForm', 'submit'),
    productionListener('tradeNotificationAccept', 'click'), productionListener('tradeNotificationDecline', 'click')
  ].join('\n'), context);
  if (sessionRendering) vm.runInContext(productionListener('tradingSessionTokens', 'input') + productionListener('tradingConfirmFinal', 'click') + source.slice(source.indexOf("for (const containerId of ['tradingSessionCards'])"), source.indexOf('\nfunction renderTradeChat')), context);
  if (claimRendering) vm.runInContext(productionListener('claimForm', 'submit'), context);
  const shared = vm.runInContext('({ state, trading, tradeNotification, tradeAutosave, tradeInventories })', context);
  shared.state.user = user;
  shared.trading.identity = user?.accountId || null;
  context.initialPage = page;
  vm.runInContext('pageKind = initialPage;', context);
  context.setupTradingPlayerPicker();
  return {
    ...shared, calls, opened, navigated, chatChanges, elements, playerPickers, verification, claimButton,
    call: (name, ...args) => context[name](...args),
    evaluate: code => vm.runInContext(code, context),
    async advance(milliseconds) {
      clock += milliseconds;
      for (let count = 0; count < 100; count++) {
        const due = [...timers].find(([, timer]) => timer.at <= clock); if (!due) return;
        timers.delete(due[0]); due[1].callback(); await tick();
      }
      throw new Error('Too many queued timers');
    },
    submit: () => elements.get('tradingForm').dispatch('submit')
  };
}

test('Overview claims update the shared balance and hourly cooldown', async () => {
  const local = account('local_player');
  const ui = harness({ user: local, page: 'home', claimRendering: true, network: call => {
    if (call.route === 'turnstile-config') return { siteKey: 'preview-key' };
    if (call.route === 'claim') return { awarded: 15, user: { ...local, balance: 35, lastClaimAt: Date.now(), nextClaimAt: Date.now() + 3600000 } };
  } });
  ui.call('renderRoute');
  await tick();
  assert.equal(ui.elements.get('tokens').parentNode, ui.elements.get('overviewClaimSlot'));
  assert.equal(ui.elements.get('tokens').hidden, false);
  assert.equal(ui.elements.get('tokensTitle').textContent, 'Hourly claim');
  assert.equal(ui.verification.renders.length, 1);
  ui.verification.renders[0].settings.callback('verified-token');
  assert.equal(ui.claimButton.disabled, false);
  await ui.elements.get('claimForm').dispatch('submit');
  assert.equal(ui.calls.filter(call => call.route === 'claim').length, 1);
  assert.equal(ui.state.user.balance, 35);
  assert.equal(ui.elements.get('accountBalance').textContent, '35');
  assert.equal(ui.elements.get('claimReady').hidden, true);
  assert.equal(ui.elements.get('claimCooldown').hidden, false);
  assert.equal(ui.elements.get('claimTitle').textContent, 'Next claim');
  assert.equal(ui.claimButton.disabled, true);
});

test('the shared claim refreshes verification when moving and stays hidden on other profiles', async () => {
  const local = account('local_player');
  const ui = harness({ user: local, page: 'home', claimRendering: true, network: call => call.route === 'turnstile-config' ? { siteKey: 'preview-key' } : undefined });
  ui.call('renderRoute');
  await tick();
  const claim = ui.elements.get('tokens');
  const oldVerification = ui.verification.renders[0].settings;
  oldVerification.callback('old-token');
  ui.evaluate("location.pathname = '/profile';");
  ui.call('renderRoute');
  await tick();
  assert.equal(claim.parentNode, ui.elements.get('packsPage').parentNode);
  assert.equal(claim.hidden, false);
  assert.equal(ui.verification.removed.length, 1);
  assert.equal(ui.verification.renders.length, 2);
  assert.equal(ui.state.turnstileToken, null);
  oldVerification.callback('stale-token');
  assert.equal(ui.state.turnstileToken, null);
  ui.verification.renders[1].settings.callback('current-token');
  assert.equal(ui.state.turnstileToken, 'current-token');
  ui.call('renderRoute');
  await tick();
  assert.equal(ui.verification.renders.length, 2);
  ui.evaluate("location.pathname = '/profile/other_player';");
  ui.call('renderRoute');
  ui.state.profile = { ...account('other_player'), nextClaimAt: 0 };
  ui.call('renderClaim');
  await ui.call('loadTurnstile');
  await ui.elements.get('claimForm').dispatch('submit');
  assert.equal(claim.hidden, true);
  assert.equal(ui.elements.get('profileNextClaim').textContent, 'Ready now');
  assert.equal(ui.state.turnstileToken, null);
  assert.equal(ui.claimButton.disabled, true);
  assert.equal(ui.verification.renders.length, 2);
  assert.equal(ui.calls.filter(call => call.route === 'claim').length, 0);
});

test('verification requested from Overview cannot finish after navigating to a public profile', async () => {
  const config = deferred();
  const ui = harness({ page: 'home', claimRendering: true, network: call => call.route === 'turnstile-config' ? config.promise : undefined });
  ui.call('renderRoute');
  ui.evaluate("location.pathname = '/profile/other_player';");
  ui.call('renderRoute');
  config.resolve({ siteKey: 'preview-key' });
  await tick();
  assert.equal(ui.verification.renders.length, 0);
  assert.equal(ui.state.turnstileWidgetId, null);
  assert.equal(ui.elements.get('tokens').hidden, true);
});

test('trading suggestions select a username without sending a request or retaining old recipient terms', async () => {
  const partner = account('example');
  const ui = harness({ network: call => call.route.startsWith('players?') ? { players: [partner] } : undefined });
  const { settings } = ui.playerPickers[0];
  assert.equal(settings.input, ui.elements.get('tradingRecipient'));
  assert.equal(settings.isEnabled(), true);
  assert.deepEqual(plain(await settings.search('ex')), [partner]);
  assert.equal(ui.calls.at(-1).route, 'players?username=ex');
  ui.trading.review = { recipient: account('previous') }; ui.trading.recipient = account('previous');
  settings.input.value = partner.username; settings.onSelect(partner);
  assert.equal(settings.input.value, 'example');
  assert.equal(ui.trading.review, null); assert.equal(ui.trading.recipient, null);
  assert.equal(ui.calls.filter(call => call.method !== 'GET').length, 0);
});

test('trading ignores suggestion replies after navigation or account changes and closes disabled pickers', async () => {
  const response = deferred();
  const ui = harness({ network: call => call.route.startsWith('players?') ? response.promise : undefined });
  const { settings, picker } = ui.playerPickers[0];
  const pending = settings.search('ex');
  ui.evaluate("pageKind = 'games'; routeRevision++;");
  response.resolve({ players: [account('example')] });
  assert.deepEqual(plain(await pending), []);
  assert.equal(settings.isEnabled(), false);
  ui.evaluate("pageKind = 'trading';");
  ui.trading.submitting = true; ui.call('renderTradingState');
  assert.equal(settings.isEnabled(), false); assert.ok(picker.closed > 0);
  ui.trading.submitting = false;
  ui.call('setUser', null);
  assert.equal(settings.isEnabled(), false);
});

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

test('declining popup requests persists, advances the queue, and stays declined after a fresh page load', async () => {
  const local = account('local_player');
  const sender = account('sender');
  const first = request(sender, local, { createdAt: new Date(1000).toISOString() });
  const second = request(sender, local, { createdAt: new Date(2000).toISOString() });
  const outgoing = request(local, sender);
  const joined = request(sender, local, { status: 'negotiating', requestAccepted: true, version: 2 });
  let savedTrades = [second, outgoing, joined, first];
  const network = call => {
    if (call.route === 'trades') return { trades: savedTrades, user: local };
    if (call.method === 'POST' && call.route.endsWith('/decline')) {
      const id = call.route.split('/')[1];
      const trade = { ...savedTrades.find(item => item.id === id), status: 'declined' };
      savedTrades = savedTrades.map(item => item.id === id ? trade : item);
      return { trade, user: local };
    }
  };
  const ui = harness({ user: local, page: 'home', network });
  await ui.call('loadTrades');
  assert.equal(ui.elements.get('tradeNotification').hidden, false);
  assert.equal(ui.tradeNotification.id, first.id);
  assert.equal(ui.elements.get('tradeNotificationCount').textContent, '2 requests waiting');
  await ui.elements.get('tradeNotificationDecline').dispatch('click');
  await tick();
  assert.equal(ui.tradeNotification.id, second.id);
  assert.equal(savedTrades.find(trade => trade.id === first.id).status, 'declined');
  await ui.call('loadTrades');
  assert.equal(ui.tradeNotification.id, second.id);
  await ui.call('declineTradeNotification');
  await tick();
  assert.equal(ui.elements.get('tradeNotification').hidden, true);
  assert.deepEqual(ui.calls.filter(call => call.method === 'POST').map(call => call.route), [`trades/${first.id}/decline`, `trades/${second.id}/decline`]);
  assert.deepEqual(ui.navigated, []);
  assert.deepEqual(ui.opened, []);
  assert.deepEqual(ui.chatChanges, []);
  const fresh = harness({ user: local, page: 'home', network });
  await fresh.call('loadTrades');
  assert.equal(fresh.elements.get('tradeNotification').hidden, true);
  assert.equal(fresh.tradeNotification.id, null);
});

test('popup decline sends once, disables acceptance, and rejects stale pending responses', async () => {
  const local = account('local_player');
  const trade = request(account('sender'), local);
  const declining = deferred();
  const ui = harness({ user: local, page: 'home', network: call => {
    if (call.method === 'POST') return declining.promise;
    if (call.route === 'trades') return { trades: [trade], user: local };
  } });
  ui.trading.trades = [trade];
  ui.call('renderTradingState');
  const declined = ui.call('declineTradeNotification');
  await ui.call('declineTradeNotification');
  await ui.call('acceptTradeNotification');
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(ui.elements.get('tradeNotificationAccept').disabled, true);
  assert.equal(ui.elements.get('tradeNotificationDecline').disabled, true);
  declining.resolve({ trade: { ...trade, status: 'declined' }, user: local });
  await declined;
  await tick();
  await ui.call('loadTrades');
  assert.equal(ui.trading.trades[0].status, 'declined');
  assert.equal(ui.elements.get('tradeNotification').hidden, true);
  assert.deepEqual(ui.navigated, []);
});

test('popup decline retries an uncertain outcome without allowing acceptance instead', async () => {
  const local = account('local_player');
  const trade = request(account('sender'), local);
  let attempts = 0;
  const ui = harness({ user: local, page: 'home', network: call => {
    if (call.method === 'POST') {
      if (++attempts === 1) throw new Error('Connection interrupted');
      return { trade: { ...trade, status: 'declined' }, user: local };
    }
  } });
  ui.trading.trades = [trade];
  ui.call('renderTradingState');
  await ui.call('declineTradeNotification');
  await tick();
  assert.equal(ui.trading.actionRetry.action, 'decline');
  assert.equal(ui.trading.actionRetry.id, trade.id);
  assert.equal(ui.elements.get('tradeNotification').hidden, false);
  assert.equal(ui.elements.get('tradeNotificationDecline').textContent, 'Retry decline');
  assert.equal(ui.elements.get('tradeNotificationMessage').textContent, 'Connection lost. Retry decline.');
  assert.equal(ui.elements.get('tradeNotificationDecline').disabled, false);
  assert.equal(ui.elements.get('tradeNotificationAccept').disabled, true);
  await ui.call('acceptTradeNotification');
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
  await ui.call('declineTradeNotification');
  await tick();
  assert.equal(ui.trading.actionRetry, null);
  assert.equal(ui.elements.get('tradeNotification').hidden, true);
  assert.deepEqual(ui.calls.filter(call => call.method === 'POST').map(call => call.route), [`trades/${trade.id}/decline`, `trades/${trade.id}/decline`]);
});

test('polling recovers a saved decline whose response was lost', async () => {
  const local = account('local_player');
  const trade = request(account('sender'), local);
  let saved = trade;
  const ui = harness({ user: local, page: 'home', network: call => {
    if (call.method === 'POST') {
      saved = { ...trade, status: 'declined' };
      throw new Error('Response lost');
    }
    if (call.route === 'trades') return { trades: [saved], user: local };
  } });
  ui.trading.trades = [trade];
  ui.call('renderTradingState');
  await ui.call('declineTradeNotification');
  await tick();
  assert.equal(ui.trading.actionRetry, null);
  assert.equal(ui.elements.get('tradeNotification').hidden, true);
  assert.equal(ui.trading.trades[0].status, 'declined');
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
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
  assert.equal(ui.elements.get('tradeNotificationDecline').disabled, true);
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
  assert.equal(ui.elements.get('tradeNotificationDecline').disabled, true);
  await ui.call('declineTradeNotification');
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 1);
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

test('decline or remote cancellation restores focus without stealing focus from an unrelated form', async () => {
  for (const mode of ['decline', 'remote', 'unfocused']) {
    const local = account('local_player');
    const trade = request(account('sender'), local);
    const ui = harness({ user: local, page: 'home', network: call => call.method === 'POST' ? { trade: { ...trade, status: 'declined' }, user: local } : undefined });
    ui.trading.trades = [trade];
    ui.call('renderTradingState');
    if (mode === 'decline') {
      ui.elements.get('tradeNotificationDecline').focus();
      await ui.call('declineTradeNotification');
      await tick();
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

test('popup decline finishing after an account switch cannot affect the new account', async () => {
  const local = account('local_player');
  const other = account('other_player');
  const declining = deferred();
  const trade = request(account('sender'), local);
  const otherRequest = request(account('other_sender'), other);
  const ui = harness({ user: local, page: 'home', network: call => call.method === 'POST' ? declining.promise : undefined });
  ui.trading.trades = [trade];
  ui.call('renderTradingState');
  const declined = ui.call('declineTradeNotification');
  ui.call('setUser', other);
  await tick();
  ui.trading.trades = [otherRequest];
  ui.call('renderTradingState');
  declining.resolve({ trade: { ...trade, status: 'declined' }, user: local });
  await declined;
  await tick();
  assert.equal(ui.state.user.accountId, other.accountId);
  assert.equal(ui.trading.actionRetry, null);
  assert.equal(ui.tradeNotification.id, otherRequest.id);
  assert.equal(ui.elements.get('tradeNotification').hidden, false);
  assert.ok(!ui.trading.trades.some(item => item.id === trade.id));
  assert.deepEqual(ui.navigated, []);
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
  assert.equal(ui.elements.get('accountBalance').textContent, '31');
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

function assertEmptyCardArea(ui, id) {
  const panel = ui.elements.get(id);
  const list = panel.children[2];
  assert.equal(list?.className, 'trading-asset-cards', `${id} retains a cards area`);
  assert.equal(list['aria-label'], 'Cards');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].className, 'trading-asset-empty');
  assert.equal(list.children[0].textContent, 'None');
}

test('both players see a None cards area in an empty joined trade before confirming', () => {
  const sender = account('sender');
  const recipient = account('recipient');
  const trade = request(sender, recipient, { status: 'negotiating', requestAccepted: true, version: 2 });
  for (const user of [sender, recipient]) {
    const ui = harness({ user, sessionRendering: true });
    Object.assign(ui.trading, { session: trade, sessionId: trade.id, sessionDraft: { tokens: 0, cards: [], baseVersion: trade.version, dirty: false } });
    ui.call('renderTradeSession');
    for (const id of ['tradingOwnReadonly', 'tradingPartnerAssets']) {
      assert.deepEqual(displayedAssets(ui, id), { tokens: '0 tokens', count: '0 cards', cardIds: [] });
      assertEmptyCardArea(ui, id);
    }
    assert.equal(ui.elements.get('tradingPartnerOffer').hidden, false);
    assert.equal(ui.elements.get('tradingPartnerConfirmed').textContent, 'Not confirmed');
  }
});

test('partner card additions and removals update the visible area while preserving either player’s unsaved offer', () => {
  const sender = account('sender');
  const recipient = account('recipient');
  const trade = request(sender, recipient, { status: 'negotiating', requestAccepted: true, version: 2 });
  const partnerCard = { id: 'partner-copy', name: 'Partner card' };
  for (const user of [sender, recipient]) {
    const ui = harness({ user, sessionRendering: true });
    const draft = { tokens: '17', cards: [{ id: 'unsaved-copy', name: 'Unsaved card' }], baseVersion: trade.version, dirty: true };
    Object.assign(ui.trading, { session: trade, sessionId: trade.id, sessionDraft: draft });
    ui.call('renderTradeSession');
    assertEmptyCardArea(ui, 'tradingPartnerAssets');
    const partnerCardsField = user === sender ? 'requestedCards' : 'offeredCards';
    const partnerTokensField = user === sender ? 'requestedTokens' : 'offeredTokens';
    const added = { ...trade, version: 3, [partnerCardsField]: [partnerCard], [partnerTokensField]: 9 };
    ui.call('updateTradeSession', added);
    assert.deepEqual(displayedAssets(ui, 'tradingPartnerAssets'), { tokens: '9 tokens', count: '1 card', cardIds: [partnerCard.id] });
    assert.equal(ui.elements.get('tradingPartnerAssets').children[2].children[0].className === 'trading-asset-empty', false);
    assert.equal(ui.trading.sessionDraft, draft);
    assert.deepEqual(displayedAssets(ui, 'tradingOwnReadonly'), { tokens: '17 tokens', count: '1 card', cardIds: ['unsaved-copy'] });
    assert.equal(ui.elements.get('tradingPartnerConfirmed').textContent, 'Not confirmed');
    ui.call('updateTradeSession', { ...added, version: 4, [partnerCardsField]: [] });
    assert.deepEqual(displayedAssets(ui, 'tradingPartnerAssets'), { tokens: '9 tokens', count: '0 cards', cardIds: [] });
    assertEmptyCardArea(ui, 'tradingPartnerAssets');
    assert.equal(ui.trading.sessionDraft, draft);
    assert.deepEqual(displayedAssets(ui, 'tradingOwnReadonly'), { tokens: '17 tokens', count: '1 card', cardIds: ['unsaved-copy'] });
  }
});

test('an older trade poll cannot replace the partner’s latest cards with an empty area', async () => {
  const local = account('local_player');
  const previous = request(local, account('partner'), { status: 'negotiating', requestAccepted: true, version: 2 });
  const current = { ...previous, version: 3, requestedCards: [{ id: 'latest-copy', name: 'Latest card' }] };
  const ui = harness({ user: local, sessionRendering: true, network: call => call.route === 'trades' ? { trades: [previous], user: local } : undefined });
  Object.assign(ui.trading, { trades: [current], session: current, sessionId: current.id, sessionDraft: { tokens: 0, cards: [], baseVersion: current.version, dirty: false } });
  ui.call('renderTradeSession');
  await ui.call('loadTrades');
  assert.equal(ui.trading.session.version, current.version);
  assert.deepEqual(displayedAssets(ui, 'tradingPartnerAssets'), { tokens: '0 tokens', count: '1 card', cardIds: ['latest-copy'] });
  assert.equal(ui.elements.get('tradingPartnerOffer').hidden, false);
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
  assert.equal(ui.elements.get('tradingOwnConfirmed').textContent, 'Updating…');
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
    assert.equal(ui.elements.get('tradingOwnReadonly').children.length, 3);
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

function autosaveHarness({ recipient = false, intercept } = {}) {
  const local = account('local_player', 100), partner = account('partner', 100);
  const server = { saved: request(recipient ? partner : local, recipient ? local : partner, { status: 'negotiating', requestAccepted: true, version: 2 }) };
  server.commit = payload => {
    if (payload.version !== server.saved.version) throw Object.assign(new Error('Offers changed.'), { status: 409, user: local });
    server.saved = { ...server.saved, [recipient ? 'requestedTokens' : 'offeredTokens']: payload.tokens,
      [recipient ? 'requestedCards' : 'offeredCards']: payload.cardIds.map(id => ({ id, name: id })),
      senderConfirmed: false, recipientConfirmed: false, version: server.saved.version + 1 };
    return { trade: server.saved, user: local };
  };
  const ui = harness({ user: local, sessionRendering: true, network: async call => {
    const result = intercept ? await intercept(call, server, local) : undefined;
    if (result !== undefined) return result;
    if (call.method === 'POST' && call.route.endsWith('/contribution')) return server.commit(call.body);
    if (call.method === 'GET' && call.route === `trades/${server.saved.id}`) return { trade: server.saved, user: local };
  } });
  Object.assign(ui.trading, { sessionId: server.saved.id, session: server.saved, sessionDraft: ui.call('newSessionDraft', server.saved) });
  ui.call('renderTradeSession');
  const input = async tokens => { ui.elements.get('tradingSessionTokens').value = String(tokens); await ui.elements.get('tradingSessionTokens').dispatch('input'); };
  const posts = () => ui.calls.filter(call => call.method === 'POST' && call.route.endsWith('/contribution'));
  return { ...ui, local, partner, server, input, posts };
}

test('trade token edits debounce automatically, allow zero, and never send a confirmation', async () => {
  for (const recipient of [false, true]) {
    const ui = autosaveHarness({ recipient });
    await ui.input(1); await ui.input(12); await ui.input(17);
    assert.equal(ui.elements.get('tradingConfirmFinal').disabled, true);
    await ui.advance(249); assert.equal(ui.posts().length, 0);
    await ui.advance(1); assert.equal(ui.posts().length, 1);
    assert.equal(ui.posts()[0].body.tokens, 17); assert.equal(ui.trading.sessionDraft.dirty, false);
    assert.equal(ui.elements.get('tradingDraftMessage').textContent, 'Updated');
    await ui.input(0); await ui.advance(250);
    assert.equal(ui.posts().length, 2); assert.equal(ui.posts()[1].body.tokens, 0);
    assert.ok(ui.calls.every(call => !call.route.endsWith('/confirm')));
  }
});

test('card and token edits remain editable in flight and coalesce into the newest offer', async () => {
  const pending = deferred(); let attempts = 0;
  const ui = autosaveHarness({ intercept: (call, server) => {
    if (call.method === 'POST' && ++attempts === 1) return pending.promise.then(() => server.commit(call.body));
  } });
  ui.tradeInventories.offered.cards = [{ id: 'card-a', name: 'Card A' }, { id: 'card-b', name: 'Card B' }];
  await ui.input(1); await ui.advance(250);
  assert.equal(ui.posts().length, 1); assert.equal(ui.elements.get('tradingSessionTokens').disabled, false);
  await ui.input(7);
  const checkbox = { disabled: false, checked: true, dataset: { cardId: 'card-b' }, closest() { return this; } };
  await ui.elements.get('tradingSessionCards').dispatch('change', checkbox);
  await ui.advance(250); assert.equal(ui.posts().length, 1);
  pending.resolve(); await tick();
  assert.equal(ui.trading.sessionDraft.tokens, '7'); assert.equal(ui.trading.sessionDraft.dirty, true);
  assert.deepEqual(plain(ui.trading.sessionDraft.cards.map(card => card.id)), ['card-b']);
  assert.equal(ui.elements.get('tradingConfirmFinal').disabled, true);
  await ui.advance(250);
  assert.equal(ui.posts().length, 2); assert.equal(ui.posts()[1].body.tokens, 7);
  assert.deepEqual(ui.posts()[1].body.cardIds, ['card-b']); assert.equal(ui.posts()[1].body.version, 3);
  assert.equal(ui.trading.sessionDraft.dirty, false); assert.equal(ui.server.saved.offeredTokens, 7);
});

test('partner edits automatically rebase a conflicting autosave without losing either offer', async () => {
  const ui = autosaveHarness();
  await ui.input(9);
  ui.server.saved = { ...ui.server.saved, requestedTokens: 4, requestedCards: [{ id: 'partner-copy', name: 'Partner card' }], version: 3 };
  await ui.advance(250);
  assert.equal(ui.posts().length, 1); assert.equal(ui.trading.sessionDraft.tokens, '9');
  assert.equal(ui.trading.sessionDraft.baseVersion, 3); assert.equal(ui.trading.sessionDraft.dirty, true);
  assert.deepEqual(displayedAssets(ui, 'tradingPartnerAssets'), { tokens: '4 tokens', count: '1 card', cardIds: ['partner-copy'] });
  await ui.advance(250);
  assert.equal(ui.posts().length, 2); assert.equal(ui.posts()[1].body.version, 3);
  assert.equal(ui.trading.sessionDraft.dirty, false); assert.equal(ui.server.saved.offeredTokens, 9);
  assert.equal(ui.server.saved.requestedTokens, 4);
});

test('rate limited autosaves wait automatically and send the latest draft after Retry-After', async () => {
  let attempts = 0;
  const ui = autosaveHarness({ intercept: call => {
    if (call.method === 'POST' && ++attempts === 1) throw Object.assign(new Error('Too fast.'), { status: 429, retryAfterMs: 900 });
  } });
  await ui.input(5); await ui.advance(250);
  assert.equal(ui.elements.get('tradingDraftMessage').textContent, 'Waiting…');
  assert.equal(ui.trading.sessionDraft.dirty, true); assert.equal(ui.trading.actionRetry, null);
  await ui.input(8); await ui.advance(899); assert.equal(ui.posts().length, 1);
  await ui.advance(1); assert.equal(ui.posts().length, 2); assert.equal(ui.posts()[1].body.tokens, 8);
  assert.equal(ui.trading.sessionDraft.dirty, false);
});

test('an uncertain autosave recovers a committed result or retries automatically when uncommitted', async () => {
  for (const committed of [false, true]) {
    let attempts = 0;
    const ui = autosaveHarness({ intercept: (call, server) => {
      if (call.method === 'POST' && ++attempts === 1) { if (committed) server.commit(call.body); throw new Error('Connection lost'); }
    } });
    await ui.input(6); await ui.advance(250);
    assert.equal(ui.trading.actionRetry, null);
    if (committed) { assert.equal(ui.trading.sessionDraft.dirty, false); assert.equal(ui.posts().length, 1); }
    else { assert.equal(ui.trading.sessionDraft.dirty, true); await ui.advance(1000); assert.equal(ui.posts().length, 2); assert.equal(ui.trading.sessionDraft.dirty, false); }
    assert.equal(ui.server.saved.offeredTokens, 6);
  }
});

test('invalid trade token drafts stay local and block confirmation until corrected', async () => {
  const ui = autosaveHarness();
  for (const tokens of ['', '-1', '1.5', 'NaN', '101', '9007199254740992']) {
    await ui.input(tokens); await ui.advance(2000);
    assert.equal(ui.posts().length, 0); assert.ok(ui.trading.sessionDraft.error);
    assert.equal(ui.elements.get('tradingConfirmFinal').disabled, true);
  }
  await ui.input(2); await ui.advance(250); assert.equal(ui.posts().length, 1); assert.equal(ui.trading.sessionDraft.error, null);
});

test('navigation pauses pending autosaves and account changes discard old queued work', async () => {
  const ui = autosaveHarness();
  await ui.input(3); ui.evaluate("pageKind = 'games'; routeRevision++;"); ui.call('syncTradeAutosaveRoute');
  await ui.advance(2000); assert.equal(ui.posts().length, 0);
  ui.evaluate("pageKind = 'trading'; routeRevision++;"); ui.call('syncTradeAutosaveRoute');
  await ui.advance(250); assert.equal(ui.posts().length, 1);
  await ui.input(4); ui.call('setUser', account('next_account', 100));
  await ui.advance(2000); assert.equal(ui.posts().length, 1); assert.equal(ui.trading.sessionDraft, null);
});

test('closed trades cancel queued changes and ignore stale autosave responses', async () => {
  const pending = deferred();
  const ui = autosaveHarness({ intercept: call => call.method === 'POST' ? pending.promise : undefined });
  await ui.input(7); await ui.advance(250); await ui.input(8);
  const closed = { ...ui.server.saved, status: 'accepted', offeredTokens: 7, version: 5 };
  ui.call('updateTradeSession', closed);
  pending.resolve({ trade: { ...ui.server.saved, offeredTokens: 7, version: 3 }, user: ui.local }); await tick();
  await ui.advance(2000);
  assert.equal(ui.posts().length, 1); assert.equal(ui.trading.session.status, 'accepted');
  assert.equal(ui.trading.sessionDraft.dirty, false); assert.equal(ui.trading.sessionDraft.tokens, 7);
  assert.equal(ui.elements.get('tradingContributionForm').hidden, true);
});

test('returning after an in-flight update refreshes before restoring a newer reverted offer', async () => {
  const pending = deferred(); let attempts = 0;
  const ui = autosaveHarness({ intercept: (call, server) => {
    if (call.method === 'POST' && ++attempts === 1) return pending.promise.then(() => server.commit(call.body));
  } });
  await ui.input(7); await ui.advance(250); await ui.input(0);
  ui.evaluate("pageKind = 'games'; routeRevision++;"); ui.call('syncTradeAutosaveRoute');
  pending.resolve(); await tick();
  assert.equal(ui.trading.sessionDraft.tokens, '0'); assert.equal(ui.trading.sessionDraft.dirty, true);
  assert.equal(ui.trading.sessionDraft.refreshNeeded, true);
  ui.evaluate("pageKind = 'trading'; routeRevision++;"); ui.call('syncTradeAutosaveRoute');
  await ui.advance(250);
  assert.equal(ui.posts().length, 2); assert.equal(ui.posts()[1].body.tokens, 0); assert.equal(ui.posts()[1].body.version, 3);
  assert.equal(ui.trading.sessionDraft.dirty, false); assert.equal(ui.server.saved.offeredTokens, 0);
});

test('an old account autosave response cannot change the next account or reopen its trade', async () => {
  const pending = deferred();
  const ui = autosaveHarness({ intercept: call => call.method === 'POST' ? pending.promise : undefined });
  await ui.input(7); await ui.advance(250);
  const next = account('next_account', 200); ui.call('setUser', next);
  pending.resolve({ trade: { ...ui.server.saved, offeredTokens: 7, version: 3 }, user: { ...ui.local, balance: 50 } }); await tick();
  await ui.advance(2000);
  assert.equal(ui.state.user.accountId, next.accountId); assert.equal(ui.state.user.balance, 200);
  assert.equal(ui.trading.sessionId, null); assert.equal(ui.trading.sessionDraft, null); assert.equal(ui.posts().length, 1);
});

test('a never-resolving old autosave cannot block a different trade or account', async () => {
  for (const changeAccount of [false, true]) {
    const pending = deferred(); let oldId;
    const ui = autosaveHarness({ intercept: call => call.method === 'POST' && call.route === `trades/${oldId}/contribution` ? pending.promise : undefined });
    oldId = ui.server.saved.id;
    await ui.input(7); await ui.advance(250);
    assert.equal(ui.posts().length, 1); assert.ok(ui.tradeAutosave.inFlight);
    const user = changeAccount ? account('next_account', 100) : ui.local;
    if (changeAccount) ui.call('setUser', user);
    const next = request(user, ui.partner, { status: 'negotiating', requestAccepted: true, version: 2 });
    ui.server.saved = next; ui.call('openTradeSession', next.id, next);
    await ui.input(9); await ui.advance(250);
    assert.equal(ui.posts().length, 2); assert.equal(ui.posts()[1].route, `trades/${next.id}/contribution`);
    assert.equal(ui.server.saved.offeredTokens, 9); assert.equal(ui.trading.sessionDraft.dirty, false);
    assert.equal(ui.trading.sessionId, next.id); assert.equal(ui.tradeAutosave.inFlight, null);
  }
});

test('an old session response cannot release or replace a newer session autosave', async () => {
  const oldPending = deferred(), newPending = deferred(); let oldId, newId;
  const ui = autosaveHarness({ intercept: (call, server) => {
    if (call.method !== 'POST') return;
    if (call.route === `trades/${oldId}/contribution`) return oldPending.promise;
    if (call.route === `trades/${newId}/contribution`) return newPending.promise.then(() => server.commit(call.body));
  } });
  const oldTrade = ui.server.saved; oldId = oldTrade.id;
  await ui.input(7); await ui.advance(250);
  const next = request(ui.local, ui.partner, { status: 'negotiating', requestAccepted: true, version: 2 });
  newId = next.id; ui.server.saved = next; ui.call('openTradeSession', next.id, next);
  await ui.input(9); await ui.advance(250);
  const currentOperation = ui.tradeAutosave.inFlight;
  assert.equal(currentOperation.id, next.id);
  oldPending.resolve({ trade: { ...oldTrade, offeredTokens: 7, version: 3 }, user: ui.local }); await tick();
  assert.equal(ui.tradeAutosave.inFlight, currentOperation); assert.equal(ui.trading.sessionId, next.id);
  assert.equal(ui.trading.sessionDraft.tokens, '9'); assert.equal(ui.trading.sessionDraft.dirty, true);
  newPending.resolve(); await tick();
  assert.equal(ui.tradeAutosave.inFlight, null); assert.equal(ui.trading.sessionDraft.dirty, false);
  assert.equal(ui.server.saved.offeredTokens, 9);
});
