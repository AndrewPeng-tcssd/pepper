(() => {
  'use strict';
  let nextId = 0;
  const pickers = new Set();

  function attach({ input, search, onSelect, renderAvatar, isEnabled = () => true }) {
    const owner = input.ownerDocument || document;
    const list = owner.createElement('div');
    list.id = `player-picker-list-${++nextId}`;
    list.className = 'player-picker-list';
    list.hidden = true;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Players');
    input.insertAdjacentElement('afterend', list);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('autocomplete', 'off');

    let revision = 0, timer = null, players = [], options = [], active = -1, pendingDirection = 0, loading = false;
    const enabled = () => !input.disabled && !input.readOnly && isEnabled();
    const focused = () => owner.activeElement === input;
    const prefix = () => input.value.trim().toLowerCase();
    const valid = value => /^[a-z0-9_]{0,24}$/.test(value);

    function clearActive() {
      active = -1;
      input.removeAttribute('aria-activedescendant');
    }

    function close() {
      revision++;
      clearTimeout(timer);
      timer = null;
      loading = false;
      pendingDirection = 0;
      players = [];
      options = [];
      clearActive();
      list.hidden = true;
      list.replaceChildren();
      input.setAttribute('aria-expanded', 'false');
    }

    function open() {
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function status(text) {
      players = [];
      options = [];
      clearActive();
      const message = owner.createElement('div');
      message.className = 'player-picker-status';
      message.setAttribute('role', 'status');
      message.textContent = text;
      list.replaceChildren(message);
      open();
    }

    function highlight(index) {
      active = index;
      options.forEach((option, position) => option.setAttribute('aria-selected', String(position === index)));
      const option = options[index];
      if (option) {
        input.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView?.({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }

    function choose(index, expected = players[index]) {
      const player = players[index];
      if (!enabled() || !focused() || !player || player !== expected || list.hidden) { close(); return; }
      input.value = player.username;
      close();
      onSelect?.(player);
    }

    function render(results, query) {
      loading = false;
      const seen = new Set();
      players = (Array.isArray(results) ? results : [])
        .filter(player => {
          const name = typeof player?.username === 'string' ? player.username.toLowerCase() : '';
          if (!name || !valid(name) || !name.startsWith(query) || seen.has(name)) return false;
          seen.add(name);
          return true;
        })
        .sort((left, right) => left.username.localeCompare(right.username, undefined, { sensitivity: 'base' }));
      clearActive();
      if (!players.length) { status('No players.'); pendingDirection = 0; return; }
      options = players.map((player, index) => {
        const option = owner.createElement('button');
        option.type = 'button';
        option.tabIndex = -1;
        option.id = `${list.id}-option-${index}`;
        option.className = 'player-picker-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        if (renderAvatar) {
          const avatar = renderAvatar(player);
          if (avatar) option.append(avatar);
        }
        const name = owner.createElement('span');
        name.className = 'player-picker-name';
        name.textContent = player.username;
        option.append(name);
        option.addEventListener('click', () => choose(index, player));
        option.addEventListener('mouseenter', () => highlight(index));
        return option;
      });
      list.replaceChildren(...options);
      open();
      if (pendingDirection) highlight(pendingDirection > 0 ? 0 : players.length - 1);
      pendingDirection = 0;
    }

    function load(delay = 0, direction = 0) {
      close();
      const query = prefix();
      if (!enabled() || !focused() || !valid(query)) return;
      const requestRevision = revision;
      pendingDirection = direction;
      loading = true;
      status('Loading…');
      const current = () => requestRevision === revision && enabled() && focused() && prefix() === query;
      const run = async () => {
        timer = null;
        try {
          const results = await search(query);
          if (current()) render(results, query);
          else if (requestRevision === revision) close();
        } catch {
          if (current()) { loading = false; pendingDirection = 0; status('Players unavailable.'); }
          else if (requestRevision === revision) close();
        }
      };
      if (delay) timer = setTimeout(run, delay);
      else void run();
    }

    input.addEventListener('focus', () => load());
    input.addEventListener('input', () => load(150));
    input.addEventListener('blur', close);
    input.addEventListener('keydown', event => {
      if (!enabled()) { close(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        if (!list.hidden && players.length) highlight(active < 0 ? direction > 0 ? 0 : players.length - 1 : (active + direction + players.length) % players.length);
        else if (!list.hidden && loading) pendingDirection = direction;
        else load(0, direction);
      } else if (event.key === 'Enter' && !list.hidden && active >= 0) {
        event.preventDefault();
        choose(active);
      } else if (event.key === 'Escape') {
        if (!list.hidden) event.preventDefault();
        close();
      } else if (event.key === 'Tab') close();
    });
    // Keep the combobox focused while clicking an option.
    list.addEventListener('mousedown', event => event.preventDefault());
    list.addEventListener('pointerdown', event => event.preventDefault());
    owner.addEventListener('pointerdown', event => {
      if (event.target !== input && !list.contains(event.target)) close();
    });

    const picker = { close, reset: close, refresh: () => load() };
    pickers.add(picker);
    return picker;
  }

  window.PepperPlayerPicker = { attach, closeAll: () => pickers.forEach(picker => picker.reset()) };
})();
