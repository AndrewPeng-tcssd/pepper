const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/player-picker.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const users = ['example', 'examp', 'e', 'exampl', 'ex', 'exam', 'exa'].map(username => ({ username, accountId: username }));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Run the production component with controlled DOM events, time, and search responses.
function harness(network = () => users, extra = {}) {
  let clock = 0, nextTimer = 0;
  const timers = new Map(), calls = [], selected = [];
  class Node {
    constructor(tagName) {
      this.tagName = tagName; this.children = []; this.attributes = new Map(); this.listeners = new Map();
      this.value = ''; this.disabled = false; this.readOnly = false; this.hidden = false; this.ownerDocument = document;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parentElement = null; }); this.children = []; this.append(...nodes); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    insertAdjacentElement(where, node) {
      assert.equal(where, 'afterend');
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this) + 1, 0, node); node.parentElement = this.parentElement;
    }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }
    dispatch(type, extra = {}) {
      const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      (this.listeners.get(type) || []).forEach(callback => callback(event));
      return event;
    }
    focus() { document.activeElement = this; this.dispatch('focus'); }
    blur() { document.activeElement = null; this.dispatch('blur'); }
    scrollIntoView() {}
  }
  const document = { activeElement: null, createElement: tag => new Node(tag), listeners: new Map() };
  document.addEventListener = Node.prototype.addEventListener;
  document.dispatch = Node.prototype.dispatch;
  const wrapper = document.createElement('div'), input = document.createElement('input');
  wrapper.append(input);
  const context = vm.createContext({
    document, window: {},
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source, context);
  const options = {
    input,
    search: query => { calls.push(query); return network(query); },
    onSelect: player => selected.push(player),
    ...extra
  };
  const picker = context.window.PepperPlayerPicker.attach(options);
  const list = wrapper.children[1];
  return {
    input, list, picker, document, context, calls, selected, wrapper,
    names: () => list.children.filter(node => node.getAttribute('role') === 'option').map(node => node.children.find(child => child.className === 'player-picker-name').textContent),
    type(value) { input.value = value; input.dispatch('input'); },
    advance(milliseconds) {
      clock += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
    }
  };
}

test('focus lists players alphabetically and typing progressively narrows the prefix', async () => {
  const ui = harness();
  ui.input.focus(); await tick();
  assert.deepEqual(ui.calls, ['']);
  assert.deepEqual(ui.names(), ['e', 'ex', 'exa', 'exam', 'examp', 'exampl', 'example']);
  assert.equal(ui.input.getAttribute('role'), 'combobox');
  assert.equal(ui.input.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.input.getAttribute('aria-controls'), ui.list.id);
  for (const [query, expected] of [
    ['e', ['e', 'ex', 'exa', 'exam', 'examp', 'exampl', 'example']],
    ['ex', ['ex', 'exa', 'exam', 'examp', 'exampl', 'example']],
    ['exa', ['exa', 'exam', 'examp', 'exampl', 'example']],
    ['EXAMP', ['examp', 'exampl', 'example']]
  ]) {
    ui.type(query); ui.advance(150); await tick();
    assert.deepEqual(ui.names(), expected);
    assert.equal(ui.calls.at(-1), query.toLowerCase());
  }
});

test('click selects the player without submitting and prevents pending results reopening', async () => {
  const pending = deferred(), ui = harness(query => query === 'ex' ? pending.promise : users);
  ui.input.focus(); await tick();
  const option = ui.list.children[2];
  assert.equal(option.type, 'button');
  assert.equal(option.tabIndex, -1);
  assert.equal(ui.list.dispatch('mousedown').defaultPrevented, true);
  option.dispatch('click');
  assert.equal(ui.input.value, 'exa');
  assert.equal(ui.selected.length, 1);
  assert.equal(ui.selected[0].username, 'exa');
  assert.equal(ui.list.hidden, true);
  assert.equal(ui.input.getAttribute('aria-expanded'), 'false');
  ui.type('ex'); ui.advance(150);
  ui.picker.close(); pending.resolve(users); await tick();
  assert.equal(ui.list.hidden, true);
  assert.equal(ui.selected.length, 1);
});

