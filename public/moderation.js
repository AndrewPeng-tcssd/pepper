(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const moderation = { identity: null, role: 'player', open: false, players: [], busy: false, revision: 0, searchRevision: 0, searching: false, deleteId: null, profileAccountId: null };
  const newVersionSettings = () => ({ known: '', dirty: false, saving: false, loading: false, open: false, revision: 0, loadRequest: null });
  let versionSettings = newVersionSettings();
  let playerPicker;
  const privileged = () => ['admin', 'mod'].includes(accountRole(state.user)) && !state.user?.banned;
  const storageKey = id => `pepper-moderation-view:${id}`;
  function enabled() { return privileged() && moderation.identity === state.user?.accountId && moderation.open && !accountBanned; }
  const adminEnabled = () => enabled() && accountRole(state.user) === 'admin';
  function validVersion(value) {
    const version = typeof value === 'string' ? value.trim().replace(/^v/i, '') : '';
    return version.length <= 32 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(0|[1-9]\d*)$/.test(version) ? version : null;
  }
  function syncVersion(value) {
    const version = validVersion(value); if (!version) return;
    versionSettings.known = version;
    if (!versionSettings.dirty && !versionSettings.saving) el('adminVersion').value = version;
  }
  function renderVersionSettings() {
    const active = adminEnabled();
    el('adminVersionSettings').hidden = !active;
    el('adminVersion').disabled = !active || versionSettings.saving || state.accountSubmitting;
    el('adminVersionSave').disabled = !active || versionSettings.saving || state.accountSubmitting;
    el('adminVersionSave').textContent = versionSettings.saving ? 'Saving…' : 'Save version';
  }
  async function loadVersion() {
    if (!adminEnabled() || versionSettings.loading || versionSettings.saving) return;
    const settings = versionSettings, revision = settings.revision, request = {};
    settings.loading = true; settings.loadRequest = request;
    message(el('adminVersionMessage'), 'Loading version…');
    const current = () => versionSettings === settings && settings.revision === revision && settings.loadRequest === request && adminEnabled();
    try {
      const data = await api('version');
      if (!current()) return;
      if (!validVersion(data.version)) throw new Error('Version unavailable.');
      syncVersion(data.version); message(el('adminVersionMessage'), '');
    } catch (error) { if (current()) message(el('adminVersionMessage'), error.message); }
    finally {
      if (versionSettings === settings && settings.loadRequest === request) { settings.loading = false; settings.loadRequest = null; renderVersionSettings(); }
    }
  }
  function syncVersionView() {
    const active = adminEnabled();
    if (versionSettings.open === active) return;
    versionSettings.open = active; versionSettings.revision++;
    versionSettings.loading = false; versionSettings.loadRequest = null;
    if (active) void loadVersion();
  }
  async function saveVersion(event) {
    event.preventDefault();
    if (!adminEnabled() || versionSettings.saving || state.accountSubmitting) return;
    const version = validVersion(el('adminVersion').value);
    if (!version) { message(el('adminVersionMessage'), 'Use a version like 0.6.1-2.'); return; }
    const settings = versionSettings, revision = settings.revision;
    settings.saving = true; settings.loading = false; settings.loadRequest = null;
    message(el('adminVersionMessage'), 'Saving…'); renderVersionSettings();
    const current = () => versionSettings === settings && settings.revision === revision && adminEnabled();
    try {
      const data = await api('version', { method: 'PATCH', body: JSON.stringify({ version }) });
      if (!current()) return;
      const savedVersion = validVersion(data.version);
      if (!savedVersion) throw new Error('Version unavailable.');
      settings.dirty = false; settings.known = savedVersion; el('adminVersion').value = savedVersion;
      el('siteVersion').textContent = savedVersion; changelogRevision++;
      message(el('adminVersionMessage'), 'Version saved.', true);
      void loadChangelog(true);
    } catch (error) { if (current()) message(el('adminVersionMessage'), error.message); }
    finally {
      if (versionSettings === settings) {
        settings.saving = false; renderVersionSettings();
        if (settings.revision !== revision && adminEnabled()) void loadVersion();
      }
    }
  }
  function storedOpen(id) { try { return localStorage.getItem(storageKey(id)) === 'open'; } catch { return false; } }
  function canBan(player) {
    return enabled() && !!player?.accountId && player.accountId !== state.user.accountId && accountRole(player) !== 'admin' && (accountRole(state.user) === 'admin' || accountRole(player) === 'player');
  }
  function canChangeRole(player) {
    return enabled() && !!player?.accountId && accountRole(state.user) === 'admin' && accountRole(player) !== 'admin' && player.accountId !== state.user.accountId;
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
  function refreshEditors() { renderChangelogEditor(); renderAnnouncementEditor(); refreshChatControls(); window.PepperNewsComments?.syncUser(); }
  function closePlayerPicker() {
    playerPicker?.reset();
    moderation.searchRevision++;
    if (moderation.searching) { moderation.searching = false; moderation.busy = false; }
  }
  function clearPlayerSelection() {
    closePlayerPicker(); moderation.players = [];
    message(el('moderationMessage'), ''); render();
  }
  function selectPlayer(player) {
    if (!enabled() || moderation.busy || state.accountSubmitting || !player?.accountId || !player.username) return;
    closePlayerPicker(); el('moderationUsername').value = player.username;
    moderation.players = [player]; message(el('moderationMessage'), ''); render();
  }
  function actionButton(label, action, player) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.textContent = label;
    button.dataset.moderationAction = action; button.dataset.accountId = player.accountId; button.disabled = moderation.busy || state.accountSubmitting; return button;
  }
  function renderProfileControls() {
    const player = state.profile;
    const accountId = player?.accountId || null;
    if (moderation.profileAccountId !== accountId) {
      moderation.profileAccountId = accountId;
      message(el('profileModerationMessage'), '');
    }
    const focused = document.activeElement;
    const actions = [];
    if (canChangeRole(player)) actions.push(actionButton(accountRole(player) === 'mod' ? 'Remove mod' : 'Make mod', accountRole(player) === 'mod' ? 'remove-mod' : 'make-mod', player));
    if (canBan(player)) actions.push(actionButton(player.banned ? 'Unban' : 'Ban', player.banned ? 'unban' : 'ban', player));
    el('profileModeration').hidden = !actions.length;
    el('profileModerationActions').replaceChildren(...actions);
    if (focused?.dataset.accountId === accountId) actions.find(button => button.dataset.moderationAction === focused.dataset.moderationAction && !button.disabled)?.focus({ preventScroll: true });
  }
  function render() {
    el('moderationSettings').hidden = !privileged() || accountBanned;
    const admin = accountRole(state.user) === 'admin';
    el('moderationTitle').textContent = admin ? 'Admin' : 'Moderation';
    el('moderationViewToggle').textContent = `${enabled() ? 'Close' : 'Open'} ${admin ? 'admin' : 'mod'} view`;
    el('moderationViewToggle').setAttribute('aria-pressed', String(enabled()));
    el('moderationViewToggle').disabled = moderation.busy || state.accountSubmitting;
    el('moderationControls').hidden = !enabled();
    el('moderationPlayerSettings').hidden = !enabled();
    if (!enabled()) el('moderationPlayerDetails').open = false;
    el('moderationChangelog').hidden = !admin;
    renderVersionSettings();
    el('moderationUsername').disabled = moderation.busy; el('moderationFind').disabled = moderation.busy;
    const focused = document.activeElement?.closest('[data-moderation-action]');
    const focusedId = focused?.dataset.accountId, focusedAction = focused?.dataset.moderationAction;
    el('moderationPlayers').replaceChildren(...moderation.players.map(player => {
      const row = document.createElement('article'); row.className = 'moderation-player';
      const link = document.createElement('a'); link.className = 'player-identity'; link.href = profileHref(player.username);
      const name = document.createElement('span'); name.textContent = player.username; link.append(profileAvatar(player), name, playerRoleBadges(player));
      const actions = document.createElement('div'); actions.className = 'trading-actions';
      if (canBan(player)) actions.append(actionButton(player.banned ? 'Unban' : 'Ban', player.banned ? 'unban' : 'ban', player));
      if (canChangeRole(player)) actions.append(actionButton(accountRole(player) === 'mod' ? 'Remove mod' : 'Make mod', accountRole(player) === 'mod' ? 'remove-mod' : 'make-mod', player));
      row.append(link, actions); return row;
    }));
    if (focusedId) Array.from(el('moderationPlayers').querySelectorAll('[data-moderation-action]')).find(button => button.dataset.accountId === focusedId && button.dataset.moderationAction === focusedAction && !button.disabled)?.focus({ preventScroll: true });
    refreshChatControls();
    renderProfileControls();
  }
  function syncUser() {
    const identity = state.user?.accountId || null, role = accountRole(state.user);
    const changed = moderation.identity !== identity || moderation.role !== role;
    if (changed) {
      closePlayerPicker();
      el('moderationPlayerDetails').open = false;
      versionSettings = newVersionSettings(); el('adminVersion').value = ''; message(el('adminVersionMessage'), '');
      Object.assign(moderation, { identity, role, open: !!identity && storedOpen(identity), players: [], busy: false, deleteId: null, revision: moderation.revision + 1 });
      el('moderationSearch').reset(); message(el('moderationMessage'), ''); message(el('profileModerationMessage'), '');
    }
    if (!privileged()) moderation.open = false;
    if (!enabled()) { closePlayerPicker(); moderation.players = []; }
    if (accountBanned) showBanned();
    else { document.body.classList.remove('banned-mode'); el('bannedScreen').hidden = true; }
    render(); refreshEditors(); syncVersionView();
    if (changed && enabled()) void findPlayers();
  }
  function showBanned() {
    document.body.classList.add('banned-mode'); el('bannedScreen').hidden = false;
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); setChatOpen(false);
    el('bannedTitle').tabIndex = -1; el('bannedTitle').focus({ preventScroll: true });
  }
  async function findPlayers(event) {
    event?.preventDefault(); if (!enabled() || moderation.busy) return;
    playerPicker?.reset();
    const identity = moderation.identity, revision = moderation.revision, searchRevision = ++moderation.searchRevision;
    moderation.busy = true; moderation.searching = true; message(el('moderationMessage'), 'Finding players…'); render();
    try {
      const data = await api(`moderation/players?username=${encodeURIComponent(el('moderationUsername').value.trim())}`);
      if (moderation.identity !== identity || moderation.revision !== revision || moderation.searchRevision !== searchRevision || !enabled()) return;
      moderation.players = data.players; message(el('moderationMessage'), data.players.length ? '' : 'No players found.');
    } catch (error) {
      if (moderation.identity === identity && moderation.revision === revision && moderation.searchRevision === searchRevision && enabled()) message(el('moderationMessage'), error.message);
    } finally { if (moderation.identity === identity && moderation.revision === revision && moderation.searchRevision === searchRevision) { moderation.busy = false; moderation.searching = false; render(); } }
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
  async function changePlayer(player, action, statusTarget = el('moderationMessage')) {
    if (!enabled() || moderation.busy || state.accountSubmitting) return;
    if (!['make-mod', 'remove-mod', 'ban', 'unban'].includes(action)) return;
    const roleChange = ['make-mod', 'remove-mod'].includes(action);
    if (roleChange ? !canChangeRole(player) : !canBan(player)) return;
    const identity = moderation.identity, revision = ++moderation.revision;
    const payload = roleChange ? { role: action === 'make-mod' ? 'mod' : 'player' } : { banned: action === 'ban' };
    const profileAction = statusTarget === el('profileModerationMessage');
    const notify = (text, success = false) => { if (!profileAction || state.profile?.accountId === player.accountId) message(statusTarget, text, success); };
    moderation.busy = true; notify('Saving…'); render();
    try {
      const data = await api(`moderation/players/${encodeURIComponent(player.accountId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      if (moderation.identity !== identity || moderation.revision !== revision || !enabled()) return;
      moderation.players = moderation.players.map(item => item.accountId === data.player.accountId ? data.player : item);
      refreshPlayer(data.player); notify(action === 'ban' ? 'Player banned.' : action === 'unban' ? 'Player unbanned.' : action === 'make-mod' ? 'Moderator added.' : 'Moderator removed.', true);
    } catch (error) { if (moderation.identity === identity && moderation.revision === revision) notify(error.message); }
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
    el('moderationPlayerDetails').open = false;
    closePlayerPicker(); if (!enabled()) moderation.players = [];
    try { localStorage.setItem(storageKey(moderation.identity), moderation.open ? 'open' : 'closed'); } catch {}
    render(); refreshEditors(); syncVersionView();
    if (enabled()) void findPlayers();
  });
  el('moderationPlayerDetails').addEventListener('toggle', () => {
    if (!el('moderationPlayerDetails').open) playerPicker?.reset();
  });
  el('moderationSearch').addEventListener('submit', event => void findPlayers(event));
  el('adminVersionForm').addEventListener('submit', event => void saveVersion(event));
  el('adminVersion').addEventListener('input', () => { versionSettings.dirty = true; message(el('adminVersionMessage'), ''); });
  el('moderationUsername').addEventListener('input', clearPlayerSelection);
  playerPicker = window.PepperPlayerPicker?.attach({
    input: el('moderationUsername'),
    isEnabled: () => enabled() && !moderation.busy && !state.accountSubmitting,
    renderAvatar: player => profileAvatar(player),
    search: async prefix => {
      if (!enabled() || moderation.busy || state.accountSubmitting) return [];
      const identity = moderation.identity, role = moderation.role, revision = moderation.searchRevision;
      const data = await api(`moderation/players?username=${encodeURIComponent(prefix)}`);
      return enabled() && moderation.identity === identity && moderation.role === role && moderation.searchRevision === revision ? data.players : [];
    },
    onSelect: selectPlayer
  });
  el('moderationPlayers').addEventListener('click', event => {
    const button = event.target.closest('[data-moderation-action]'); if (!button || button.disabled) return;
    const player = moderation.players.find(item => item.accountId === button.dataset.accountId);
    if (player) void changePlayer(player, button.dataset.moderationAction);
  });
  el('profileModerationActions').addEventListener('click', event => {
    const button = event.target.closest('[data-moderation-action]');
    if (!button || button.disabled || button.dataset.accountId !== state.profile?.accountId) return;
    void changePlayer(state.profile, button.dataset.moderationAction, el('profileModerationMessage'));
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
    if (moderation.identity && event.key === storageKey(moderation.identity)) {
      moderation.open = event.newValue === 'open'; el('moderationPlayerDetails').open = false;
      closePlayerPicker(); if (!enabled()) moderation.players = [];
      render(); refreshEditors(); syncVersionView();
      if (enabled()) void findPlayers();
    }
  });
  window.PepperModeration = { enabled, syncUser, syncVersion, showBanned, chatDeleteButton, renderProfileControls, closePlayerPicker };
  syncUser();
})();
