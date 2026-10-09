const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

// Exercise production send/identity handlers with a deterministic clock and network.
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
    } else if (char === '/' && source[index + 1] === '*') index = source.indexOf('*/', index + 2) + 1;
    else if (char === opening) depth += 1;
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

function fakeClock() {
  let now = Date.parse('2026-10-08T12:00:00Z');
  let sequence = 0;
  const timers = new Map();
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  return {
    Date: FakeDate,
    setTimeout(callback, delay = 0) { const id = ++sequence; timers.set(id, { callback, due: now + Math.max(0, Number(delay) || 0) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = now + ms;
      for (let count = 0; count < 100; count += 1) {
        await tick();
        const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) { now = target; await tick(); return; }
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      throw new Error('Timer queue did not settle');
    }
  };
}

function account(username = 'local_player') {
  return { username, accountId: `PPR-${crypto.randomUUID().toUpperCase()}`, balance: 20, avatarUrl: '/favicon.svg' };
}

function rateLimit(retryAfterMs = 900) {
  return Object.assign(new Error('Please wait before sending again.'), { status: 429, retryAfterMs });
}

function harness({ user = account(), network = () => undefined } = {}) {
  const clock = fakeClock();
  const elements = new Map();
  const calls = [];
  const rendering = [];
  let context;
  function element(id) {
    const classes = new Set();
    const listeners = new Map();
    const node = {
      id, value: '', hidden: false, disabled: false, open: false, textContent: '', dataset: {}, children: [],
      scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      get className() { return [...classes].join(' '); },
      set className(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
      classList: {
        contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
        toggle: (name, enabled) => { if (enabled) classes.add(name); else classes.delete(name); }
      },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      querySelectorAll(selector) {
        const className = /^\.([\w-]+)$/.exec(selector)?.[1];
        return this.children.flatMap(child => [
          ...(className && child.classList?.contains(className) ? [child] : []),
          ...(child.querySelectorAll?.(selector) || [])
        ]);
      },
      closest() { return null; },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      reset() {}, close() { this.open = false; }, focus() { document.activeElement = this; },
      addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
      async dispatch(type) { for (const listener of listeners.get(type) || []) await listener({ preventDefault() {}, target: this }); }
    };
    return node;
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], element(match[1]));
  const document = { getElementById: id => elements.get(id), createElement: element, body: element('body'), activeElement: null };
  const boundary = {
    document, crypto, console, AbortController, URLSearchParams, Date: clock.Date,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    window: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    location: { pathname: '/', search: '' },
    api: async (route, options = {}) => {
      const call = { route, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call);
      const result = await network(call);
      if (result !== undefined) return result;
      if (call.method === 'POST') {
        const sender = vm.runInContext('state.user', context);
        return { message: { id: crypto.randomBytes(12).toString('hex'), ...call.body, sender, ...sender, createdAt: new clock.Date().toISOString() } };
      }
      throw new Error(`Unexpected network call ${call.method} ${route}`);
    },
    loadChat() {}, loadTradeChat() {}, loadTradeSession() {}, loadTrades() {}, loadPresence() {},
    renderOverviewProfile() {}, renderProfileDetails() {}, renderChangelogEditor() {}, renderAnnouncementEditor() {},
    renderLeaderboard() {}, renderClaim() {}, renderTradingState() {}, syncPictureSettings() {}, setProfileAvatar() {},
    clearClaimReward() {}, removeTurnstile() {}, scrollChatToLatest() {}, refreshTradeInventories() {},
    clearChatReply() { vm.runInContext('state.chatReply = null;', context); },
    isOwnChatMessage: () => false,
    profileAvatar: () => element('img'), formatProfileDate: value => value,
    renderChat(messages) {
      const state = vm.runInContext('state', context);
      state.chatMessages = messages;
      const received = new Set(messages.map(item => item.clientMessageId));
      state.chatOutbox = state.chatOutbox.filter(item => !received.has(item.clientMessageId));
      const entries = [...messages, ...state.chatOutbox];
      rendering.push(plain(entries));
      elements.get('chatMessages').replaceChildren(...entries.map(item => context.createChatRow(item)));
    },
    renderTradeSession() { context.renderTradeChat(); }
  };
  context = vm.createContext(boundary);
  const functions = [
    'accountRole', 'playerRoleBadges',
    'newTradeInventory', 'message', 'isOwnProfile', 'profileHref', 'tradeProfileLink',
    'setUser', 'syncTradingUser', 'prefillTradingRecipient', 'tradingIdentityIsCurrent', 'acceptedTradeRequest', 'cancelTradeAutosave',
    'chatRetryDelay', 'resetChatSending', 'scheduleChatSend', 'queueTradeChatRetry',
    'sendChatEntry', 'sendTradeChatEntry', 'createChatRow', 'renderTradeChat'
  ];
  const prefix = source.slice(0, source.indexOf('\nfunction newTradeInventory'));
  vm.runInContext(prefix + '\n' + functions.map(productionFunction).join('\n') + '\n' + productionListener('chatForm', 'submit'), context);
  const shared = vm.runInContext('({ state, trading })', context);
  shared.state.user = user;
  shared.trading.identity = user.accountId;
  const trade = { id: crypto.randomBytes(12).toString('hex'), status: 'negotiating', requestAccepted: true };
  shared.trading.session = trade;
  shared.trading.sessionId = trade.id;
  shared.trading.trades = [trade];
  return {
    ...shared, calls, clock, elements, rendering,
    evaluate: code => vm.runInContext(code, context),
    call: (name, ...args) => context[name](...args),
    publicEntry(text = 'Hello', replyTo = null) {
      const clientMessageId = crypto.randomUUID();
      const entry = { id: `local:${clientMessageId}`, clientMessageId, ...user, identity: user.accountId, text, replyTo, status: 'pending', error: null, createdAt: new clock.Date().toISOString() };
      shared.state.chatOutbox.push(entry);
      return entry;
    },
    privateEntry(body = 'Ready to trade?') {
      const entry = { tradeId: trade.id, identity: user.accountId, clientMessageId: crypto.randomUUID(), sender: user, body, createdAt: new clock.Date().toISOString(), status: 'new' };
      shared.trading.chatOutbox.push(entry);
      return entry;
    }
  };
}

function textIn(node) { return [node.textContent, ...node.children.map(textIn)].filter(Boolean).join(' '); }

test('public rate limits keep Sending visible and automatically retry the original reply once ready', async () => {
  const ui = harness({ network: () => { if (ui.calls.length === 1) throw rateLimit(); } });
  const replyTo = { id: 'original-message', username: 'partner', text: 'Question', available: true };
  const entry = ui.publicEntry('Answer', replyTo);
  void ui.call('sendChatEntry', entry);
  await tick();
  assert.equal(entry.status, 'pending');
  assert.equal(entry.error, null);
  assert.match(textIn(ui.elements.get('chatMessages')), /Sending…/);
  assert.equal(ui.elements.get('chatMessages').querySelectorAll('.chat-retry-button').length, 0);
  await ui.clock.advance(999);
  assert.equal(ui.calls.length, 1);
  await ui.clock.advance(1);
  assert.equal(ui.calls.length, 2);
  assert.deepEqual(ui.calls[1].body, ui.calls[0].body);
  assert.equal(ui.calls[1].body.clientMessageId, entry.clientMessageId);
  assert.equal(ui.calls[1].body.replyToId, replyTo.id);
  assert.equal(ui.state.chatOutbox.length, 0);
  assert.equal(ui.state.chatMessages.length, 1);
  assert.ok(ui.rendering.every(entries => entries.every(item => item.status !== 'failed')));
});

test('queued public messages preserve order and concurrent retry clicks cannot duplicate sends', async () => {
  const response = deferred();
  const ui = harness({ network: () => {
    if (ui.calls.length === 1) throw rateLimit();
    if (ui.calls.length === 2) return response.promise;
  } });
  const first = ui.publicEntry('First');
  const second = ui.publicEntry('Second');
  void ui.call('sendChatEntry', first);
  void ui.call('sendChatEntry', second);
  await tick();
  await ui.call('sendChatEntry', first);
  await ui.call('sendChatEntry', second);
  assert.equal(ui.calls.length, 1);
  await ui.clock.advance(1000);
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[1].body.text, 'First');
  await ui.call('sendChatEntry', first);
  await ui.call('sendChatEntry', second);
  assert.equal(ui.calls.length, 2);
  response.resolve({ message: { id: 'first-saved', ...first, status: undefined } });
  await tick();
  await ui.clock.advance(0);
  assert.deepEqual(ui.calls.map(call => call.body.text), ['First', 'First', 'Second']);
  assert.equal(ui.state.chatOutbox.length, 0);
});

test('repeated public rate limits honor each cooldown while retaining the same message', async () => {
  const ui = harness({ network: () => {
    if (ui.calls.length === 1) throw rateLimit(400);
    if (ui.calls.length === 2) throw rateLimit(1400);
  } });
  const entry = ui.publicEntry();
  void ui.call('sendChatEntry', entry);
  await tick();
  await ui.clock.advance(500);
  assert.equal(ui.calls.length, 2);
  assert.equal(entry.status, 'pending');
  await ui.clock.advance(1499);
  assert.equal(ui.calls.length, 2);
  await ui.clock.advance(1);
  assert.equal(ui.calls.length, 3);
  assert.ok(ui.calls.every(call => call.body.clientMessageId === entry.clientMessageId));
  assert.equal(ui.state.chatMessages.length, 1);
});

test('a new public submission cannot jump ahead of an already queued message', async () => {
  const response = deferred();
  const ui = harness({ network: () => { if (ui.calls.length === 1) return response.promise; } });
  const first = ui.publicEntry('First');
  const second = ui.publicEntry('Second');
  void ui.call('sendChatEntry', first);
  void ui.call('sendChatEntry', second);
  await tick();
  response.resolve({ message: { id: 'first-saved', ...first, status: undefined } });
  await tick();
  ui.elements.get('chatInput').value = 'Third';
  await ui.elements.get('chatForm').dispatch('submit');
  await ui.clock.advance(0);
  assert.deepEqual(ui.calls.map(call => call.body.text), ['First', 'Second', 'Third']);
  assert.equal(ui.state.chatOutbox.length, 0);
});

test('public cooldown is cancelled across account switches, including return to the original account', async () => {
  const local = account();
  const ui = harness({ user: local, network: () => { throw rateLimit(); } });
  const entry = ui.publicEntry();
  void ui.call('sendChatEntry', entry);
  await tick();
  ui.call('setUser', account('other_player'));
  ui.call('setUser', local);
  await ui.clock.advance(10000);
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.state.chatOutbox.length, 0);
});

