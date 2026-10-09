(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const dialog = el('announcementPopup');
  if (!dialog) return;
  const guestKey = 'pepper.announcements.guest.seen';
  const popup = {
    identity: null, identityRevision: -1, revision: 0, feedRevision: 0, navigation: -1, entries: [], currentId: null,
    loaded: false, loadRequest: null, loadRetryAt: 0, seenRequest: null, seenRetryAt: 0,
    acknowledged: new Set(), pending: new Set(), guestSeen: new Set(), ignoredCloses: 0,
    focusId: null, viewing: false
  };
  const accountIdentity = () => state.user?.accountId || 'guest';
  const pendingKey = identity => `pepper.announcements.pending.${identity}`;
  const available = () => !document.hidden && !document.body.classList.contains('auth-loading') && !accountBanned && !state.user?.banned;
  const current = operation => popup.identity === operation.identity && popup.revision === operation.revision && accountIdentity() === operation.identity && userIdentityRevision === operation.identityRevision;
  const validEntries = entries => (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.description === 'string');
  const newestFirst = (a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0) || b.id.localeCompare(a.id);
  function readIds(key) {
    try { const ids = JSON.parse(localStorage.getItem(key) || '[]'); return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string').slice(-1000) : []); }
    catch { return new Set(); }
  }
  function writeIds(key, ids) {
    try { localStorage.setItem(key, JSON.stringify([...ids].slice(-1000))); } catch { /* Memory state still prevents repeated popups during this visit. */ }
  }
  function closeDialog() {
    if (!dialog.open) return;
    popup.ignoredCloses++; dialog.close();
  }
  function focusEntry() {
    if (!popup.focusId || pageKind !== 'announcements') return;
    const article = Array.from(el('announcementEntries')?.querySelectorAll('[data-entry-id]') || []).find(entry => entry.dataset.entryId === popup.focusId);
    if (!article) return;
    article.tabIndex = -1; article.focus({ preventScroll: true }); article.scrollIntoView({ block: 'center', behavior: 'smooth' }); popup.focusId = null;
  }
  function renderAuthor(author) {
    const container = el('announcementPopupAuthor'); container.replaceChildren();
    if (!author?.username) { container.textContent = 'Unknown author'; return; }
    const link = document.createElement(author.accountId ? 'a' : 'span'); link.className = 'player-identity';
    if (author.accountId) link.href = profileHref(author.username);
    const name = document.createElement('span'); name.textContent = author.username;
    link.append(profileAvatar(author, 'player-avatar'), name, playerRoleBadges(author)); container.append(link);
  }
  function pump() {
    if (!available() || Array.from(document.querySelectorAll('dialog[open]')).some(other => other !== dialog) || popup.viewing && pageKind === 'announcements') { closeDialog(); return; }
    const entry = popup.entries.find(item => item.id === popup.currentId) || popup.entries[0];
    if (!entry) { popup.currentId = null; closeDialog(); return; }
    popup.currentId = entry.id;
    el('announcementPopupTitle').textContent = entry.title;
    el('announcementPopupDescription').textContent = entry.description;
    const date = el('announcementPopupDate'); date.dateTime = entry.createdAt;
    date.textContent = new Date(entry.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    renderAuthor(entry.author); el('announcementPopupMessage').textContent = '';
    if (!dialog.open) { try { dialog.showModal(); el('announcementPopupDismiss').focus(); } catch { /* Retry once the current dialog finishes closing. */ } }
  }
  function filterEntries(entries) {
    const seen = popup.identity === 'guest' ? popup.guestSeen : popup.acknowledged;
    return [...new Map(validEntries(entries).filter(entry => !seen.has(entry.id) && !popup.pending.has(entry.id)).map(entry => [entry.id, entry])).values()].sort(newestFirst);
  }
  async function request(operation, path, options = {}) {
    operation.controller = new AbortController();
    const timeout = window.setTimeout(() => operation.controller.abort(), 15000);
    try { return await api(path, { ...options, signal: operation.controller.signal }); }
    finally { window.clearTimeout(timeout); }
  }
  async function load() {
    if (!available() || popup.loadRequest || Date.now() < popup.loadRetryAt) return;
    const operation = { identity: popup.identity, revision: popup.revision, identityRevision: popup.identityRevision, navigation: routeRevision, feedRevision: popup.feedRevision };
    popup.loadRequest = operation;
    try {
      const data = await request(operation, operation.identity === 'guest' ? 'announcements' : 'announcements/unseen');
      if (!current(operation) || operation.navigation !== routeRevision || operation.feedRevision !== popup.feedRevision) return;
      popup.entries = filterEntries(data.entries); popup.loaded = true; popup.loadRetryAt = 0; pump();
    } catch (error) {
      if (!current(operation) || operation.navigation !== routeRevision || operation.feedRevision !== popup.feedRevision) return;
      if (error.status === 401) { setUser(null); return; }
      popup.loadRetryAt = Date.now() + 5000;
    } finally { if (popup.loadRequest === operation) popup.loadRequest = null; }
  }
  async function sendSeen() {
    if (!available() || popup.identity === 'guest' || !popup.pending.size || popup.seenRequest || Date.now() < popup.seenRetryAt) return;
    const operation = { identity: popup.identity, revision: popup.revision, identityRevision: popup.identityRevision, id: popup.pending.values().next().value };
    popup.seenRequest = operation;
    try {
      await request(operation, `announcements/${encodeURIComponent(operation.id)}/seen`, { method: 'POST', body: '{}' });
      if (!current(operation)) return;
      popup.pending.delete(operation.id); popup.acknowledged.add(operation.id); popup.seenRetryAt = 0;
      writeIds(pendingKey(popup.identity), popup.pending);
    } catch (error) {
      if (!current(operation)) return;
      if (error.status === 401) { setUser(null); return; }
      if (error.status === 404 || error.status === 410) { popup.pending.delete(operation.id); writeIds(pendingKey(popup.identity), popup.pending); }
      else { const delay = Number(error.retryAfterMs); popup.seenRetryAt = Date.now() + (error.status === 429 && Number.isFinite(delay) && delay > 0 ? delay : 5000); }
    } finally {
      if (popup.seenRequest === operation) popup.seenRequest = null;
      if (current(operation) && popup.pending.size && !popup.seenRetryAt) void sendSeen();
    }
  }
  function acknowledge(view = false) {
    const entry = popup.entries.find(item => item.id === popup.currentId);
    if (!entry || !available() || popup.identity !== accountIdentity()) return;
    if (popup.identity === 'guest') { popup.guestSeen.add(entry.id); writeIds(guestKey, popup.guestSeen); }
    else { popup.acknowledged.add(entry.id); popup.pending.add(entry.id); writeIds(pendingKey(popup.identity), popup.pending); }
    popup.entries = popup.entries.filter(item => item.id !== entry.id); popup.currentId = null; closeDialog();
    if (view) { popup.focusId = entry.id; popup.viewing = true; navigateTo('/announcements'); focusEntry(); }
    void sendSeen(); pump();
  }
  function syncUser() {
    const identity = accountIdentity();
    if (identity !== popup.identity || userIdentityRevision !== popup.identityRevision) {
      popup.loadRequest?.controller?.abort(); popup.seenRequest?.controller?.abort(); closeDialog();
      Object.assign(popup, { identity, identityRevision: userIdentityRevision, revision: popup.revision + 1, navigation: routeRevision,
        entries: [], currentId: null, loaded: false, loadRequest: null, loadRetryAt: 0, seenRequest: null, seenRetryAt: 0,
        acknowledged: new Set(), pending: identity === 'guest' ? new Set() : readIds(pendingKey(identity)),
        guestSeen: identity === 'guest' ? readIds(guestKey) : new Set(), focusId: null, viewing: false });
    }
    if (!available()) { closeDialog(); return; }
    if (!popup.loaded) void load(); void sendSeen(); pump();
  }
  function onRoute() {
    if (popup.navigation !== routeRevision) { popup.navigation = routeRevision; popup.loadRequest?.controller?.abort(); popup.loadRequest = null; }
    if (pageKind !== 'announcements') { popup.viewing = false; popup.focusId = null; }
    syncUser(); focusEntry(); if (available()) void load();
  }
  function syncEntries(entries) {
    if (popup.identity !== accountIdentity() || popup.identityRevision !== userIdentityRevision) syncUser();
    // A read preceding this fresher snapshot cannot restore a deleted entry.
    popup.feedRevision++; popup.loadRequest?.controller?.abort(); popup.loadRequest = null;
    if (popup.identity === 'guest') popup.entries = filterEntries(entries);
    else {
      const byId = new Map(validEntries(entries).map(entry => [entry.id, entry]));
      popup.entries = filterEntries(popup.entries.filter(entry => byId.has(entry.id)).map(entry => byId.get(entry.id)));
    }
    focusEntry(); pump(); if (available()) void load();
  }
  el('announcementPopupDismiss').addEventListener('click', () => acknowledge());
  el('announcementPopupClose').addEventListener('click', () => acknowledge());
  el('announcementPopupRead').addEventListener('click', () => acknowledge(true));
  dialog.addEventListener('cancel', event => { event.preventDefault(); acknowledge(); });
  dialog.addEventListener('close', () => { if (popup.ignoredCloses) popup.ignoredCloses--; else acknowledge(); });
  document.addEventListener('close', pump, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncUser(); void load(); } else closeDialog(); });
  window.addEventListener('online', () => { popup.loadRetryAt = 0; popup.seenRetryAt = 0; syncUser(); void load(); });
  if (typeof MutationObserver !== 'undefined') new MutationObserver(() => { syncUser(); pump(); }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open', 'class'] });
  window.PepperAnnouncementPopup = { syncUser, onRoute, syncEntries };
  syncUser();
  window.setInterval(() => { syncUser(); void sendSeen(); }, 1000);
  window.setInterval(() => { if (available()) void load(); }, 30000);
})();
