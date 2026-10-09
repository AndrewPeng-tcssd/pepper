(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const moderation = { identity: null, role: 'player', open: false, players: [], busy: false, revision: 0, deleteId: null };
  const privileged = () => ['admin', 'mod'].includes(accountRole(state.user)) && !state.user?.banned;
  const storageKey = id => `pepper-moderation-view:${id}`;
  function enabled() { return privileged() && moderation.identity === state.user?.accountId && moderation.open && !accountBanned; }
  function storedOpen(id) { try { return localStorage.getItem(storageKey(id)) === 'open'; } catch { return false; } }
  function canBan(player) {
    return enabled() && player.accountId !== state.user.accountId && accountRole(player) !== 'admin' && (accountRole(state.user) === 'admin' || accountRole(player) === 'player');
  }
  function canDeleteChat(item) {
    if (!enabled() || item.deleted || item.status || !item.id) return false;
    return accountRole(state.user) === 'admin' || item.accountId === state.user.accountId || accountRole(item) === 'player';
  }
  function chatDeleteButton(item) {
    if (!canDeleteChat(item)) return null;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'chat-delete-button';
    button.dataset.deleteChatId = item.id; button.textContent = moderation.deleteId === item.id ? 'Confirm delete' : 'Delete';
    button.disabled = moderation.busy || state.accountSubmitting; button.setAttribute('aria-label', `${button.textContent}: ${item.text}`); return button;
  }
  function refreshChatControls() {
    const focusedId = document.activeElement?.dataset.deleteChatId;
    el('chatMessages').querySelectorAll('.chat-delete-button').forEach(button => button.remove());
    el('chatMessages').querySelectorAll('.chat-row').forEach(row => {
      const item = state.chatMessages.find(message => message.id === row.dataset.messageId);
      const button = item && chatDeleteButton(item); if (button) row.append(button);
    });
    if (focusedId) {
      const replacement = Array.from(el('chatMessages').querySelectorAll('.chat-delete-button')).find(button => button.dataset.deleteChatId === focusedId && !button.disabled);
      const row = Array.from(el('chatMessages').querySelectorAll('.chat-row')).find(item => item.dataset.messageId === focusedId);
      (replacement || row?.querySelector('.chat-author'))?.focus({ preventScroll: true });
    }
  }
  function refreshEditors() { renderChangelogEditor(); renderAnnouncementEditor(); refreshChatControls(); }
  function actionButton(label, action, player) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.textContent = label;
    button.dataset.moderationAction = action; button.dataset.accountId = player.accountId; button.disabled = moderation.busy || state.accountSubmitting; return button;
  }
  function render() {
    el('moderationSettings').hidden = !privileged() || accountBanned;
    const admin = accountRole(state.user) === 'admin';
    el('moderationTitle').textContent = admin ? 'Admin' : 'Moderation';
    el('moderationViewToggle').textContent = `${enabled() ? 'Close' : 'Open'} ${admin ? 'admin' : 'mod'} view`;
    el('moderationViewToggle').setAttribute('aria-pressed', String(enabled()));
    el('moderationViewToggle').disabled = moderation.busy || state.accountSubmitting;
    el('moderationControls').hidden = !enabled();
    el('moderationChangelog').hidden = !admin;
    el('moderationUsername').disabled = moderation.busy; el('moderationFind').disabled = moderation.busy;
    const focused = document.activeElement?.closest('[data-moderation-action]');
    const focusedId = focused?.dataset.accountId, focusedAction = focused?.dataset.moderationAction;
    el('moderationPlayers').replaceChildren(...moderation.players.map(player => {
      const row = document.createElement('article'); row.className = 'moderation-player';
      const link = document.createElement('a'); link.className = 'player-identity'; link.href = profileHref(player.username);
      const name = document.createElement('span'); name.textContent = player.username; link.append(profileAvatar(player), name, playerRoleBadges(player));
      const actions = document.createElement('div'); actions.className = 'trading-actions';
      if (canBan(player)) actions.append(actionButton(player.banned ? 'Unban' : 'Ban', player.banned ? 'unban' : 'ban', player));
      if (enabled() && admin && accountRole(player) !== 'admin' && player.accountId !== state.user.accountId) actions.append(actionButton(accountRole(player) === 'mod' ? 'Remove mod' : 'Make mod', accountRole(player) === 'mod' ? 'remove-mod' : 'make-mod', player));
      row.append(link, actions); return row;
    }));
    if (focusedId) Array.from(el('moderationPlayers').querySelectorAll('[data-moderation-action]')).find(button => button.dataset.accountId === focusedId && button.dataset.moderationAction === focusedAction && !button.disabled)?.focus({ preventScroll: true });
    refreshChatControls();
  }
  function syncUser() {
    const identity = state.user?.accountId || null, role = accountRole(state.user);
    if (moderation.identity !== identity || moderation.role !== role) {
      Object.assign(moderation, { identity, role, open: !!identity && storedOpen(identity), players: [], busy: false, deleteId: null, revision: moderation.revision + 1 });
      el('moderationSearch').reset(); message(el('moderationMessage'), '');
    }
    if (!privileged()) moderation.open = false;
    if (accountBanned) showBanned();
    else { document.body.classList.remove('banned-mode'); el('bannedScreen').hidden = true; }
    render(); refreshEditors();
  }
  function showBanned() {
    document.body.classList.add('banned-mode'); el('bannedScreen').hidden = false;
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); setChatOpen(false);
    el('bannedTitle').tabIndex = -1; el('bannedTitle').focus({ preventScroll: true });
  }
  async function findPlayers(event) {
    event?.preventDefault(); if (!enabled() || moderation.busy) return;
    const identity = moderation.identity, revision = ++moderation.revision;
    moderation.busy = true; message(el('moderationMessage'), 'Finding players…'); render();
    try {
      const data = await api(`moderation/players?username=${encodeURIComponent(el('moderationUsername').value.trim())}`);
      if (moderation.identity !== identity || moderation.revision !== revision || !enabled()) return;
      moderation.players = data.players; message(el('moderationMessage'), data.players.length ? '' : 'No players found.');
    } catch (error) {
      if (moderation.identity === identity && moderation.revision === revision) message(el('moderationMessage'), error.message);
    } finally { if (moderation.identity === identity && moderation.revision === revision) { moderation.busy = false; render(); } }
  }
  function refreshPlayer(player) {
    const update = person => person?.accountId === player.accountId ? { ...person, role: player.role, banned: player.banned } : person;
    state.chatMessages = state.chatMessages.map(item => ({ ...update(item), ...(item.replyTo ? { replyTo: update(item.replyTo) } : {}) }));
    renderChat(state.chatMessages);
    if (state.profile?.accountId === player.accountId) { state.profile = update(state.profile); renderProfileDetails(state.profile); }
    if (state.leaderboard) {
      state.leaderboard.entries = state.leaderboard.entries.filter(entry => !(player.banned && entry.accountId === player.accountId)).map(update);
      renderLeaderboard(state.leaderboard); void loadLeaderboard(true);
    }
    trading.chatMessages = trading.chatMessages.map(item => ({ ...item, sender: update(item.sender) })); trading.chatSignature = null; renderTradeChat();
    void loadPresence(true); void window.PepperGames?.load();
  }
  async function changePlayer(player, action) {
    if (!enabled() || moderation.busy || state.accountSubmitting) return;
    const roleChange = ['make-mod', 'remove-mod'].includes(action);
    if (roleChange ? accountRole(state.user) !== 'admin' || accountRole(player) === 'admin' || player.accountId === state.user.accountId : !canBan(player)) return;
    const identity = moderation.identity, revision = ++moderation.revision;
    const payload = roleChange ? { role: action === 'make-mod' ? 'mod' : 'player' } : { banned: action === 'ban' };
    moderation.busy = true; message(el('moderationMessage'), 'Saving…'); render();
    try {
      const data = await api(`moderation/players/${encodeURIComponent(player.accountId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      if (moderation.identity !== identity || moderation.revision !== revision || !enabled()) return;
      moderation.players = moderation.players.map(item => item.accountId === data.player.accountId ? data.player : item);
      refreshPlayer(data.player); message(el('moderationMessage'), action === 'ban' ? 'Player banned.' : action === 'unban' ? 'Player unbanned.' : action === 'make-mod' ? 'Moderator added.' : 'Moderator removed.', true);
    } catch (error) { if (moderation.identity === identity && moderation.revision === revision) message(el('moderationMessage'), error.message); }
    finally { if (moderation.identity === identity && moderation.revision === revision) { moderation.busy = false; render(); } }
  }
  async function deleteChat(item) {
    if (!canDeleteChat(item) || moderation.busy || state.accountSubmitting) return;
    if (moderation.deleteId !== item.id) { moderation.deleteId = item.id; refreshChatControls(); return; }
    const identity = moderation.identity, revision = ++moderation.revision;
    moderation.busy = true; render();
    try {
      await api(`chat/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (moderation.identity !== identity || moderation.revision !== revision) return;
      state.chatMessages = state.chatMessages.map(entry => ({ ...entry, ...(entry.id === item.id ? { deleted: true, text: 'Message deleted.' } : {}), ...(entry.replyTo?.id === item.id ? { replyTo: { ...entry.replyTo, text: 'Message deleted.', available: false } } : {}) }));
      if (state.chatReply?.id === item.id) clearChatReply();
      renderChat(state.chatMessages); void loadChat();
    } catch (error) { if (moderation.identity === identity && moderation.revision === revision) message(el('chatMessage'), error.message); }
    finally { if (moderation.identity === identity && moderation.revision === revision) { moderation.busy = false; moderation.deleteId = null; render(); } }
  }
  el('moderationViewToggle').addEventListener('click', () => {
    if (!privileged() || moderation.busy || state.accountSubmitting) return;
    moderation.open = !moderation.open; moderation.deleteId = null;
    try { localStorage.setItem(storageKey(moderation.identity), moderation.open ? 'open' : 'closed'); } catch {}
    render(); refreshEditors();
  });
  el('moderationSearch').addEventListener('submit', event => void findPlayers(event));
  el('moderationPlayers').addEventListener('click', event => {
    const button = event.target.closest('[data-moderation-action]'); if (!button || button.disabled) return;
    const player = moderation.players.find(item => item.accountId === button.dataset.accountId);
    if (player) void changePlayer(player, button.dataset.moderationAction);
  });
  el('chatMessages').addEventListener('click', event => {
    const button = event.target.closest('[data-delete-chat-id]'); if (!button || button.disabled) return;
    const item = state.chatMessages.find(message => message.id === button.dataset.deleteChatId); if (item) void deleteChat(item);
  });
  el('bannedSignOut').addEventListener('click', async () => {
    el('bannedSignOut').disabled = true; message(el('bannedMessage'), 'Signing out…');
    try {
      await api('logout', { method: 'POST' }); accountBanned = false; setUser(null); syncUser(); navigateTo('/'); el('accountButton').click();
    } catch (error) { message(el('bannedMessage'), error.message); }
    finally { el('bannedSignOut').disabled = false; }
  });
  window.addEventListener('storage', event => {
    if (moderation.identity && event.key === storageKey(moderation.identity)) { moderation.open = event.newValue === 'open'; render(); refreshEditors(); }
  });
  window.PepperModeration = { enabled, syncUser, showBanned, chatDeleteButton };
  syncUser();
})();
