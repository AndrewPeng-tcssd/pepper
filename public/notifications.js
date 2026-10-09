(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const notifications = {
    identity: null, revision: 0, feedRevision: 0, entries: [], unreadCount: 0,
    loaded: false, signature: null, loadRequest: null, readRequest: null,
    pendingReads: new Set(), dueTriggered: null
  };
  let dueTimer;
  const signedIn = () => !!state.user && notifications.identity === state.user.accountId && !accountBanned && !state.user.banned;
  const current = (identity, revision, identityRevision) => signedIn() && notifications.identity === identity && notifications.revision === revision && userIdentityRevision === identityRevision;

  function status(text = '') {
    message(el('notificationMessage'), text);
    el('notificationMessage').hidden = !text;
  }
  function acceptFeed(data) {
    notifications.entries = Array.isArray(data.notifications) ? data.notifications.slice(0, 100) : [];
    notifications.unreadCount = Math.max(0, Number(data.unreadCount) || 0);
    notifications.loaded = true;
    status(); render();
  }
  function render() {
    const visible = signedIn();
    const menu = el('notificationMenu'), count = visible ? notifications.unreadCount : 0;
    menu.hidden = !visible;
    if (!visible) menu.open = false;
    el('notificationBadge').hidden = !count;
    el('notificationBadge').textContent = count ? String(count) : '';
    el('notificationBadge').setAttribute('aria-hidden', 'true');
    el('notificationBell').setAttribute('aria-label', count ? `Notifications, ${count} unread` : 'Notifications');
    el('notificationEmpty').hidden = visible && notifications.entries.length > 0;
    el('notificationEmpty').textContent = visible && !notifications.loaded ? 'Loading notifications…' : 'No notifications.';
    const entries = visible ? notifications.entries : [];
    const signature = JSON.stringify(entries);
    if (signature === notifications.signature) return;
    notifications.signature = signature;
    const focusedId = document.activeElement?.closest?.('[data-notification-id]')?.dataset.notificationId;
    const controls = entries.map(entry => {
      const control = document.createElement('button');
      control.type = 'button'; control.className = `notification-item${entry.read ? '' : ' notification-unread'}`;
      control.dataset.notificationId = entry.id;
      const identity = document.createElement('span'); identity.className = 'notification-identity';
      const name = document.createElement('span');
      name.textContent = entry.type === 'claim' ? 'Tokens ready' : entry.player?.username || 'New message';
      if (entry.type === 'message' && entry.player) identity.append(profileAvatar(entry.player), name, playerRoleBadges(entry.player));
      else identity.append(name);
      const text = document.createElement('span'); text.className = 'notification-text';
      text.textContent = entry.type === 'claim' ? 'Claim tokens' : entry.text;
      const date = document.createElement('time'); date.className = 'notification-time'; date.dateTime = entry.createdAt;
      date.textContent = new Date(entry.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      control.append(identity, text, date); return control;
    });
    el('notificationList').replaceChildren(...controls);
    if (focusedId) controls.find(control => control.dataset.notificationId === focusedId)?.focus({ preventScroll: true });
  }
  function scheduleClaim() {
    window.clearTimeout(dueTimer); dueTimer = undefined;
    if (!signedIn()) return;
    const due = Number(state.user.nextClaimAt);
    if (!Number.isFinite(due) || due <= 0 || notifications.dueTriggered === due) return;
    dueTimer = window.setTimeout(() => {
      dueTimer = undefined;
      if (!signedIn() || Number(state.user.nextClaimAt) !== due || document.hidden) return;
      if (Date.now() < due) { scheduleClaim(); return; }
      notifications.dueTriggered = due;
      void load();
    }, Math.min(2147483647, Math.max(0, due - Date.now())));
  }
  function syncUser() {
    const identity = state.user?.accountId || null;
    if (identity !== notifications.identity || !signedIn()) {
      window.clearTimeout(dueTimer); dueTimer = undefined;
      Object.assign(notifications, {
        identity, revision: notifications.revision + 1, feedRevision: notifications.feedRevision + 1,
        entries: [], unreadCount: 0, loaded: false, signature: null, loadRequest: null,
        readRequest: null, pendingReads: new Set(), dueTriggered: null
      });
      el('notificationMenu').open = false; status();
    }
    render(); scheduleClaim();
    if (signedIn() && !document.hidden) void load();
  }
  async function load() {
    if (!signedIn() || document.hidden || notifications.loadRequest || notifications.readRequest) return;
    const identity = notifications.identity, revision = notifications.revision, identityRevision = userIdentityRevision;
    const feedRevision = notifications.feedRevision, request = {};
    notifications.loadRequest = request;
    const live = () => current(identity, revision, identityRevision) && notifications.loadRequest === request && notifications.feedRevision === feedRevision;
    try {
      const data = await api('notifications');
      if (live()) acceptFeed(data);
    } catch (error) {
      if (!live()) return;
      if (error.status === 401) { setUser(null); return; }
      status('Notifications unavailable.');
      notifications.loaded = true; render();
    } finally {
      if (notifications.loadRequest === request) notifications.loadRequest = null;
    }
  }
  function acknowledge(ids) {
    if (!signedIn()) return;
    const unread = new Set(notifications.entries.filter(entry => !entry.read).map(entry => entry.id));
    for (const id of ids) if (unread.has(id)) notifications.pendingReads.add(id);
    void sendReads();
  }
  async function sendReads() {
    if (!signedIn() || notifications.readRequest) return;
    const unread = new Set(notifications.entries.filter(entry => !entry.read).map(entry => entry.id));
    const ids = [...notifications.pendingReads].filter(id => unread.has(id)).slice(0, 100);
    notifications.pendingReads = new Set([...notifications.pendingReads].filter(id => unread.has(id) && !ids.includes(id)));
    if (!ids.length) return;
    const identity = notifications.identity, revision = notifications.revision, identityRevision = userIdentityRevision, request = {};
    notifications.feedRevision++; notifications.loadRequest = null;
    notifications.readRequest = request;
    const live = () => current(identity, revision, identityRevision) && notifications.readRequest === request;
    try {
      const data = await api('notifications/read', { method: 'POST', body: JSON.stringify({ ids }) });
      if (live()) acceptFeed(data);
    } catch (error) {
      if (!live()) return;
      if (error.status === 401) { setUser(null); return; }
      status('Couldn’t check notifications.');
    } finally {
      if (notifications.readRequest === request) {
        notifications.readRequest = null;
        if (notifications.pendingReads.size) void sendReads();
        else void load();
      }
    }
  }
  function onRoute() {
    scheduleClaim();
    if (signedIn() && !document.hidden) void load();
  }
  el('notificationMenu').addEventListener('toggle', () => {
    if (!el('notificationMenu').open || !signedIn()) return;
    if (el('accountMenu')) el('accountMenu').open = false;
    acknowledge(notifications.entries.filter(entry => !entry.read).map(entry => entry.id));
    void load();
  });
  el('notificationList').addEventListener('click', event => {
    const control = event.target.closest('[data-notification-id]');
    const entry = control && notifications.entries.find(item => item.id === control.dataset.notificationId);
    if (!entry || !signedIn()) return;
    acknowledge([entry.id]); el('notificationMenu').open = false;
    if (entry.type === 'claim') navigateTo('/#tokens');
    else if (entry.type === 'message' && entry.friendId) navigateTo(`/friends?conversation=${encodeURIComponent(entry.friendId)}`);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { scheduleClaim(); void load(); }
  });
  window.addEventListener('online', () => { scheduleClaim(); void load(); });
  setInterval(() => { if (!document.hidden && signedIn()) void load(); }, 3000);
  window.PepperNotifications = { syncUser, onRoute, load };
  syncUser();
})();
