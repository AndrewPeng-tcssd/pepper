(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const names = { 'tic-tac-toe': 'Tic-Tac-Toe', 'rock-paper-scissors': 'Rock Paper Scissors', dice: 'Dice' };
  const choiceNames = { rock: 'Rock', paper: 'Paper', scissors: 'Scissors' };
  const choiceIcons = { rock: '✊', paper: '✋', scissors: '✌' };
  const payoutLabel = game => game.payoutMode === 'shared' ? 'Shared' : 'Single winner';
  const games = { identity: null, revision: 0, entries: [], selectedId: null, loading: false, loaded: false, action: null, retry: null, notificationId: null, listSignature: null, sessionSignature: null, invitees: [], pickedPlayer: null, draftRevision: 0 };
  const active = game => ['pending', 'playing'].includes(game.status);
  const validStake = stake => Number.isSafeInteger(stake) && stake >= 1 && stake <= Math.floor(Number.MAX_SAFE_INTEGER / 4);
  const invalidRequest = game => game.status === 'pending' && !validStake(game.stake);
  const busy = () => !!games.action || state.accountSubmitting;
  const locked = () => busy() || !!games.retry;
  const participants = game => game.players?.length ? game.players : [game.sender, game.recipient];
  const self = game => participants(game).find(player => player.accountId === games.identity);
  const opponents = game => participants(game).filter(player => player.accountId !== games.identity);
  const isInvited = game => game.sender.accountId !== games.identity && !!self(game);
  const needsAcceptance = game => isInvited(game) && (game.game !== 'dice' || !self(game).accepted);
  const gameType = () => el('gamesRequestForm').querySelector('input[name="gameType"]:checked').value;
  const opponentType = () => gameType() !== 'dice' && el('gamesOpponentType').value === 'bot' ? 'bot' : 'player';
  const playerCount = () => Math.max(2, Math.min(4, Number(el('gamesPlayerCount').value) || 2));
  const current = (identity, identityRevision) => state.user?.accountId === identity && games.identity === identity && userIdentityRevision === identityRevision;
  const count = value => Number(value || 0).toLocaleString();
  const playerPicker = window.PepperPlayerPicker?.attach({
    input: el('gamesUsername'),
    isEnabled: () => !!state.user && !accountBanned && pageKind === 'games' && !games.selectedId && !locked() && opponentType() === 'player',
    renderAvatar: player => profileAvatar(player),
    search: async prefix => {
      const identity = games.identity, revision = userIdentityRevision, navigation = routeRevision, draftRevision = games.draftRevision;
      const { players } = await api(`players?username=${encodeURIComponent(prefix)}`);
      return current(identity, revision) && navigation === routeRevision && pageKind === 'games' && draftRevision === games.draftRevision && opponentType() === 'player' ? players.filter(player => player.accountId !== identity && (gameType() !== 'dice' || !games.invitees.some(invitee => invitee.accountId === player.accountId))) : [];
    },
    onSelect: player => { games.pickedPlayer = player; message(el('gamesMessage'), ''); }
  });
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
    if (game.game === 'dice' && game.status === 'completed' && game.result !== 'draw') {
      const place = game.placements?.find(placement => placement.accountId === games.identity)?.place;
      if (game.payoutMode === 'shared' && place) return `${place}${['st', 'nd', 'rd', 'th'][place - 1]} place`;
    }
    if (game.status === 'completed') return game.result === 'draw' ? 'Draw' : game.winnerAccountId === games.identity ? 'You won' : 'You lost';
    return { pending: 'Requested', playing: 'In progress', declined: 'Declined', cancelled: 'Cancelled', expired: 'Expired' }[game.status] || game.status;
  }
  function playerLink(player) {
    if (player.isBot) {
      const identity = document.createElement('span'); identity.className = 'player-identity games-bot-identity';
      const icon = document.createElement('span'); icon.className = 'games-bot-avatar'; icon.textContent = '🤖'; icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.textContent = 'Bot'; identity.append(icon, name); return identity;
    }
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
      if (needsAcceptance(game)) container.append(button(invalidRequest(game) ? 'Invalid bet' : `Accept · ${count(game.stake)} tokens`, 'accept', game.id, locked() || invalidRequest(game)), button('Decline', 'decline', game.id));
      else if (game.sender.accountId === games.identity) container.append(button('Cancel request', 'cancel', game.id));
      else { const waiting = document.createElement('span'); waiting.textContent = 'Waiting for players'; container.append(waiting); }
    } else if (game.status === 'playing' && game.game !== 'dice') container.append(button('Resign', 'review-resign', game.id));
  }
  function renderDraft() {
    const dice = gameType() === 'dice';
    if (dice) el('gamesOpponentType').value = 'player';
    const bot = opponentType() === 'bot';
    el('gamesOpponentOptions').hidden = dice;
    el('gamesOpponentType').disabled = locked() || dice;
    el('gamesUsernameLabel').hidden = bot;
    el('gamesUsernameField').hidden = bot;
    el('gamesUsername').disabled = locked() || bot;
    el('gamesBotNote').hidden = !bot;
    el('gamesDiceOptions').hidden = !dice;
    el('gamesAddPlayer').hidden = !dice;
    el('gamesInvitees').hidden = !dice;
    el('gamesUsername').required = !dice && !bot;
    el('gamesPayoutModeField').hidden = !dice || playerCount() === 2;
    el('gamesAddPlayer').disabled = locked() || games.invitees.length >= playerCount() - 1;
    const signature = JSON.stringify([games.identity, dice, playerCount(), locked(), games.invitees]);
    if (signature === games.draftSignature) return;
    games.draftSignature = signature;
    el('gamesInvitees').replaceChildren(...games.invitees.map(player => {
      const row = document.createElement('div'); row.className = 'games-invitee';
      row.append(playerLink(player));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button games-invitee-remove'; remove.textContent = 'Remove'; remove.disabled = locked();
      remove.dataset.gameRemovePlayer = player.accountId;
      remove.setAttribute('aria-label', `Remove ${player.username}`); row.append(remove); return row;
    }));
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
        const terms = document.createElement('p'); terms.className = 'games-list-stake'; terms.textContent = invalidRequest(game) ? 'Invalid bet' : `${count(game.stake)} tokens each${game.game === 'dice' ? ' · ' + payoutLabel(game) : ''}`;
        const actions = document.createElement('div'); actions.className = 'trading-actions'; gameActions(game, actions, true);
        const roster = document.createElement('div'); roster.className = 'games-list-players'; roster.append(...opponents(game).map(playerLink));
        row.append(heading, roster, terms, actions); return row;
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
  function diceFace(value, label, small = false) {
    const face = document.createElement('span'); face.className = `games-die${small ? ' games-die-small' : ''}`;
    face.dataset.value = Number.isInteger(value) && value >= 1 && value <= 6 ? String(value) : '';
    face.classList.toggle('is-waiting', !face.dataset.value);
    face.setAttribute('role', 'img'); face.setAttribute('aria-label', label);
    for (let position = 1; position <= 9; position++) {
      const pip = document.createElement('span'); pip.className = 'games-die-pip'; pip.dataset.position = String(position); pip.setAttribute('aria-hidden', 'true'); face.append(pip);
    }
    return face;
  }
  function diceRolling(game) {
    return game.game === 'dice' && game.status === 'playing' && games.action?.action === 'move' && games.action.id === game.id && games.action.payload?.round === game.dice?.round;
  }
  function renderDice(game, showPlay) {
    el('gamesRolls').replaceChildren(); el('gamesRollAction').replaceChildren(); el('gamesPlacements').replaceChildren(); el('gamesDiceHistory').replaceChildren();
    if (!showPlay || game.game !== 'dice') return;
    const dice = game.dice || {}, history = dice.history || [];
    el('gamesDiceRound').textContent = dice.round > 1 && game.status === 'playing' ? `Roll again · Round ${dice.round}` : `Round ${dice.round || 1}`;
    for (const player of [self(game), ...opponents(game)].filter(Boolean)) {
      const row = document.createElement('div'); row.className = 'games-dice-player'; row.append(playerLink(player));
      let value = dice.rolls?.[player.accountId];
      const fixedGroup = dice.groups?.find(group => group.length === 1 && group[0] === player.accountId);
      const eliminated = game.payoutMode === 'single-winner' && !dice.groups?.[0]?.includes(player.accountId);
      if (value === undefined && (fixedGroup || eliminated || game.status === 'completed')) {
        for (let index = history.length - 1; index >= 0 && value === undefined; index--) value = history[index].rolls?.[player.accountId];
      }
      const rolling = player.accountId === games.identity && diceRolling(game);
      const face = diceFace(rolling ? 6 : value, `${player.accountId === games.identity ? 'Your' : player.username + '’s'} roll: ${rolling ? 'rolling' : value === undefined ? 'waiting' : value}`);
      face.classList.toggle('is-rolling', rolling); row.append(face);
      if (fixedGroup && game.status === 'playing' && game.payoutMode === 'shared') {
        const rank = document.createElement('span'); rank.className = 'games-dice-place'; rank.textContent = `Place ${dice.groups.slice(0, dice.groups.indexOf(fixedGroup)).reduce((total, group) => total + group.length, 1)}`; row.append(rank);
      }
      if (game.status === 'completed' && game.payoutMode === 'shared') {
        const placement = game.placements?.find(placement => placement.accountId === player.accountId);
        if (placement?.place) { const rank = document.createElement('span'); rank.className = 'games-dice-place'; rank.textContent = `Place ${placement.place}`; row.append(rank); }
      }
      if (eliminated && game.status === 'playing') { const label = document.createElement('span'); label.className = 'games-dice-place'; label.textContent = 'Eliminated'; row.append(label); }
      el('gamesRolls').append(row);
    }
    if (game.status === 'playing') {
      const eligible = game.eligibleAccountIds?.includes(games.identity);
      const roll = button(diceRolling(game) ? 'Rolling…' : eligible ? 'Roll' : dice.rolls?.[games.identity] !== undefined ? 'Rolled' : 'Waiting', 'move', game.id, locked() || !eligible);
      roll.dataset.round = String(dice.round || 1); el('gamesRollAction').append(roll);
    }
    const placements = game.result === 'draw' && !(game.placements || []).length ? participants(game).map(player => ({ accountId: player.accountId, payout: game.payouts?.[player.accountId] ?? game.stake })) : game.placements || [];
    for (const placement of placements) {
      const player = participants(game).find(entry => entry.accountId === placement.accountId); if (!player) continue;
      const row = document.createElement('div'); row.className = 'games-placement';
      const rank = document.createElement('span'); rank.className = 'games-placement-rank'; rank.textContent = game.result === 'draw' ? 'Draw' : game.payoutMode === 'single-winner' ? placement.accountId === game.winnerAccountId ? 'Winner' : 'Player' : placement.place ? `Place ${placement.place}` : 'Draw';
      const payout = document.createElement('strong'); payout.className = 'games-placement-payout'; payout.textContent = `${count(placement.payout)} tokens`;
      row.append(rank, playerLink(player), payout); el('gamesPlacements').append(row);
    }
    for (const round of history) {
      if (round.round === dice.round) continue;
      const row = document.createElement('p'); row.className = 'games-dice-history-round';
      const title = document.createElement('span'); title.textContent = `Round ${round.round}:`; row.append(title);
      for (const player of participants(game).filter(player => round.rolls?.[player.accountId] !== undefined)) {
        const result = document.createElement('span'); result.className = 'games-dice-history-player';
        const name = document.createElement('span'); name.textContent = player.username;
        result.append(name, diceFace(round.rolls[player.accountId], `${player.username}’s roll: ${round.rolls[player.accountId]}`, true)); row.append(result);
      }
      el('gamesDiceHistory').append(row);
    }
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
    const xAccountId = game.xAccountId ?? (['playing', 'completed'].includes(game.status) ? game.sender.accountId : null);
    el('gamesPlayers').replaceChildren(...[self(game), ...opponents(game)].filter(Boolean).map((player, index) => {
      const side = document.createElement('div'); side.className = 'games-player';
      const label = document.createElement('span'); label.className = 'games-player-label';
      label.textContent = index === 0 ? 'You' : game.game === 'dice' ? 'Player' : 'Opponent'; side.append(label, playerLink(player));
      if (game.game === 'dice' && game.status === 'pending') { const accepted = document.createElement('span'); accepted.className = 'games-player-ready'; accepted.textContent = player.accepted ? 'Accepted' : 'Invited'; side.append(accepted); }
      if (game.game === 'tic-tac-toe' && xAccountId) { const symbol = document.createElement('strong'); symbol.className = 'games-player-symbol'; symbol.textContent = player.accountId === xAccountId ? 'X' : 'O'; side.append(symbol); }
      return side;
    }));
    el('gamesStakeSummary').textContent = invalidRequest(game) ? 'Invalid bet' : `${count(game.stake)} tokens each`;
    el('gamesPot').textContent = invalidRequest(game) ? '' : `${count(game.pot ?? game.stake * participants(game).length)} token pot${game.game === 'dice' ? ' · ' + payoutLabel(game) : ''}`;
    const ended = game.status === 'completed';
    const opponentName = game.opponentType === 'bot' ? 'Bot' : 'Opponent';
    el('gamesTurn').textContent = game.status === 'pending' ? 'Awaiting acceptance' : ended ? game.result === 'draw' ? 'Draw · stakes returned' : game.winnerAccountId === games.identity ? `You won ${count(game.stake * 2)} tokens` : `${opponentName} won the pot` : game.status !== 'playing' ? status(game) : game.game === 'tic-tac-toe' ? game.turnAccountId === games.identity ? 'Your turn' : `${opponentName}’s turn` : game.yourChoice ? 'Waiting for opponent' : 'Choose your move';
    if (game.game === 'dice') el('gamesTurn').textContent = game.status === 'pending' ? 'Waiting for players' : ended ? game.result === 'draw' ? 'Draw · stakes returned' : `${count(game.payouts?.[games.identity] ?? game.placements?.find(placement => placement.accountId === games.identity)?.payout)} tokens received` : game.status !== 'playing' ? status(game) : game.eligibleAccountIds?.includes(games.identity) ? 'Roll your dice' : 'Waiting for rolls';
    if (diceRolling(game)) el('gamesTurn').textContent = 'Rolling…';
    const showPlay = game.status === 'playing' || ended;
    el('gamesPlayers').hidden = showPlay && game.game === 'dice';
    el('gamesBoard').hidden = !showPlay || game.game !== 'tic-tac-toe';
    el('gamesRps').hidden = !showPlay || game.game !== 'rock-paper-scissors';
    el('gamesDice').hidden = !showPlay || game.game !== 'dice';
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
      theirs.textContent = `${opponentName}: ${choiceNames[opponentChoice] || (game.opponentChosen ? 'Ready' : ended ? 'No move' : 'Choosing…')}`;
      el('gamesReveal').append(yours, theirs);
    }
    renderDice(game, showPlay);
    const actions = el('gamesSessionActions'); actions.replaceChildren();
    if (games.resignId === game.id && game.status === 'playing') {
      actions.append(button('Confirm resignation', 'resign', game.id), button('Keep playing', 'keep-playing', game.id));
    } else gameActions(game, actions);
  }
  function renderNotification() {
    const requests = games.entries.filter(game => game.status === 'pending' && needsAcceptance(game))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const request = requests.find(game => game.id === games.notificationId) || requests[0];
    games.notificationId = request?.id || null;
    const popup = el('gameNotification'), focused = popup.contains(document.activeElement);
    popup.hidden = !state.user || !request || !el('tradeNotification').hidden;
    if (popup.hidden) { if (focused) focusRouteHeading(); return; }
    el('gameNotificationSender').textContent = request.sender.username;
    el('gameNotificationSender').href = profileHref(request.sender.username);
    el('gameNotificationTerms').textContent = invalidRequest(request) ? `${names[request.game]} · Invalid bet` : `${names[request.game]}${request.game === 'dice' ? ` · ${participants(request).length} players · ${payoutLabel(request)}` : ''} · ${count(request.stake)} tokens each`;
    const sameRetry = games.retry?.id === request.id;
    for (const action of ['accept', 'decline']) {
      const control = el(action === 'accept' ? 'gameNotificationAccept' : 'gameNotificationDecline');
      control.disabled = busy() || (action === 'accept' && invalidRequest(request)) || (!!games.retry && !(sameRetry && games.retry.action === action));
      control.textContent = action === 'accept' && invalidRequest(request) ? 'Invalid bet' : games.action?.id === request.id && games.action.action === action ? action === 'accept' ? 'Accepting…' : 'Declining…' : sameRetry && games.retry.action === action ? 'Retry' : action === 'accept' ? `Accept · ${count(request.stake)} tokens` : 'Decline';
    }
    message(el('gameNotificationMessage'), sameRetry ? 'Connection lost. Retry safely.' : games.notificationError?.id === request.id ? games.notificationError.text : '');
  }
  function render() {
    const loading = document.body.classList.contains('auth-loading');
    el('gamesLoading').hidden = !loading && (!state.user || games.loaded);
    el('gamesGuest').hidden = loading || !!state.user; el('gamesAccount').hidden = loading || !state.user;
    el('gamesBalance').textContent = state.user ? `${count(state.user.balance)} tokens` : '';
    for (const input of el('gamesRequestForm').querySelectorAll('input, select')) input.disabled = locked();
    renderDraft();
    if (locked() || games.selectedId || !state.user || pageKind !== 'games' || opponentType() === 'bot') playerPicker?.close();
    const botRequest = games.action?.action === 'request' ? games.action.payload?.opponentType === 'bot' : opponentType() === 'bot';
    el('gamesSend').disabled = locked(); el('gamesSend').textContent = games.action?.action === 'request' ? botRequest ? 'Starting…' : 'Sending…' : botRequest ? 'Start match' : 'Send request';
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
      playerPicker?.reset();
      Object.assign(games, { identity, revision: games.revision + 1, entries: [], selectedId: null, loading: false, loaded: false, action: null, retry: null, notificationId: null, notificationError: null, resignId: null, listSignature: null, sessionSignature: null, invitees: [], pickedPlayer: null, draftRevision: games.draftRevision + 1 });
      el('gamesRequestForm').reset(); el('gamesOpponentType').value = 'player'; message(el('gamesMessage'), '');
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
        if (saved) { games.retry = null; message(el('gamesMessage'), saved.opponentType === 'bot' ? 'Match started.' : 'Request sent.', true); }
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
    const botRequest = operation.action === 'request' && operation.payload.opponentType === 'bot';
    message(el('gamesMessage'), operation.action === 'request' ? botRequest ? 'Starting match…' : 'Sending request…' : 'Saving…'); render();
    try {
      const game = games.entries.find(entry => entry.id === operation.id);
      const animateRoll = game && diceRolling(game) && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const animation = animateRoll ? new Promise(resolve => setTimeout(resolve, 700)) : Promise.resolve();
      const [data] = await Promise.all([api(operation.action === 'request' ? 'games' : `games/${encodeURIComponent(operation.id)}/${operation.action}`, { method: 'POST', body: JSON.stringify(operation.payload || {}) }), animation]);
      if (!current(identity, identityRevision)) return;
      remember(data.game); games.retry = null; games.resignId = null; if (accountRevision === authRevision) updateUser(data.user);
      if (operation.action === 'request') { el('gamesRequestForm').reset(); el('gamesOpponentType').value = 'player'; games.invitees = []; games.pickedPlayer = null; games.draftRevision++; }
      if (['request', 'accept'].includes(operation.action) && pageKind === 'games' && navigationRevision === routeRevision) openGame(data.game.id);
      message(el('gamesMessage'), operation.action === 'request' ? botRequest ? 'Match started.' : 'Request sent.' : operation.action === 'decline' ? 'Request declined.' : operation.action === 'cancel' ? 'Request cancelled.' : '', true);
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
  async function addPlayer() {
    playerPicker?.close();
    if (!state.user || locked() || gameType() !== 'dice' || games.invitees.length >= playerCount() - 1) return;
    const username = el('gamesUsername').value.trim();
    if (!username) { message(el('gamesMessage'), 'Enter a username.'); return; }
    const identity = games.identity, identityRevision = userIdentityRevision, navigationRevision = routeRevision, draftRevision = games.draftRevision;
    const picked = games.pickedPlayer?.username.toLowerCase() === username.toLowerCase() ? games.pickedPlayer : null;
    games.action = { action: 'add-player' }; render(); message(el('gamesMessage'), 'Finding player…');
    try {
      const player = picked || (await api(`profiles/${encodeURIComponent(username)}`)).profile;
      if (!current(identity, identityRevision) || navigationRevision !== routeRevision || pageKind !== 'games' || draftRevision !== games.draftRevision || gameType() !== 'dice') return;
      if (player.accountId === identity) { message(el('gamesMessage'), 'Choose another player.'); return; }
      if (games.invitees.some(invitee => invitee.accountId === player.accountId)) { message(el('gamesMessage'), 'Player already added.'); return; }
      games.invitees.push(player); games.pickedPlayer = null; games.draftRevision++;
      el('gamesUsername').value = ''; message(el('gamesMessage'), '');
    } catch (error) {
      if (!current(identity, identityRevision) || navigationRevision !== routeRevision) return;
      if (error.status === 401) setUser(null); else message(el('gamesMessage'), error.message);
    } finally { if (current(identity, identityRevision)) { games.action = null; render(); } }
  }
  async function requestGame(event) {
    event.preventDefault();
    playerPicker?.close();
    if (!state.user || locked()) return;
    const username = el('gamesUsername').value.trim(), rawStake = el('gamesStake').value.trim(), stake = Number(rawStake), type = gameType(), bot = opponentType() === 'bot';
    if (type !== 'dice' && !bot && !username) { message(el('gamesMessage'), 'Enter a username.'); return; }
    if (!rawStake || !validStake(stake)) { message(el('gamesMessage'), 'Bet at least 1 token.'); return; }
    if (stake > state.user.balance) { message(el('gamesMessage'), 'Not enough tokens.'); return; }
    if (bot) {
      await perform({ action: 'request', payload: { opponentType: 'bot', game: type, stake, clientRequestId: crypto.randomUUID() } });
      return;
    }
    if (type === 'dice') {
      const needed = playerCount() - 1 - games.invitees.length;
      if (needed !== 0) { message(el('gamesMessage'), `Add ${needed} more ${needed === 1 ? 'player' : 'players'}.`); return; }
      await perform({ action: 'request', payload: { recipientAccountIds: games.invitees.map(player => player.accountId), game: type, stake, payoutMode: playerCount() === 2 ? 'single-winner' : el('gamesPayoutMode').value, clientRequestId: crypto.randomUUID() } });
      return;
    }
    const identity = games.identity, identityRevision = userIdentityRevision, navigationRevision = routeRevision;
    games.action = { action: 'request' }; render(); message(el('gamesMessage'), 'Finding player…');
    try {
      const data = await api(`profiles/${encodeURIComponent(username)}`);
      if (!current(identity, identityRevision) || navigationRevision !== routeRevision || pageKind !== 'games') return;
      if (data.profile.accountId === identity) { message(el('gamesMessage'), 'Choose another player.'); return; }
      games.action = null;
      await perform({ action: 'request', payload: { recipientAccountId: data.profile.accountId, game: type, stake, clientRequestId: crypto.randomUUID() } });
    } catch (error) {
      if (!current(identity, identityRevision)) return;
      if (error.status === 401) setUser(null); else message(el('gamesMessage'), error.message);
    } finally { if (current(identity, identityRevision)) { games.action = null; render(); } }
  }
  function act(action, id, payload = {}) {
    if (action === 'open') { if (!busy()) openGame(id); return; }
    if (locked()) return;
    const game = games.entries.find(entry => entry.id === id);
    if (game?.game === 'dice' && ['review-resign', 'resign'].includes(action)) return;
    if (game?.game === 'dice' && action === 'move' && (game.status !== 'playing' || !game.eligibleAccountIds?.includes(games.identity) || payload.round !== game.dice?.round)) return;
    if (game?.game === 'dice' && action === 'accept' && !needsAcceptance(game)) return;
    if (action === 'accept' && games.entries.some(game => game.id === id && invalidRequest(game))) { message(el('gamesMessage'), 'Invalid bet. Decline request.'); return; }
    if (action === 'review-resign' || action === 'keep-playing') { games.resignId = action === 'review-resign' ? id : null; render(); return; }
    if (action === 'accept') { setChatOpen(false); navigateTo('/games', { focus: false }); openGame(id); }
    if (['accept', 'decline', 'cancel', 'resign', 'move'].includes(action)) void perform({ id, action, payload });
  }
  function onRoute() { render(); if (pageKind === 'games' && state.user) void load(); }
  el('gamesRequestForm').addEventListener('submit', event => void requestGame(event));
  el('gamesPage').addEventListener('click', event => {
    const remove = event.target.closest('[data-game-remove-player]');
    if (remove && !remove.disabled && !locked()) { games.invitees = games.invitees.filter(player => player.accountId !== remove.dataset.gameRemovePlayer); games.draftRevision++; renderDraft(); return; }
    const target = event.target.closest('[data-game-action]'); if (!target || target.disabled) return;
    const payload = target.dataset.gameAction === 'move' ? { clientMoveId: crypto.randomUUID(), ...(target.dataset.round !== undefined ? { round: Number(target.dataset.round) } : target.dataset.position !== undefined ? { position: Number(target.dataset.position) } : { choice: target.dataset.choice }) } : {};
    act(target.dataset.gameAction, target.dataset.gameId, payload);
  });
  el('gamesAddPlayer').addEventListener('click', () => void addPlayer());
  el('gamesRequestForm').addEventListener('change', event => {
    if (locked() || ['gamesUsername', 'gamesStake'].includes(event.target.id)) return;
    games.draftRevision++; games.pickedPlayer = null;
    games.invitees = games.invitees.slice(0, playerCount() - 1);
    playerPicker?.close(); render();
  });
  el('gamesUsername').addEventListener('input', () => { games.pickedPlayer = null; });
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