test('a late public rate-limit response cannot schedule a send after logout', async () => {
  const response = deferred();
  const ui = harness({ network: () => response.promise });
  void ui.call('sendChatEntry', ui.publicEntry());
  await tick();
  ui.call('setUser', null);
  response.reject(rateLimit());
  await tick();
  await ui.clock.advance(10000);
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.state.chatOutbox.length, 0);
});

test('public network and validation failures still require manual retry', async () => {
  for (const error of [new Error('Connection lost.'), Object.assign(new Error('Invalid message.'), { status: 400 })]) {
    const ui = harness({ network: () => { if (ui.calls.length === 1) throw error; } });
    const entry = ui.publicEntry();
    await ui.call('sendChatEntry', entry);
    assert.equal(entry.status, 'failed');
    assert.equal(entry.error, error.message);
    assert.equal(ui.elements.get('chatMessages').querySelectorAll('.chat-retry-button').length, 1);
    await ui.clock.advance(10000);
    assert.equal(ui.calls.length, 1);
    await ui.call('sendChatEntry', entry);
    assert.equal(ui.calls.length, 2);
    assert.deepEqual(ui.calls[1].body, ui.calls[0].body);
  }
});

test('private rate limits show Sending and retry the original trade message without duplicates', async () => {
  const response = deferred();
  const ui = harness({ network: () => {
    if (ui.calls.length === 1) throw rateLimit();
    return response.promise;
  } });
  const entry = ui.privateEntry();
  void ui.call('sendTradeChatEntry', entry);
  await tick();
  assert.equal(entry.status, 'waiting');
  assert.equal(entry.error, null);
  const container = ui.elements.get('tradingChatMessages');
  assert.match(textIn(container), /Sending…/);
  assert.doesNotMatch(textIn(container), /Retry message|Could not send/);
  await ui.call('sendTradeChatEntry', entry);
  await ui.clock.advance(999);
  assert.equal(ui.calls.length, 1);
  await ui.clock.advance(1);
  assert.equal(ui.calls.length, 2);
  assert.equal(entry.status, 'sending');
  await ui.call('sendTradeChatEntry', entry);
  assert.equal(ui.calls.length, 2);
  assert.deepEqual(ui.calls[1].body, ui.calls[0].body);
  assert.equal(ui.calls[1].route, `trades/${entry.tradeId}/messages`);
  response.resolve({ message: { id: 'saved-private', ...entry, status: undefined } });
  await tick();
  assert.equal(ui.trading.chatOutbox.length, 0);
  assert.equal(ui.trading.chatMessages.length, 1);
});