test('arrow keys and Enter choose options while Escape and Tab leave the value unchanged', async () => {
  const ui = harness(); ui.input.focus(); await tick();
  assert.equal(ui.input.dispatch('keydown', { key: 'ArrowUp' }).defaultPrevented, true);
  assert.equal(ui.list.children.at(-1).getAttribute('aria-selected'), 'true');
  assert.equal(ui.input.getAttribute('aria-activedescendant'), ui.list.children.at(-1).id);
  ui.input.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(ui.list.children[0].getAttribute('aria-selected'), 'true');
  ui.input.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(ui.input.dispatch('keydown', { key: 'Enter' }).defaultPrevented, true);
  assert.equal(ui.input.value, 'ex'); assert.equal(ui.selected[0].username, 'ex');
  ui.picker.refresh(); await tick();
  assert.equal(ui.input.dispatch('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(ui.list.hidden, true); assert.equal(ui.input.value, 'ex');
  ui.picker.refresh(); await tick();
  assert.equal(ui.input.dispatch('keydown', { key: 'Tab' }).defaultPrevented, false);
  assert.equal(ui.list.hidden, true); assert.equal(ui.input.value, 'ex');
  assert.equal(ui.input.dispatch('keydown', { key: 'Enter' }).defaultPrevented, false);
});

test('typing debounces requests and old results cannot replace the latest prefix', async () => {
  const old = deferred(), latest = deferred(), ui = harness(query => query === 'e' ? old.promise : query === 'exa' ? latest.promise : users);
  ui.input.focus(); await tick();
  ui.type('e'); ui.advance(149); assert.deepEqual(ui.calls, ['']);
  ui.advance(1); assert.deepEqual(ui.calls, ['', 'e']);
  ui.type('ex'); ui.advance(100); ui.type('exa'); ui.advance(150);
  assert.deepEqual(ui.calls, ['', 'e', 'exa']);
  latest.resolve(users); await tick();
  assert.deepEqual(ui.names(), ['exa', 'exam', 'examp', 'exampl', 'example']);
  old.resolve([{ username: 'e' }]); await tick();
  assert.deepEqual(ui.names(), ['exa', 'exam', 'examp', 'exampl', 'example']);
});

test('keyboard selection requested during loading applies once results arrive', async () => {
  const pending = deferred(), ui = harness(() => pending.promise);
  ui.input.focus();
  ui.input.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(ui.calls.length, 1);
  pending.resolve(users); await tick();
  assert.equal(ui.list.children.at(-1).getAttribute('aria-selected'), 'true');
  ui.input.dispatch('keydown', { key: 'Enter' });
  assert.equal(ui.input.value, 'example');
});

test('blur, outside clicks, reset, and closeAll invalidate outstanding searches', async () => {
  for (const action of [
    ui => ui.input.blur(),
    ui => ui.document.dispatch('pointerdown', { target: ui.document.createElement('div') }),
    ui => ui.picker.reset(),
    ui => ui.context.window.PepperPlayerPicker.closeAll()
  ]) {
    const pending = deferred(), ui = harness(() => pending.promise);
    ui.input.value = 'ex'; ui.input.focus(); action(ui);
    pending.resolve(users); await tick();
    assert.equal(ui.list.hidden, true);
    assert.equal(ui.input.value, 'ex');
    assert.equal(ui.input.getAttribute('aria-activedescendant'), null);
  }
});

test('empty and rejected searches show concise statuses and recover on later input', async () => {
  const ui = harness(query => query === 'oops' ? Promise.reject(new Error('Offline')) : query === 'zzz' ? [] : users);
  ui.input.focus();
  assert.equal(ui.list.children[0].textContent, 'Loading…');
  await tick();
  ui.type('zzz'); ui.advance(150); await tick();
  assert.equal(ui.list.children[0].textContent, 'No players.');
  assert.equal(ui.input.getAttribute('aria-activedescendant'), null);
  ui.type('oops'); ui.advance(150); await tick();
  assert.equal(ui.list.children[0].textContent, 'Players unavailable.');
  ui.type('ex'); ui.advance(150); await tick();
  assert.equal(ui.names().length, 6);
});

test('disabled, unavailable, and invalid inputs never show players or make new searches', async () => {
  let enabled = true;
  const ui = harness(() => users, { isEnabled: () => enabled });
  ui.input.focus(); await tick();
  for (const invalid of ['ex!', '<script>', 'a'.repeat(25)]) {
    ui.type(invalid); ui.advance(150); await tick();
    assert.equal(ui.list.hidden, true);
  }
  assert.equal(ui.calls.length, 1);
  ui.input.disabled = true; ui.type('ex'); ui.advance(150); ui.picker.refresh();
  assert.equal(ui.list.hidden, true); assert.equal(ui.calls.length, 1);
  ui.input.disabled = false; enabled = false; ui.picker.refresh();
  assert.equal(ui.list.hidden, true); assert.equal(ui.calls.length, 1);
  enabled = true; ui.picker.refresh(); await tick(); assert.equal(ui.names().length, 6);
  ui.type(''); ui.advance(150); await tick(); assert.equal(ui.names().length, 7);
});

test('an enabled-state change during a search hides stale results', async () => {
  let enabled = true;
  const pending = deferred(), ui = harness(() => pending.promise, { isEnabled: () => enabled });
  ui.input.focus(); enabled = false; pending.resolve(users); await tick();
  assert.equal(ui.list.hidden, true); assert.equal(ui.input.getAttribute('aria-expanded'), 'false');
});

test('invalid, duplicate, and mismatched results are excluded and avatar rendering remains optional', async () => {
  let avatars = 0;
  const ui = harness(() => [null, { username: 1 }, { username: '<img>' }, { username: 'elsewhere' }, { username: 'Exa' }, { username: 'exa' }, { username: 'ex' }], {
    renderAvatar: () => { avatars++; return null; }
  });
  ui.input.value = 'ex'; ui.input.focus(); await tick();
  assert.deepEqual(ui.names(), ['ex', 'Exa']);
  assert.equal(avatars, 2);
});

test('a removed option cannot select another player from a later search', async () => {
  const ui = harness(); ui.input.focus(); await tick();
  const removed = ui.list.children[0];
  ui.type('ex'); ui.advance(150); await tick();
  removed.dispatch('click');
  assert.equal(ui.selected.length, 0);
  assert.equal(ui.input.value, 'ex');
});
