(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const names = { 'tic-tac-toe': 'Tic-Tac-Toe', 'rock-paper-scissors': 'Rock Paper Scissors' };
  const choiceNames = { rock: 'Rock', paper: 'Paper', scissors: 'Scissors' };
  const choiceIcons = { rock: '✊', paper: '✋', scissors: '✌' };
  const games = { identity: null, revision: 0, entries: [], selectedId: null, loading: false, loaded: false, action: null, retry: null, notificationId: null, listSignature: null, sessionSignature: null };
  const active = game => ['pending', 'playing'].includes(game.status);
  const busy = () => !!games.action || state.accountSubmitting;
  const locked = () => busy() || !!games.retry;
  const self = game => game.sender.accountId === games.identity ? game.sender : game.recipient;
  const other = game => game.sender.accountId === games.identity ? game.recipient : game.sender;
  const current = (identity, identityRevision) => state.user?.accountId === identity && games.identity === identity && userIdentityRevision === identityRevision;
  const count = value => Number(value || 0).toLocaleString();
  function newest(incoming, previous) {
    if (!previous || incoming.version > previous.version) return incoming;
    if (incoming.version < previous.version || (!active(previous) && active(incoming))) return previous;
    return new Date(incoming.updatedAt) < new Date(previous.updatedAt) ? previous : incoming;
  }
  function remember(game) {
    const previous = games.entries.find(entry => entry.id === game.id);
    games.entries = [newest(game, previous), ...games.entries.filter(entry => entry.id !== game.id)]
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }
  function updateUser(user) {
    if (user?.accountId !== state.user?.accountId) return;
    const merged = { ...state.user, ...user };
    if (JSON.stringify(merged) !== JSON.stringify(state.user)) setUser(merged);
  }
  function status(game) {
    if (game.status === 'completed') return game.result === 'draw' ? 'Draw' : game.winnerAccountId === games.identity ? 'You won' : 'You lost';
    return { pending: 'Requested', playing: 'In progress', declined: 'Declined', cancelled: 'Cancelled', expired: 'Expired' }[game.status] || game.status;
  }
  function playerLink(player) {
    const link = document.createElement('a'); link.href = profileHref(player.username); link.className = 'player-identity';
    const name = document.createElement('span'); name.textContent = player.username;
    link.append(profileAvatar(player), name, playerRoleBadges(player)); return link;
  }
  function button(label, action, id, disabled = locked()) {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'button'; node.textContent = label;
    node.dataset.gameAction = action; node.dataset.gameId = id; node.disabled = disabled; return node;
  }
  function gameActions(game, container, includeOpen = false) {
    if (includeOpen) container.append(button(active(game) ? 'Open game' : 'View game', 'open', game.id, busy()));
    if (game.status === 'pending') {
      if (game.recipient.accountId === games.identity) container.append(button(`Accept · ${count(game.stake)} tokens`, 'accept', game.id), button('Decline', 'decline', game.id));
      else container.append(button('Cancel request', 'cancel', game.id));
    } else if (game.status === 'playing') container.append(button('Resign', 'review-resign', game.id));
  }
  function renderLists() {
    const signature = JSON.stringify([games.entries, games.identity, busy(), !!games.retry]);
    if (signature === games.listSignature) return;
    games.listSignature = signature;
    for (const [id, empty, entries] of [
      ['gamesActive', 'gamesActiveEmpty', games.entries.filter(active)],
      ['gamesHistory', 'gamesHistoryEmpty', games.entries.filter(game => !active(game))]
    ]) {
      el(empty).hidden = entries.length > 0;
      el(id).replaceChildren(...entries.map(game => {
        const row = document.createElement('article'); row.className = 'trading-card games-list-card';
        const heading = document.createElement('div'); heading.className = 'games-list-card-heading';
        const title = document.createElement('h3'); title.textContent = names[game.game];
        const badge = document.createElement('span'); badge.className = 'trading-status'; badge.textContent = status(game); heading.append(title, badge);
        const terms = document.createElement('p'); terms.className = 'games-list-stake'; terms.textContent = `${count(game.stake)} tokens each`;
        const actions = document.createElement('div'); actions.className = 'trading-actions'; gameActions(game, actions, true);
        row.append(heading, playerLink(other(game)), terms, actions); return row;
      }));
    }
  }
  function renderDeadline() {
    const game = games.entries.find(entry => entry.id === games.selectedId);
    const deadline = game && active(game) ? new Date(game.expiresAt).getTime() : 0;
    el('gamesDeadline').hidden = !deadline;
    if (!deadline) return;
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el('gamesDeadline').textContent = seconds ? `${game.status === 'pending' ? 'Expires' : 'Time left'} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Updating result…';
  }
  function renderSession() {
    const game = games.entries.find(entry => entry.id === games.selectedId);
    el('gamesLobby').hidden = !!game; el('gamesSession').hidden = !game;
    renderDeadline();
    const signature = JSON.stringify([game, games.identity, locked(), games.resignId]);
    if (signature === games.sessionSignature) return;
    games.sessionSignature = signature;
    if (!game) return;
    el('gamesSessionTitle').textContent = names[game.game];
    el('gamesSessionStatus').textContent = status(game);
    el('gamesPlayers').replaceChildren(...[self(game), other(game)].map((player, index) => {
      const side = document.createElement('div'); side.className = 'games-player';
      const label = document.createElement('span'); label.className = 'games-player-label';
      label.textContent = index === 0 ? 'You' : 'Opponent'; side.append(label, playerLink(player));
      if (game.game === 'tic-tac-toe') { const symbol = document.createElement('strong'); symbol.className = 'games-player-symbol'; symbol.textContent = player.accountId === game.sender.accountId ? 'X' : 'O'; side.append(symbol); }
      return side;
    }));
    el('gamesStakeSummary').textContent = `${count(game.stake)} tokens each`;
    el('gamesPot').textContent = `${count(game.stake * 2)} token pot`;
    const ended = game.status === 'completed';
    el('gamesTurn').textContent = game.status === 'pending' ? 'Awaiting acceptance' : ended ? game.result === 'draw' ? 'Draw · stakes returned' : game.winnerAccountId === games.identity ? `You won ${count(game.stake * 2)} tokens` : 'Opponent won the pot' : game.status !== 'playing' ? status(game) : game.game === 'tic-tac-toe' ? game.turnAccountId === games.identity ? 'Your turn' : 'Opponent’s turn' : game.yourChoice ? 'Waiting for opponent' : 'Choose your move';
    const showPlay = game.status === 'playing' || ended;
    el('gamesBoard').hidden = !showPlay || game.game !== 'tic-tac-toe';
    el('gamesRps').hidden = !showPlay || game.game !== 'rock-paper-scissors';
    el('gamesBoard').replaceChildren(); el('gamesChoices').replaceChildren(); el('gamesReveal').replaceChildren();
    if (showPlay && game.game === 'tic-tac-toe') {
      const winning = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]].find(line => game.board[line[0]] && line.every(index => game.board[index] === game.board[line[0]])) || [];
      game.board.forEach((symbol, position) => {
        const square = button(symbol || '', 'move', game.id, locked() || game.status !== 'playing' || game.turnAccountId !== games.identity || !!symbol);
        square.className = 'games-square'; square.dataset.position = String(position);
        square.setAttribute('aria-label', `Row ${Math.floor(position / 3) + 1}, column ${position % 3 + 1}${symbol ? `: ${symbol}` : ''}`);
        square.classList.toggle('is-winning', winning.includes(position)); square.classList.toggle('is-o', symbol === 'O');
        el('gamesBoard').append(square);
      });
    }
    if (showPlay && game.game === 'rock-paper-scissors') {
      for (const choice of Object.keys(choiceNames)) {
        const option = button('', 'move', game.id, locked() || game.status !== 'playing' || !!game.yourChoice); option.className = 'games-choice'; option.dataset.choice = choice;
        option.setAttribute('aria-pressed', String(game.yourChoice === choice));
        const icon = document.createElement('span'); icon.textContent = choiceIcons[choice]; icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span'); label.textContent = choiceNames[choice]; option.append(icon, label); el('gamesChoices').append(option);
      }
      const yours = document.createElement('p'); yours.textContent = `You: ${choiceNames[game.yourChoice] || 'Choosing…'}`;
      const theirs = document.createElement('p'); const opponentChoice = game.choices?.[game.sender.accountId === games.identity ? 'recipient' : 'sender'];
      theirs.textContent = `Opponent: ${choiceNames[opponentChoice] || (game.opponentChosen ? 'Ready' : ended ? 'No move' : 'Choosing…')}`;
      el('gamesReveal').append(yours, theirs);
    }
    const actions = el('gamesSessionActions'); actions.replaceChildren();
    if (games.resignId === game.id && game.status === 'playing') {
      actions.append(button('Confirm resignation', 'resign', game.id), button('Keep playing', 'keep-playing', game.id));
    } else gameActions(game, actions);
  }
  function renderNotification() {
    const requests = games.entries.filter(game => game.status === 'pending' && game.recipient.accountId === games.identity)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const request = requests.find(game => game.id === games.notificationId) || requests[0];
    games.notificationId = request?.id || null;
    const popup = el('gameNotification'), focused = popup.contains(document.activeElement);
    popup.hidden = !state.user || !request || !el('tradeNotification').hidden;
    if (popup.hidden) { if (focused) focusRouteHeading(); return; }
    el('gameNotificationSender').textContent = request.sender.username;
    el('gameNotificationSender').href = profileHref(request.sender.username);
    el('gameNotificationTerms').textContent = `${names[request.game]} · ${count(request.stake)} tokens each`;
    const sameRetry = games.retry?.id === request.id;
    for (const action of ['accept', 'decline']) {
      const control = el(action === 'accept' ? 'gameNotificationAccept' : 'gameNotificationDecline');
      control.disabled = busy() || (!!games.retry && !(sameRetry && games.retry.action === action));
      control.textContent = games.action?.id === request.id && games.action.action === action ? action === 'accept' ? 'Accepting…' : 'Declining…' : sameRetry && games.retry.action === action ? 'Retry' : action === 'accept' ? `Accept · ${count(request.stake)} tokens` : 'Decline';
    }
    message(el('gameNotificationMessage'), sameRetry ? 'Connection lost. Retry safely.' : games.notificationError?.id === request.id ? games.notificationError.text : '');
  }
  function render() {
    const loading = document.body.classList.contains('auth-loading');
    el('gamesLoading').hidden = !loading && (!state.user || games.loaded);
    el('gamesGuest').hidden = loading || !!state.user; el('gamesAccount').hidden = loading || !state.user;
    el('gamesBalance').textContent = state.user ? `${count(state.user.balance)} tokens` : '';
    for (const input of el('gamesRequestForm').querySelectorAll('input')) input.disabled = locked();
    el('gamesSend').disabled = locked(); el('gamesSend').textContent = games.action?.action === 'request' ? 'Sending…' : 'Send request';
    el('gamesRefresh').disabled = busy() || games.loading;
    el('gamesRetry').hidden = !games.retry; el('gamesRetry').disabled = busy(); el('gamesBack').disabled = busy();
    const focused = document.activeElement?.closest('[data-game-action]');
    const focusData = focused ? { ...focused.dataset } : null;
    renderLists(); renderSession(); renderNotification();
    if (focusData && !document.contains(focused)) {
      const replacement = Array.from(document.querySelectorAll('[data-game-action]')).find(node => !node.disabled && Object.keys(focusData).every(key => node.dataset[key] === focusData[key]));
      if (replacement) replacement.focus({ preventScroll: true });
      else if (pageKind === 'games') el(games.selectedId ? 'gamesBack' : 'gamesRefresh').focus({ preventScroll: true });
    }
  }
  function syncUser() {
    const identity = state.user?.accountId || null;
    if (identity !== games.identity) {
      Object.assign(games, { identity, revision: games.revision + 1, entries: [], selectedId: null, loading: false, loaded: false, action: null, retry: null, notificationId: null, notificationError: null, resignId: null, listSignature: null, sessionSignature: null });
      el('gamesRequestForm').reset(); message(el('gamesMessage'), '');
      if (identity) void load();
    }
    render();
  }
  async function load() {
    if (!state.user || games.loading || busy()) { renderNotification(); return; }
    const identity = games.identity, identityRevision = userIdentityRevision, revision = games.revision, accountRevision = authRevision;
    games.loading = true;
    try {
      const data = await api('games');
      if (!current(identity, identityRevision) || games.revision !== revision) return;
      const previous = games.entries;
      games.entries = data.games.map(game => newest(game, previous.find(entry => entry.id === game.id)));
      const selected = previous.find(game => game.id === games.selectedId);
      if (selected && !games.entries.some(game => game.id === selected.id)) games.entries.push(selected);
      games.loaded = true;
      if (accountRevision === authRevision) updateUser(data.user);
      if (games.retry?.action === 'request') {
        const saved = games.entries.find(game => game.clientRequestId === games.retry.payload.clientRequestId && game.sender.accountId === identity);
        if (saved) { games.retry = null; message(el('gamesMessage'), 'Request sent.', true); }
      }
    } catch (error) {
      if (!current(identity, identityRevision) || games.revision !== revision) return;
      if (error.status === 401) { setUser(null); return; }
      games.loaded = true;
      if (pageKind === 'games') message(el('gamesMessage'), 'Refresh failed. Try again.');
    } finally {
      if (current(identity, identityRevision) && games.revision === revision) { games.loading = false; render(); }
    }
  }
  function openGame(id) {
    games.selectedId = id; games.resignId = null; games.sessionSignature = null; message(el('gamesMessage'), ''); render();
  }
  async function perform(operation) {
    if (!state.user || busy() || (games.retry && games.retry !== operation)) return;
    const identity = games.identity, identityRevision = userIdentityRevision, navigationRevision = routeRevision, accountRevision = authRevision;
    games.revision++; games.loading = false; games.action = operation; games.notificationError = null;
    message(el('gamesMessage'), operation.action === 'request' ? 'Sending request…' : 'Saving…'); render();
    try {
      const data = await api(operation.action === 'request' ? 'games' : `games/${encodeURIComponent(operation.id)}/${operation.action}`, { method: 'POST', body: JSON.stringify(operation.payload || {}) });
      if (!current(identity, identityRevision)) return;
      remember(data.game); games.retry = null; games.resignId = null; if (accountRevision === authRevision) updateUser(data.user);
      if (operation.action === 'request') el('gamesRequestForm').reset();
      if (['request', 'accept'].includes(operation.action) && pageKind === 'games' && navigationRevision === routeRevision) openGame(data.game.id);
      message(el('gamesMessage'), operation.action === 'request' ? 'Request sent.' : operation.action === 'decline' ? 'Request declined.' : operation.action === 'cancel' ? 'Request cancelled.' : '', true);
    } catch (error) {
      if (!current(identity, identityRevision)) return;
      if (error.status === 401) { setUser(null); return; }
      if (accountRevision === authRevision) updateUser(error.user);
      games.retry = !error.status || error.status >= 500 ? operation : null;
      const text = games.retry ? 'Connection lost. Retry safely.' : error.message;
      games.notificationError = { id: operation.id, text }; message(el('gamesMessage'), text);
    } finally {
      if (current(identity, identityRevision)) { games.action = null; render(); void load(); }
    }
  }
  async function requestGame(event) {
    event.preventDefault();
    if (!state.user || locked()) return;
    const username = el('gamesUsername').value.trim(), rawStake = el('gamesStake').value.trim(), stake = Number(rawStake);
    if (!username) { message(el('gamesMessage'), 'Enter a username.'); return; }
    if (!rawStake || !Number.isSafeInteger(stake) || stake < 0) { message(el('gamesMessage'), 'Enter whole tokens.'); return; }
    if (stake > state.user.balance) { message(el('gamesMessage'), 'Not enough tokens.'); return; }
    const gameType = el('gamesRequestForm').querySelector('input[name="gameType"]:checked').value;
    const identity = games.identity, identityRevision = userIdentityRevision, navigationRevision = routeRevision;
    games.action = { action: 'request' }; render(); message(el('gamesMessage'), 'Finding player…');
    try {
      const data = await api(`profiles/${encodeURIComponent(username)}`);
      if (!current(identity, identityRevision) || navigationRevision !== routeRevision || pageKind !== 'games') return;
      if (data.profile.accountId === identity) { message(el('gamesMessage'), 'Choose another player.'); return; }
      games.action = null;
      await perform({ action: 'request', payload: { recipientAccountId: data.profile.accountId, game: gameType, stake, clientRequestId: crypto.randomUUID() } });
    } catch (error) {
      if (!current(identity, identityRevision)) return;
      if (error.status === 401) setUser(null); else message(el('gamesMessage'), error.message);
    } finally { if (current(identity, identityRevision)) { games.action = null; render(); } }
  }
  function act(action, id, payload = {}) {
    if (action === 'open') { if (!busy()) openGame(id); return; }
    if (locked()) return;
    if (action === 'review-resign' || action === 'keep-playing') { games.resignId = action === 'review-resign' ? id : null; render(); return; }
    if (action === 'accept') { setChatOpen(false); navigateTo('/games', { focus: false }); openGame(id); }
    if (['accept', 'decline', 'cancel', 'resign', 'move'].includes(action)) void perform({ id, action, payload });
  }
  function onRoute() { render(); if (pageKind === 'games' && state.user) void load(); }
  el('gamesRequestForm').addEventListener('submit', event => void requestGame(event));
  el('gamesPage').addEventListener('click', event => {
    const target = event.target.closest('[data-game-action]'); if (!target || target.disabled) return;
    const payload = target.dataset.gameAction === 'move' ? { clientMoveId: crypto.randomUUID(), ...(target.dataset.position !== undefined ? { position: Number(target.dataset.position) } : { choice: target.dataset.choice }) } : {};
    act(target.dataset.gameAction, target.dataset.gameId, payload);
  });
  el('gamesBack').addEventListener('click', () => { if (!busy()) { games.selectedId = null; games.resignId = null; render(); } });
  el('gamesRefresh').addEventListener('click', () => void load());
  el('gamesRetry').addEventListener('click', () => { if (games.retry) void perform(games.retry); });
  el('gamesJoin').addEventListener('click', () => el('accountButton').click());
  for (const action of ['accept', 'decline']) el(action === 'accept' ? 'gameNotificationAccept' : 'gameNotificationDecline').addEventListener('click', () => {
    if (games.retry?.id === games.notificationId && games.retry.action === action) void perform(games.retry);
    else if (games.notificationId) act(action, games.notificationId);
  });
  window.PepperGames = { syncUser, load, onRoute, renderNotification };
  syncUser(); onRoute(); setInterval(renderDeadline, 1000);
})();