test('private delayed messages retain their destination when another trade is opened', async () => {
  const ui = harness({ network: () => { if (ui.calls.length === 1) throw rateLimit(); } });
  const entry = ui.privateEntry();
  void ui.call('sendTradeChatEntry', entry);
  await tick();
  ui.trading.session = { id: crypto.randomBytes(12).toString('hex'), status: 'negotiating', requestAccepted: true };
  ui.trading.sessionId = ui.trading.session.id;
  ui.trading.chatMessages = [];
  await ui.clock.advance(1000);
  assert.equal(ui.calls.length, 2);
  assert.ok(ui.calls.every(call => call.route === `trades/${entry.tradeId}/messages`));
  assert.equal(ui.trading.chatMessages.length, 0);
  assert.equal(ui.trading.chatOutbox.length, 0);
});

test('private cooldown and late responses cannot send after an account switch', async () => {
  for (const lateResponse of [false, true]) {
    const response = deferred();
    const local = account();
    const ui = harness({ user: local, network: () => { if (lateResponse) return response.promise; throw rateLimit(); } });
    void ui.call('sendTradeChatEntry', ui.privateEntry());
    await tick();
    ui.call('setUser', account('other_player'));
    ui.call('setUser', local);
    if (lateResponse) response.reject(rateLimit());
    await tick();
    await ui.clock.advance(10000);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.trading.chatOutbox.length, 0);
  }
});

