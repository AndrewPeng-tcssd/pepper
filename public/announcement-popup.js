(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const dialog = el('announcementPopup');
  if (!dialog) return;
  const deviceKey = 'pepper.announcements.device.seen';
  const guestKey = 'pepper.announcements.guest.seen';
  const pendingPrefix = 'pepper.announcements.pending.';
  const popup = {
    identity: null, identityRevision: -1, revision: 0, feedRevision: 0, navigation: -1, entries: [], currentId: null,
    loaded: false, loadRequest: null, loadRetryAt: 0, seen: new Set(), ignoredCloses: 0,
    focusId: null, viewing: false
  };
  const accountIdentity = () => state.user?.accountId || 'guest';
  const available = () => !document.hidden && !document.body.classList.contains('auth-loading') && !accountBanned && !state.user?.banned;
  const current = operation => popup.identity === operation.identity && popup.revision === operation.revision && accountIdentity() === operation.identity && userIdentityRevision === operation.identityRevision;
  const validEntries = entries => (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.description === 'string');
  const newestFirst = (a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0) || b.id.localeCompare(a.id);
  function parseIds(value) {
    try { const ids = JSON.parse(value || '[]'); return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []); }
    catch { return new Set(); }
  }
  function readIds(key) {
    try { return parseIds(localStorage.getItem(key)); } catch { return new Set(); }
  }
  function writeIds(key, ids) {
    try {
      const value = JSON.stringify([...ids].sort());
      if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
    } catch { /* Memory state still prevents repeated popups during this visit. */ }
  }
  function mergeSeen(ids) {
    for (const id of ids) popup.seen.add(id);
  }
  function migrateSeen() {
    mergeSeen(readIds(deviceKey));
    mergeSeen(readIds(guestKey));
    mergeSeen(readIds(`${pendingPrefix}${accountIdentity()}`));
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(pendingPrefix)) mergeSeen(readIds(key));
      }
    } catch { /* The current visit can still retain any readable dismissals. */ }
    if (popup.seen.size) writeIds(deviceKey, popup.seen);
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
  function renderAuthor(entry) {
    const container = el('announcementPopupAuthor'); container.replaceChildren();
    const seen = new Set();
    const authors = [entry.author, ...(Array.isArray(entry.contributors) ? entry.contributors : [])].filter(author => {
      if (!author?.username) return false;
      const key = author.accountId || `name:${author.username}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    if (!authors.length) { container.textContent = 'Unknown author'; return; }
    for (const author of authors) {
      const link = document.createElement(author.accountId ? 'a' : 'span'); link.className = 'player-identity';
      if (author.accountId) link.href = profileHref(author.username);
      const name = document.createElement('span'); name.textContent = author.username;
      link.append(profileAvatar(author, 'player-avatar'), name, playerRoleBadges(author)); container.append(link);
    }
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
    renderAuthor(entry); el('announcementPopupMessage').textContent = '';
    if (!dialog.open) { try { dialog.showModal(); el('announcementPopupDismiss').focus(); } catch { /* Retry once the current dialog finishes closing. */ } }
  }
  function filterEntries(entries) {
    mergeSeen(readIds(deviceKey));
    return [...new Map(validEntries(entries).filter(entry => !popup.seen.has(entry.id)).map(entry => [entry.id, entry])).values()].sort(newestFirst);
  }
  function removeSeenEntries() {
    popup.entries = filterEntries(popup.entries);
    if (popup.seen.has(popup.currentId)) { popup.currentId = null; closeDialog(); }
  }
  function acknowledgeEntry(id) {
    if (typeof id !== 'string' || !id) return;
    mergeSeen(readIds(deviceKey)); popup.seen.add(id); writeIds(deviceKey, popup.seen);
    removeSeenEntries(); pump();
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
      const data = await request(operation, 'announcements');
      if (!current(operation) || operation.navigation !== routeRevision || operation.feedRevision !== popup.feedRevision) return;
      popup.entries = filterEntries(data.entries); popup.loaded = true; popup.loadRetryAt = 0; pump();
    } catch (error) {
      if (!current(operation) || operation.navigation !== routeRevision || operation.feedRevision !== popup.feedRevision) return;
      if (error.status === 401) { setUser(null); return; }
      popup.loadRetryAt = Date.now() + 5000;
    } finally { if (popup.loadRequest === operation) popup.loadRequest = null; }
  }
  function acknowledge(view = false) {
    const entry = popup.entries.find(item => item.id === popup.currentId);
    if (!entry || !available() || popup.identity !== accountIdentity()) return;
    mergeSeen(readIds(deviceKey)); popup.seen.add(entry.id); writeIds(deviceKey, popup.seen);
    popup.entries = popup.entries.filter(item => item.id !== entry.id); popup.currentId = null; closeDialog();
    if (view) { popup.focusId = entry.id; popup.viewing = true; navigateTo('/announcements'); focusEntry(); }
    removeSeenEntries(); pump();
  }
  function syncUser() {
    const identity = accountIdentity();
    if (identity !== popup.identity || userIdentityRevision !== popup.identityRevision) {
      popup.loadRequest?.controller?.abort(); closeDialog();
      Object.assign(popup, { identity, identityRevision: userIdentityRevision, revision: popup.revision + 1, navigation: routeRevision,
        entries: [], currentId: null, loaded: false, loadRequest: null, loadRetryAt: 0, focusId: null, viewing: false });
    }
    if (!available()) { closeDialog(); return; }
    removeSeenEntries(); if (!popup.loaded) void load(); pump();
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
    popup.entries = filterEntries(entries);
    focusEntry(); pump(); if (available()) void load();
  }
  el('announcementPopupDismiss').addEventListener('click', () => acknowledge());
  el('announcementPopupClose').addEventListener('click', () => acknowledge());
  el('announcementPopupRead').addEventListener('click', () => acknowledge(true));
  dialog.addEventListener('cancel', event => { event.preventDefault(); acknowledge(); });
  dialog.addEventListener('close', () => { if (popup.ignoredCloses) popup.ignoredCloses--; else acknowledge(); });
  document.addEventListener('close', pump, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncUser(); void load(); } else closeDialog(); });
  window.addEventListener('online', () => { popup.loadRetryAt = 0; syncUser(); void load(); });
  window.addEventListener('storage', event => {
    if (event.key !== deviceKey && event.key !== null) return;
    mergeSeen(readIds(deviceKey));
    if (event.key === deviceKey && event.newValue) {
      mergeSeen(parseIds(event.newValue)); writeIds(deviceKey, popup.seen);
    }
    removeSeenEntries(); pump();
  });
  if (typeof MutationObserver !== 'undefined') new MutationObserver(() => { syncUser(); pump(); }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open', 'class'] });
  window.PepperAnnouncementPopup = { syncUser, onRoute, syncEntries, acknowledgeEntry };
  migrateSeen();
  syncUser();
  window.setInterval(syncUser, 1000);
  window.setInterval(() => { if (available()) void load(); }, 30000);
})();