test('private network and validation failures retain manual retry', async () => {
  for (const error of [new Error('Connection lost.'), Object.assign(new Error('Invalid message.'), { status: 400 })]) {
    const ui = harness({ network: () => { if (ui.calls.length === 1) throw error; } });
    const entry = ui.privateEntry();
    await ui.call('sendTradeChatEntry', entry);
    assert.equal(entry.status, 'failed');
    assert.equal(entry.error, error.message);
    assert.match(textIn(ui.elements.get('tradingChatMessages')), /Retry message/);
    await ui.clock.advance(10000);
    assert.equal(ui.calls.length, 1);
    await ui.call('sendTradeChatEntry', entry);
    assert.equal(ui.calls.length, 2);
    assert.deepEqual(ui.calls[1].body, ui.calls[0].body);
  }
});

test('rate-limit responses use JSON milliseconds, then Retry-After seconds or dates', async () => {
  const clock = fakeClock();
  const cases = [
    { data: { retryAfterMs: 640 }, header: '9', expected: 640 },
    { data: {}, header: '2.5', expected: 2500 },
    { data: { retryAfterMs: -1 }, header: new clock.Date(clock.Date.now() + 4000).toUTCString(), expected: 4000 }
  ];
  for (const { data, header, expected } of cases) {
    const context = vm.createContext({
      Date: clock.Date,
      userIdentityRevision: 0,
      fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: 'Slow down.', ...data }), headers: { get: name => name === 'Retry-After' ? header : null } })
    });
    vm.runInContext(productionFunction('api'), context);
    await assert.rejects(context.api('chat', { method: 'POST' }), error => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, expected);
      return true;
    });
  }
});

test('missing or invalid rate-limit timing uses a bounded fallback instead of spinning', async () => {
  for (const retryAfterMs of [undefined, 0, -5, 'invalid', Infinity]) {
    const ui = harness({ network: () => {
      if (ui.calls.length === 1) {
        const error = rateLimit();
        error.retryAfterMs = retryAfterMs;
        throw error;
      }
    } });
    const entry = ui.publicEntry();
    void ui.call('sendChatEntry', entry);
    await tick();
    await ui.clock.advance(3099);
    assert.equal(ui.calls.length, 1);
    await ui.clock.advance(1);
    assert.equal(ui.calls.length, 2);
  }
});
