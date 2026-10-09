const $ = (id) => document.getElementById(id);
let routePath = '';
let profileRoute = null;
let viewingPublicProfile = false;
let pageKind = 'home';
let routeRevision = 0;
let profileLoadRevision = 0;
let authRevision = 0;
let userIdentityRevision = 0;
let accountActionRevision = 0;
let accountBanned = false;
const state = { user: null, profile: null, authMode: 'signup', turnstileToken: null, turnstileWidgetId: null, turnstileLoading: false, turnstileFailed: false, turnstileGeneration: 0, claimSubmitting: false, accountSubmitting: false, changelogSubmitting: false, changelogVisitorPreview: false, changelogEntries: null, changelogSignature: null, announcementSubmitting: false, announcementVisitorPreview: false, announcementEntries: null, announcementSignature: null, chatSignature: null, chatFollowLatest: true, chatMessages: [], chatOutbox: [], chatReply: null, leaderboard: null, leaderboardSignature: null };
const chatInFlight = new Set();
let chatRetryTimer;
let chatRetryAt = 0;
const tradeChatRetryTimers = new Map();
let turnstileScriptPromise;
let chatLoadPromise;
let chatRevision = 0;
let claimRewardAnimation;
let changelogLoadPromise;
let changelogRevision = 0;
let changelogLoadFailed = false;
let announcementLoadPromise;
let announcementRevision = 0;
let announcementLoadFailed = false;
let presenceLoadPromise;
let presenceRefreshQueued = false;
let presenceRevision = 0;
let presenceSuspended = false;
let presencePlayers = null;
let presenceListSignature = null;
const accountPicture = { identity: null, draft: null, reading: false, revision: 0 };
let deletingAccount = false;
let leaderboardLoadPromise;
let leaderboardRefreshQueued = false;
let leaderboardRevision = 0;
let chatHighlightTimer;
const trading = { identity: null, trades: null, signature: null, recipient: null, lookupRevision: 0, lookupLoading: false, review: null, submitting: false, sendUncertain: false, action: null, actionRetry: null, refreshQueued: false, sessionId: null, session: null, sessionRevision: 0, sessionDraft: null, confirmReviewVersion: null, chatMessages: [], chatSignature: null, chatOutbox: [], chatRevision: 0 };
const tradeAutosave = { timer: null, inFlight: null, retryAt: 0, attempts: 0 };
let tradeLoadPromise;
let tradeRevision = 0;
const tradeInventories = { offered: newTradeInventory() };
let tradeSessionLoadPromise;
let tradeSessionRefreshQueued = false;
let tradeChatLoadPromise;
let tradeChatRefreshQueued = false;
const tradeNotification = { id: null, error: null, signature: null };

function newTradeInventory(ownerId = null) {
  return { ownerId, cards: null, selected: [], loading: false, error: null, notice: '', signature: null, loadPromise: null, refreshQueued: false };
}
function accountRole(person) { return person?.role || (person?.canManageChangelog ? 'admin' : 'player'); }
function playerRoleBadges(person) {
  const badges = document.createElement('span'); badges.className = 'role-badges';
  const role = accountRole(person);
  for (const [label, kind] of [...(role === 'admin' ? [['Admin', 'admin']] : role === 'mod' ? [['Mod', 'mod']] : []), ...(person?.banned ? [['Banned', 'banned']] : [])]) {
    const badge = document.createElement('span'); badge.className = `role-badge role-badge-${kind}`; badge.textContent = label; badges.append(badge);
  }
  badges.hidden = !badges.children.length; return badges;
}
function moderationViewEnabled() { return window.PepperModeration?.enabled() === true; }
function canDeleteAnnouncement(entry) { return accountRole(state.user) === 'admin' || (accountRole(state.user) === 'mod' && (entry?.authorAccountId || entry?.author?.accountId) === state.user?.accountId); }

async function api(path, options = {}) {
  const requestIdentityRevision = userIdentityRevision;
  const response = await fetch(`/api/${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong.');
    error.status = response.status;
    error.user = data.user;
    error.banned = response.status === 403 && data.banned === true;
    if (error.banned && requestIdentityRevision === userIdentityRevision) handleBannedAccount();
    if (response.status === 429) {
      const milliseconds = Number(data.retryAfterMs);
      const header = response.headers.get('Retry-After');
      const seconds = header ? Number(header) : NaN;
      const headerDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
      error.retryAfterMs = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : headerDelay;
    }
    throw error;
  }
  return data;
}

function handleBannedAccount() {
  accountBanned = true;
  setUser(null);
  window.PepperModeration?.showBanned();
}

function message(element, text, success = false) {
  element.textContent = text;
  element.classList.toggle('success', success);
}

function formatProfileDate(value, includeTime = false) {
  if (!value) return 'No claims yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleString([], includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

function isOwnProfile(username) {
  return !!state.user && state.user.username.toLowerCase() === username.toLowerCase();
}

function profileHref(username) {
  return isOwnProfile(username) ? '/profile' : `/profile/${encodeURIComponent(username)}`;
}

function profilePictureUrl(person) {
  try {
    const url = new URL(person?.avatarUrl || '/favicon.svg', location.origin);
    if (url.origin === location.origin && (url.pathname === '/favicon.svg' || /^\/api\/avatars\/[a-z0-9-]+$/i.test(url.pathname))) return `${url.pathname}${url.search}`;
  } catch {}
  return '/favicon.svg';
}

function setProfileAvatar(image, person) {
  const source = profilePictureUrl(person);
  if (image.getAttribute('src') !== source) image.src = source;
  image.onerror = () => { image.onerror = null; image.src = '/favicon.svg'; };
}

function profileAvatar(person, className = 'player-avatar', showOnline = false) {
  const image = document.createElement('img');
  image.className = className;
  image.alt = '';
  image.width = 32;
  image.height = 32;
  image.decoding = 'async';
  setProfileAvatar(image, person);
  if (!showOnline) return image;
  const avatar = document.createElement('span');
  avatar.className = 'player-avatar-wrap';
  avatar.dataset.accountId = person?.accountId || '';
  avatar.dataset.banned = person?.banned ? 'true' : 'false';
  const indicator = document.createElement('span');
  indicator.className = 'online-indicator';
  indicator.setAttribute('role', 'img');
  indicator.setAttribute('aria-label', 'Online');
  avatar.append(image, indicator);
  updateAvatarPresence(avatar);
  return avatar;
}

function updateAvatarPresence(avatar) {
  const online = avatar.dataset.banned !== 'true' && !!avatar.dataset.accountId && (presencePlayers || []).some(player => player.accountId === avatar.dataset.accountId && !player.banned);
  avatar.querySelector('.online-indicator').hidden = !online;
}

function refreshOnlineAvatars() {
  for (const container of [$('chatMessages'), $('leaderboardRows')]) {
    container.querySelectorAll('.player-avatar-wrap').forEach(updateAvatarPresence);
  }
}

function renderProfileDetails(profile) {
  setProfileAvatar($('profileAvatar'), profile);
  $('profilePictureEdit').disabled = !state.user || !isOwnProfile(profile.username);
  $('profilePictureEdit').title = $('profilePictureEdit').disabled ? '' : 'Change picture';
  $('profileUsername').textContent = profile.username;
  $('profileUsername').append(playerRoleBadges(profile));
  $('profileAccountId').textContent = profile.accountId || 'Not available';
  $('profileJoined').textContent = profile.createdAt ? formatProfileDate(profile.createdAt) : 'Not available';
  $('profileBalance').textContent = profile.balance.toLocaleString();
  $('profileLastClaim').textContent = formatProfileDate(profile.lastClaimAt, true);
  window.PepperModeration?.renderProfileControls();
}

function renderOverviewProfile(user) {
  setProfileAvatar($('overviewProfileAvatar'), user);
  $('overviewProfileDetails').hidden = !user;
  $('overviewProfileGuest').hidden = !!user;
  $('overviewProfileGuest').textContent = 'Log in to view profile.';
  $('overviewProfileName').textContent = user?.username || '';
  $('overviewProfileName').append(playerRoleBadges(user));
  $('overviewProfileBalance').textContent = user ? user.balance.toLocaleString() : '0';
  $('overviewProfileJoined').textContent = user?.createdAt ? formatProfileDate(user.createdAt) : 'Not available';
  $('overviewProfileLastClaim').textContent = user ? formatProfileDate(user.lastClaimAt, true) : 'No claims yet';
}

function setUser(user) {
  if (!user || (state.user && state.user.username !== user.username)) clearClaimReward();
  const previousPresenceIdentity = state.user?.accountId || state.user?.username || null;
  const previousUsername = state.user?.username;
  state.user = user;
  if (user) accountBanned = false;
  syncPictureSettings();
  renderOverviewProfile(user);
  authRevision++;
  renderChangelogEditor();
  renderAnnouncementEditor();
  if (previousPresenceIdentity !== (user?.accountId || user?.username || null)) {
    userIdentityRevision++;
    window.PepperPlayerPicker?.closeAll();
    resetChatSending();
    clearChatReply();
    if (state.chatOutbox.length) {
      state.chatOutbox = [];
      renderChat(state.chatMessages);
    }
    presenceRevision++;
    void loadPresence(true);
  } else if (user && state.chatOutbox.some(item => item.username !== user.username)) {
    state.chatOutbox.forEach(item => { item.username = user.username; });
    renderChat(state.chatMessages);
  }
  $('chatMessages').querySelectorAll('.chat-author').forEach(author => {
    author.href = profileHref(author.dataset.username);
  });
  if (!viewingPublicProfile) {
    $('profileDescription').textContent = user ? '' : 'Sign in required.';
    $('profileDetails').hidden = !user;
    if (user) renderProfileDetails(user);
  }
  $('accountButton').hidden = !!user;
  $('accountMenu').hidden = !user;
  if (!user) $('accountMenu').open = false;
  $('loggedOutClaim').hidden = !!user;
  $('loggedInClaim').hidden = !user;
  $('chatLoggedOut').hidden = !!user;
  $('chatLoggedIn').hidden = !user;
  $('settingsAccountLoading').hidden = true;
  $('settingsLoggedOut').hidden = !!user;
  $('settingsLoggedIn').hidden = !user;
  $('usernameSettings').hidden = !user;
  $('passwordSettings').hidden = !user;
  $('pictureSettings').hidden = !user;
  $('deleteAccountSettings').hidden = !user;
  setProfileAvatar($('menuAvatar'), user);
  if (user) {
    if (previousPresenceIdentity !== (user.accountId || user.username) || $('newUsername').value === previousUsername) $('newUsername').value = user.username;
    $('panelBalance').textContent = user.balance.toLocaleString();
    $('accountBalance').textContent = user.balance.toLocaleString();
    $('accountName').textContent = user.username;
    $('accountId').textContent = user.accountId || 'Not available';
    $('accountEmailLabel').hidden = !user.email;
    $('accountEmail').hidden = !user.email;
    $('accountEmail').textContent = user.email || '';
    $('accountJoined').textContent = user.createdAt ? formatProfileDate(user.createdAt) : 'Not available';
    $('accountLastClaim').textContent = formatProfileDate(user.lastClaimAt, true);
    $('chatUsername').textContent = user.username;
  } else {
    $('usernameForm').reset();
    $('passwordForm').reset();
    $('deleteAccountForm').reset();
    if ($('deleteAccountDialog').open) $('deleteAccountDialog').close();
    message($('usernameMessage'), '');
    message($('passwordMessage'), '');
    ['accountName', 'accountId', 'accountEmail', 'accountJoined', 'accountLastClaim'].forEach(id => { $(id).textContent = ''; });
    if (!viewingPublicProfile) $('profileAccountId').textContent = '';
    $('accountBalance').textContent = '0';
    removeTurnstile();
    $('claimTitle').textContent = 'Sign in to claim';
    message($('claimMessage'), '');
  }
  renderClaim();
  if (state.chatReply && isOwnChatMessage(state.chatReply)) clearChatReply();
  $('chatMessages').querySelectorAll('.chat-reply-button').forEach(button => {
    const item = state.chatMessages.find(item => item.id === button.dataset.replyId);
    button.hidden = !user || !item || item.deleted || isOwnChatMessage(item);
    if (button.hidden && document.activeElement === button) button.closest('.chat-row').querySelector('.chat-author').focus({ preventScroll: true });
  });
  if (state.leaderboard) renderLeaderboard(state.leaderboard);
  document.body.classList.remove('auth-loading');
  syncTradingUser();
  window.PepperGames?.syncUser();
  window.PepperModeration?.syncUser();
  window.PepperFriends?.syncUser();
  window.PepperNewsComments?.syncUser();
  window.PepperAnnouncementPopup?.syncUser();
  if (state.chatFollowLatest) scrollChatToLatest();
  if (viewingPublicProfile && (isOwnProfile(state.profile?.username || '') || isOwnProfile(routeProfileUsername()))) {
    navigateTo('/profile', { replace: true, focus: false, scroll: false });
  }
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function claimRouteVisible() {
  return pageKind === 'home' || (pageKind === 'profile' && !viewingPublicProfile);
}

function renderClaim() {
  const profile = viewingPublicProfile ? state.profile : state.user;
  if (!profile || (pageKind !== 'home' && pageKind !== 'profile')) return;
  const remaining = profile.nextClaimAt ? profile.nextClaimAt - Date.now() : 0;
  const ready = remaining <= 0;
  if (pageKind === 'profile') $('profileNextClaim').textContent = ready ? 'Ready now' : formatTime(remaining);
  if (!claimRouteVisible()) return;
  $('claimReady').hidden = !ready;
  $('claimCooldown').hidden = ready;
  $('claimTitle').textContent = ready ? 'Ready to claim' : 'Next claim';
  if (ready && state.turnstileWidgetId === null && !state.turnstileLoading && !state.turnstileFailed) loadTurnstile();
  if (!ready) { removeTurnstile(); $('cooldownClock').textContent = formatTime(remaining); }
}

function setClaimToken(token) {
  state.turnstileToken = token || null;
  $('claimForm').querySelector('button').disabled = !state.turnstileToken || state.claimSubmitting;
}

function clearClaimReward() {
  claimRewardAnimation?.cancel();
  claimRewardAnimation = null;
  $('claimReward').hidden = true;
  $('claimRewardTrack').replaceChildren();
}

async function revealClaimReward(awarded) {
  const track = $('claimRewardTrack');
  const number = value => {
    const element = document.createElement('span');
    element.className = 'claim-reel-number';
    element.textContent = value;
    return element;
  };
  // Moving a reversed reel toward zero brings each number down into view.
  track.replaceChildren(number(awarded), ...Array.from({ length: 33 }, (_, index) => number(10 + index % 11)));
  $('claimReward').hidden = false;
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && track.animate) {
    const animation = track.animate([
      { transform: 'translateY(calc(-100% + 1.1em))' },
      { transform: 'translateY(0)' }
    ], { duration: 1700, easing: 'cubic-bezier(.12, .65, .16, 1)', fill: 'both' });
    claimRewardAnimation = animation;
    try { await animation.finished; } catch { return false; }
    if (claimRewardAnimation !== animation) return false;
    animation.cancel();
    claimRewardAnimation = null;
  }
  track.replaceChildren(number(awarded));
  return true;
}

function removeTurnstile() {
  if (state.turnstileWidgetId === null && !state.turnstileLoading && !state.turnstileToken && !state.turnstileFailed) return;
  state.turnstileGeneration++;
  if (state.turnstileWidgetId !== null && window.turnstile) window.turnstile.remove(state.turnstileWidgetId);
  state.turnstileWidgetId = null;
  state.turnstileLoading = false;
  state.turnstileFailed = false;
  setClaimToken(null);
}

function resetTurnstile() {
  setClaimToken(null);
  if (state.turnstileWidgetId !== null && window.turnstile && $('turnstileWidget').querySelector('iframe')) {
    window.turnstile.reset(state.turnstileWidgetId);
  } else if (state.turnstileWidgetId !== null) {
    removeTurnstile();
    loadTurnstile();
  }
  else if (state.user && (!state.user.nextClaimAt || state.user.nextClaimAt <= Date.now())) {
    state.turnstileFailed = false;
    loadTurnstile();
  }
}

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => { script.remove(); turnstileScriptPromise = null; reject(new Error('Could not load Cloudflare verification.')); };
      document.head.append(script);
    });
  }
  return turnstileScriptPromise;
}

async function loadTurnstile() {
  if (!state.user || !claimRouteVisible() || state.turnstileLoading || state.turnstileWidgetId !== null) return;
  state.turnstileLoading = true;
  const generation = ++state.turnstileGeneration;
  try {
    const config = await api('turnstile-config');
    if (!config.siteKey) throw new Error('Cloudflare verification is unavailable.');
    await loadTurnstileScript();
    if (generation !== state.turnstileGeneration || !state.user || !claimRouteVisible()) return;
    state.turnstileWidgetId = window.turnstile.render('#turnstileWidget', {
      sitekey: config.siteKey,
      action: 'claim_tokens',
      size: window.matchMedia('(max-width: 450px)').matches ? 'compact' : 'normal',
      callback: token => { if (generation === state.turnstileGeneration) { setClaimToken(token); message($('claimMessage'), ''); } },
      'expired-callback': () => { if (generation === state.turnstileGeneration) setClaimToken(null); },
      'error-callback': () => { if (generation === state.turnstileGeneration) { setClaimToken(null); message($('claimMessage'), 'Verification failed. Reset and retry.'); } }
    });
    message($('claimMessage'), '');
    window.setTimeout(() => {
      if (generation === state.turnstileGeneration && !state.turnstileToken && !$('turnstileWidget').querySelector('iframe')) {
        message($('claimMessage'), 'Verification unavailable. Reset and retry.');
      }
    }, 8000);
  } catch (error) {
    if (generation === state.turnstileGeneration) { state.turnstileFailed = true; message($('claimMessage'), error.message); }
  } finally { if (generation === state.turnstileGeneration) state.turnstileLoading = false; }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === 'signup';
  $('signupTab').classList.toggle('active', signup);
  $('loginTab').classList.toggle('active', !signup);
  $('usernameField').hidden = !signup;
  $('identifierField').hidden = signup;
  $('username').required = signup;
  $('identifier').required = !signup;
  $('password').autocomplete = signup ? 'new-password' : 'current-password';
  $('authTitle').textContent = signup ? 'Create account' : 'Log in';
  $('authSubmit').textContent = signup ? 'Create account' : 'Log in';
  message($('authMessage'), '');
}

function openAccount() {
  setChatOpen(false);
  if (state.user) navigateTo('/settings');
  else { setAuthMode('signup'); $('authDialog').showModal(); }
}

function setChatOpen(open) {
  $('chat').classList.toggle('open', open);
  $('chat').inert = !open && window.matchMedia('(max-width: 850px)').matches;
  $('chatOverlay').hidden = !open;
  $('chatToggle').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('chat-open', open);
  if (open) {
    if (state.chatFollowLatest) scrollChatToLatest();
    $('chatClose').focus();
  }
  else if (document.activeElement === $('chatClose')) $('chatToggle').focus();
}

$('chatToggle').addEventListener('click', () => setChatOpen(!$('chat').classList.contains('open')));
$('chatClose').addEventListener('click', () => setChatOpen(false));
$('chatOverlay').addEventListener('click', () => setChatOpen(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && $('chat').classList.contains('open')) setChatOpen(false); });
window.matchMedia('(min-width: 851px)').addEventListener('change', () => setChatOpen(false));
setChatOpen(false);

['accountButton', 'claimJoin', 'chatJoin', 'settingsJoin', 'tradingJoin'].forEach(id => $(id).addEventListener('click', openAccount));
document.addEventListener('click', (event) => {
  if (!$('accountMenu').contains(event.target)) $('accountMenu').open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('accountMenu').open) {
    $('accountMenu').open = false;
    $('accountMenu').querySelector('summary').focus();
  }
});
$('closeDialog').addEventListener('click', () => $('authDialog').close());
$('signupTab').addEventListener('click', () => setAuthMode('signup'));
$('loginTab').addEventListener('click', () => setAuthMode('login'));
$('resetTurnstile').addEventListener('click', () => { message($('claimMessage'), ''); resetTurnstile(); });
$('profileRetry').addEventListener('click', loadProfile);
$('changelogRetry').addEventListener('click', () => loadChangelog());
$('announcementRetry').addEventListener('click', () => loadAnnouncements());
$('leaderboardRetry').addEventListener('click', () => loadLeaderboard(true));
$('year').textContent = new Date().getFullYear();

function routeProfileUsername() {
  try { return profileRoute ? decodeURIComponent(profileRoute[1]) : ''; }
  catch { return ''; }
}

function isAppPath(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  return ['/', '/profile', '/packs', '/packs/test', '/settings', '/changelog', '/announcements', '/leaderboard', '/trading', '/games', '/friends'].includes(path) || /^\/profile\/[^/]+$/.test(path);
}

function renderRoute() {
  window.PepperPlayerPicker?.closeAll();
  routeRevision++;
  profileLoadRevision++;
  routePath = location.pathname.replace(/\/+$/, '') || '/';
  if (routePath === '/packs/test') {
    history.replaceState(history.state, '', `/${location.search}#cards`);
    routePath = '/';
  }
  profileRoute = routePath.match(/^\/profile\/([^/]+)$/);
  viewingPublicProfile = !!profileRoute;
  pageKind = routePath === '/profile' || viewingPublicProfile ? 'profile' : routePath === '/packs' ? 'pack' : routePath === '/settings' ? 'settings' : routePath === '/changelog' ? 'changelog' : routePath === '/announcements' ? 'announcements' : routePath === '/leaderboard' ? 'leaderboard' : routePath === '/trading' ? 'trading' : routePath === '/games' ? 'games' : routePath === '/friends' ? 'friends' : 'home';
  if (viewingPublicProfile && isOwnProfile(routeProfileUsername())) {
    navigateTo('/profile', { replace: true, focus: false, scroll: false });
    return;
  }
  const navigationPath = { home: '/', profile: '/profile', pack: '/packs', settings: '/settings', changelog: '/changelog', announcements: '/announcements', leaderboard: '/leaderboard', trading: '/trading', games: '/games', friends: '/friends' }[pageKind];
  document.querySelectorAll('.main-nav a[aria-current], .account-dropdown a[aria-current]').forEach(link => link.removeAttribute('aria-current'));
  const navigationSelector = pageKind === 'settings' ? '.account-dropdown' : '.main-nav';
  document.querySelector(`${navigationSelector} a[href="${navigationPath}"]`)?.setAttribute('aria-current', 'page');
  document.body.classList.remove('profile-route', 'public-profile-route', 'pack-route', 'settings-route', 'changelog-route', 'announcements-route', 'leaderboard-route', 'trading-route', 'games-route', 'friends-route');
  if (pageKind !== 'home') document.body.classList.add(`${pageKind}-route`);
  document.body.classList.toggle('public-profile-route', viewingPublicProfile);
  ['home', 'profileIntro', 'tokens', 'packsPage', 'settingsPage', 'changelogPage', 'announcementsPage', 'leaderboardPage', 'tradingPage', 'gamesPage', 'friendsPage'].forEach(id => { $(id).hidden = true; });
  const sectionId = { home: 'home', profile: 'profileIntro', pack: 'packsPage', settings: 'settingsPage', changelog: 'changelogPage', announcements: 'announcementsPage', leaderboard: 'leaderboardPage', trading: 'tradingPage', games: 'gamesPage', friends: 'friendsPage' }[pageKind];
  $(sectionId).hidden = false;
  const claim = $('tokens');
  const claimSlot = pageKind === 'home' ? $('overviewClaimSlot') : $('packsPage').parentNode;
  if (claim.parentNode !== claimSlot) {
    removeTurnstile();
    if (pageKind === 'home') claimSlot.append(claim);
    else $('packsPage').before(claim);
  }
  $('tokens').hidden = !claimRouteVisible();
  if (claimRouteVisible()) $('tokensTitle').textContent = 'Hourly claim';
  document.title = { home: 'Pepper TCG — Development', profile: 'Profile — Pepper TCG', pack: 'Packs — Pepper TCG', settings: 'Settings — Pepper TCG', changelog: 'Changelog — Pepper TCG', announcements: 'Announcements — Pepper TCG', leaderboard: 'Leaderboard — Pepper TCG', trading: 'Trading — Pepper TCG', games: 'Games — Pepper TCG', friends: 'Friends — Pepper TCG' }[pageKind];
  state.profile = null;
  window.PepperModeration?.renderProfileControls();
  $('profileRetry').hidden = true;
  $('profileTrade').hidden = true;
  $('profileTitle').textContent = 'Profile';
  $('profileAccountTitle').textContent = viewingPublicProfile ? 'About' : 'Account';
  if (pageKind === 'profile') {
    if (viewingPublicProfile) {
      removeTurnstile();
      void loadProfile();
    } else {
      $('tokens').hidden = false;
      $('profileDescription').textContent = state.user ? '' : 'Sign in required.';
      $('profileDetails').hidden = !state.user;
      if (state.user) renderProfileDetails(state.user);
      renderClaim();
    }
  } else if (pageKind === 'home') renderClaim();
  else removeTurnstile();
  if (pageKind === 'changelog') void loadChangelog(true);
  if (pageKind === 'announcements') void loadAnnouncements(true);
  if (pageKind === 'leaderboard') void loadLeaderboard(true);
  if (pageKind === 'trading') {
    prefillTradingRecipient(true);
    renderTradingState();
    if (state.user) { void loadTrades(true); void loadTradeSession(true); void loadTradeChat(true); refreshTradeInventories(); }
  }
  window.PepperGames?.onRoute();
  window.PepperFriends?.onRoute();
  window.PepperNewsComments?.onRoute();
  window.PepperAnnouncementPopup?.onRoute();
  syncTradeAutosaveRoute();
}

function focusRouteHeading() {
  if ($('chat').classList.contains('open')) return;
  const headingId = { home: 'overviewTitle', profile: 'profileTitle', pack: 'packsTitle', settings: 'settingsTitle', changelog: 'changelogTitleHeading', announcements: 'announcementsTitle', leaderboard: 'leaderboardTitle', trading: 'tradingTitle', games: 'gamesTitle', friends: 'friendsTitle' }[pageKind];
  $(headingId).tabIndex = -1;
  $(headingId).focus({ preventScroll: true });
}

function navigateTo(href, { replace = false, focus = true, scroll = true } = {}) {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin || !isAppPath(url.pathname)) return false;
  if (url.pathname.replace(/\/+$/, '') === '/packs/test') { url.pathname = '/'; url.hash = '#cards'; }
  const target = `${url.pathname}${url.search}${url.hash}`;
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (target !== current) {
    history.replaceState({ ...history.state, pepperScroll: [window.scrollX, window.scrollY] }, '', current);
    history[replace ? 'replaceState' : 'pushState']({ pepperScroll: [0, 0] }, '', target);
    renderRoute();
  }
  $('accountMenu').open = false;
  if (scroll) {
    if (url.hash === '#cards' && pageKind === 'home') $('cards').scrollIntoView({ behavior: 'instant' });
    else window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }
  if (focus) focusRouteHeading();
  return true;
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || !isAppPath(url.pathname) || (url.hash && url.pathname === location.pathname && url.search === location.search)) return;
  event.preventDefault();
  navigateTo(url.href, { focus: !link.closest('#chat') });
});
window.addEventListener('popstate', () => {
  renderRoute();
  const [left, top] = history.state?.pepperScroll || [0, 0];
  window.scrollTo({ left, top, behavior: 'instant' });
});
history.scrollRestoration = 'manual';

$('authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('authSubmit');
  button.disabled = true;
  message($('authMessage'), '');
  const signup = state.authMode === 'signup';
  const body = signup
    ? { username: $('username').value, password: $('password').value }
    : { identifier: $('identifier').value, password: $('password').value };
  try {
    const data = await api(signup ? 'register' : 'login', { method: 'POST', body: JSON.stringify(body) });
    if (data.pending) {
      $('password').value = '';
      message($('authMessage'), 'Check your sign-in email.', true);
      return;
    }
    setUser(data.user);
    $('authDialog').close();
    $('authForm').reset();
    if (pageKind === 'profile' && !viewingPublicProfile) $('tokens').scrollIntoView({ behavior: 'smooth' });
    else if (viewingPublicProfile) $('profileIntro').scrollIntoView({ behavior: 'smooth' });
    else if (pageKind === 'settings') $('settingsPage').scrollIntoView({ behavior: 'smooth' });
    else if (pageKind === 'changelog') $('changelogPage').scrollIntoView({ behavior: 'smooth' });
    else if (pageKind === 'announcements') $('announcementsPage').scrollIntoView({ behavior: 'smooth' });
    else if (pageKind === 'trading') $('tradingPage').scrollIntoView({ behavior: 'smooth' });
    else if (pageKind === 'games') $('gamesPage').scrollIntoView({ behavior: 'smooth' });
    else if (pageKind === 'friends') $('friendsPage').scrollIntoView({ behavior: 'smooth' });
    else if (pageKind !== 'leaderboard') navigateTo('/profile');
  } catch (error) {
    message($('authMessage'), error.message);
  } finally { button.disabled = false; }
});

$('claimForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.claimSubmitting || state.accountSubmitting || !state.user || !claimRouteVisible()) return;
  if (!state.turnstileToken) { message($('claimMessage'), 'Complete Cloudflare verification first.'); return; }
  const button = $('claimForm').querySelector('button');
  const token = state.turnstileToken;
  const claimingIdentity = state.user.accountId || state.user.username;
  const claimingRevision = userIdentityRevision;
  const claimIsCurrent = () => userIdentityRevision === claimingRevision && (state.user?.accountId || state.user?.username) === claimingIdentity;
  const mergeClaimFields = user => {
    const merged = { ...state.user };
    if ((user.lastClaimAt || 0) < (state.user.lastClaimAt || 0)) return merged;
    ['balance', 'lastClaimAt', 'nextClaimAt', 'hourlyTokenMin', 'hourlyTokenMax'].forEach(key => {
      if (Object.prototype.hasOwnProperty.call(user, key)) merged[key] = user[key];
    });
    return merged;
  };
  state.claimSubmitting = true;
  button.disabled = true;
  clearClaimReward();
  message($('claimMessage'), 'Claiming tokens…');
  try {
    const data = await api('claim', { method: 'POST', body: JSON.stringify({ turnstileToken: token }) });
    if (!claimIsCurrent()) return;
    setUser(mergeClaimFields(data.user));
    leaderboardRevision++;
    void loadLeaderboard(true);
    message($('claimMessage'), 'Rolling your reward…', true);
    if (await revealClaimReward(data.awarded)) {
      message($('claimMessage'), `${data.awarded} tokens added.`, true);
    }
  } catch (error) {
    if (!claimIsCurrent()) return;
    if (error.user) setUser(mergeClaimFields(error.user));
    if (error.status === 401) setUser(null);
    message($('claimMessage'), error.message);
    resetTurnstile();
  } finally { state.claimSubmitting = false; button.disabled = !state.turnstileToken; }
});

async function signOut() {
  if (state.accountSubmitting) return;
  $('accountMenu').open = false;
  setAccountSubmitting(true);
  message($('accountMessage'), '');
  message($('headerAccountMessage'), '');
  $('headerAccountMessage').hidden = true;
  try {
    await api('logout', { method: 'POST', body: '{}' });
    setUser(null);
    if (pageKind === 'settings') $('settingsJoin').focus();
    else if (pageKind === 'trading') $('tradingJoin').focus();
  } catch (error) {
    message($('accountMessage'), error.message);
    if (pageKind !== 'settings') {
      message($('headerAccountMessage'), error.message);
      $('headerAccountMessage').hidden = false;
      $('accountMenu').open = true;
    }
  } finally {
    setAccountSubmitting(false);
  }
}

$('logoutButton').addEventListener('click', signOut);
$('headerLogoutButton').addEventListener('click', signOut);

function setAccountSubmitting(submitting, expectedRevision = null) {
  if (expectedRevision !== null && expectedRevision !== accountActionRevision) return;
  const revision = ++accountActionRevision;
  state.accountSubmitting = submitting;
  if (submitting) window.PepperPlayerPicker?.closeAll();
  ['usernameSubmit', 'passwordSubmit', 'logoutButton', 'headerLogoutButton', 'deleteAccountOpen'].forEach(id => {
    $(id).disabled = submitting;
  });
  renderPictureControls();
  ['deleteAccountSubmit', 'deleteAccountPassword', 'deleteAccountConfirmation', 'deleteAccountCancel', 'deleteAccountClose'].forEach(id => { $(id).disabled = deletingAccount; });
  renderTradingState();
  return revision;
}

function renderChangelogEditor() {
  const canManage = state.user?.canManageChangelog === true;
  const showControls = canManage && moderationViewEnabled();
  $('changelogEditor').hidden = !showControls;
  $('changelogEntries').querySelectorAll('.changelog-entry-actions').forEach(actions => {
    actions.hidden = !showControls;
    if (!showControls) {
      actions.querySelector('.changelog-delete-confirm').hidden = true;
      actions.querySelector('.changelog-delete-button').hidden = false;
    }
  });
  if (!canManage) {
    $('changelogForm').reset();
    message($('changelogFormMessage'), '');
  }
}

function changelogActionButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button';
  button.dataset.changelogAction = action;
  button.textContent = label;
  button.disabled = state.changelogSubmitting;
  return button;
}

function newsEntryAuthor(entry) {
  const author = entry.author;
  const identity = document.createElement(author?.accountId && author?.username ? 'a' : 'span');
  identity.className = 'news-entry-author player-identity';
  if (author?.accountId && author?.username) identity.href = profileHref(author.username);
  const name = document.createElement('span'); name.className = 'news-entry-author-name';
  name.textContent = author?.username || 'Unknown author';
  identity.append(profileAvatar(author), name, playerRoleBadges(author));
  return identity;
}

function renderChangelog(entries, latestVersion) {
  $('siteVersion').textContent = latestVersion || '0.4.0-0';
  window.PepperModeration?.syncVersion(latestVersion || '0.4.0-0');
  window.PepperNewsComments?.reconcile('changelog', entries);
  const signature = JSON.stringify(entries);
  if (signature === state.changelogSignature) {
    renderChangelogEditor();
    $('changelogRetry').hidden = true;
    return;
  }
  state.changelogSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const article = document.createElement('article');
    article.className = 'changelog-entry';
    article.dataset.entryId = entry.id;
    const meta = document.createElement('div');
    meta.className = 'changelog-entry-meta';
    const version = document.createElement('span');
    version.className = 'changelog-entry-version';
    version.textContent = `v${entry.version}`;
    const date = document.createElement('time');
    date.dateTime = entry.createdAt;
    date.textContent = new Date(entry.createdAt).toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    });
    const title = document.createElement('h2');
    title.textContent = entry.title;
    const description = document.createElement('p');
    description.className = 'changelog-entry-description';
    description.textContent = entry.description;
    const actions = document.createElement('div');
    actions.className = 'changelog-entry-actions';
    actions.hidden = true;
    const deleteButton = changelogActionButton('Delete', 'delete');
    deleteButton.classList.add('changelog-delete-button');
    deleteButton.setAttribute('aria-label', `Delete ${entry.title}`);
    const confirmation = document.createElement('span');
    confirmation.className = 'changelog-delete-confirm';
    confirmation.hidden = true;
    const prompt = document.createElement('span');
    prompt.textContent = 'Delete this entry?';
    confirmation.append(prompt, changelogActionButton('Confirm delete', 'confirm'), changelogActionButton('Cancel', 'cancel'));
    actions.append(deleteButton, confirmation);
    const dates = document.createElement('div'); dates.className = 'news-entry-date'; dates.append(version, date);
    meta.append(dates, newsEntryAuthor(entry));
    article.append(meta, title, description, actions);
    window.PepperNewsComments?.mount(article, 'changelog', entry);
    fragment.append(article);
  }
  $('changelogEntries').replaceChildren(fragment);
  renderChangelogEditor();
  changelogLoadFailed = false;
  message($('changelogMessage'), entries.length ? '' : 'No changelog entries yet.');
  $('changelogRetry').hidden = true;
}

async function loadChangelog(refresh = false) {
  if (changelogLoadPromise) {
    await changelogLoadPromise;
    if (refresh) return loadChangelog();
    return;
  }
  const revision = changelogRevision;
  changelogLoadPromise = (async () => {
    try {
      const data = await api('changelog');
      // Ignore an older read that finishes after a newly published entry.
      if (revision !== changelogRevision) return;
      state.changelogEntries = data.entries;
      if (changelogLoadFailed) {
        message($('changelogMessage'), data.entries.length ? '' : 'No changelog entries yet.');
        changelogLoadFailed = false;
      }
      renderChangelog(data.entries, data.latestVersion);
    } catch (error) {
      if (revision !== changelogRevision) return;
      if (pageKind === 'changelog') {
        changelogLoadFailed = true;
        message($('changelogMessage'), 'Changelog unavailable. Try again.');
        $('changelogRetry').hidden = false;
      }
    }
  })();
  try { await changelogLoadPromise; }
  finally { changelogLoadPromise = null; }
}

function setChangelogSubmitting(submitting) {
  state.changelogSubmitting = submitting;
  setAccountSubmitting(submitting);
  $('changelogSubmit').disabled = submitting;
  $('changelogEntries').querySelectorAll('.changelog-entry-actions button').forEach(button => { button.disabled = submitting; });
}

function changelogPermissionError(error) {
  if (error.status !== 401 && error.status !== 403) return false;
  if (error.banned || accountBanned) return true;
  if (error.status === 401) setUser(null);
  else { if (state.user) state.user.canManageChangelog = false; renderChangelogEditor(); }
  changelogLoadFailed = false;
  message($('changelogMessage'), error.message);
  if (error.status === 401) $('accountButton').focus();
  else focusChangelogMessage();
  return true;
}

function focusChangelogMessage() {
  $('changelogMessage').tabIndex = -1;
  $('changelogMessage').focus();
}

$('changelogEntries').addEventListener('click', event => {
  const button = event.target.closest('button[data-changelog-action]');
  if (!button || !state.user?.canManageChangelog || !moderationViewEnabled() || state.changelogSubmitting || state.accountSubmitting) return;
  const article = button.closest('.changelog-entry');
  const confirmation = article.querySelector('.changelog-delete-confirm');
  const deleteButton = article.querySelector('.changelog-delete-button');
  if (button.dataset.changelogAction === 'delete') {
    deleteButton.hidden = true;
    confirmation.hidden = false;
    confirmation.querySelector('button').focus();
  } else if (button.dataset.changelogAction === 'cancel') {
    confirmation.hidden = true;
    deleteButton.hidden = false;
    deleteButton.focus();
  } else if (button.dataset.changelogAction === 'confirm') {
    void deleteChangelogEntry(article.dataset.entryId);
  }
});

async function deleteChangelogEntry(entryId) {
  if (!state.user?.canManageChangelog || !moderationViewEnabled() || state.changelogSubmitting || state.accountSubmitting) return;
  setChangelogSubmitting(true);
  let deleted = false;
  try {
    const data = await api(`changelog/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
    changelogRevision++;
    state.changelogEntries = data.entries;
    renderChangelog(data.entries, data.latestVersion);
    message($('changelogMessage'), 'Entry deleted.', true);
    deleted = true;
    void loadChangelog(true);
  } catch (error) {
    if (!changelogPermissionError(error)) {
      if (error.status === 404) await loadChangelog(true);
      changelogLoadFailed = false;
      message($('changelogMessage'), error.message);
      if (error.status === 404) focusChangelogMessage();
    }
  } finally {
    setChangelogSubmitting(false);
    if (deleted) {
      const nextDelete = $('changelogEntries').querySelector('.changelog-delete-button');
      (nextDelete || $('changelogSubmit')).focus();
    }
  }
}

$('changelogForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.changelogSubmitting || state.accountSubmitting || !moderationViewEnabled() || !state.user?.canManageChangelog) return;
  setChangelogSubmitting(true);
  message($('changelogFormMessage'), 'Adding entry…');
  try {
    const data = await api('changelog', { method: 'POST', body: JSON.stringify({
      title: $('changelogTitle').value,
      description: $('changelogDescription').value,
      version: $('changelogVersion').value
    }) });
    changelogRevision++;
    state.changelogEntries = [data.entry, ...(state.changelogEntries || []).filter(entry => entry.id !== data.entry.id)];
    renderChangelog(state.changelogEntries, data.latestVersion);
    $('changelogForm').reset();
    message($('changelogFormMessage'), 'Entry added; build version updated.', true);
    void loadChangelog(true);
  } catch (error) {
    if (!changelogPermissionError(error)) message($('changelogFormMessage'), error.message);
  } finally {
    setChangelogSubmitting(false);
  }
});

function renderAnnouncementEditor() {
  const canManage = state.user?.canManageAnnouncements === true;
  const showControls = canManage && moderationViewEnabled();
  $('announcementEditor').hidden = !showControls;
  $('announcementEntries').querySelectorAll('.changelog-entry-actions').forEach(actions => {
    const entry = state.announcementEntries?.find(item => item.id === actions.closest('.changelog-entry').dataset.entryId);
    actions.hidden = !showControls || !canDeleteAnnouncement(entry);
    if (actions.hidden) {
      actions.querySelector('.changelog-delete-confirm').hidden = true;
      actions.querySelector('.changelog-delete-button').hidden = false;
    }
  });
  if (!canManage) {
    $('announcementForm').reset();
    message($('announcementFormMessage'), '');
  }
}

function announcementActionButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button';
  button.dataset.announcementAction = action;
  button.textContent = label;
  button.disabled = state.announcementSubmitting;
  return button;
}

function renderAnnouncements(entries) {
  window.PepperNewsComments?.reconcile('announcements', entries);
  const signature = JSON.stringify(entries);
  if (signature === state.announcementSignature) {
    renderAnnouncementEditor();
    $('announcementRetry').hidden = true;
    window.PepperAnnouncementPopup?.syncEntries(entries);
    return;
  }
  state.announcementSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const article = document.createElement('article');
    article.className = 'changelog-entry';
    article.dataset.entryId = entry.id;
    const meta = document.createElement('div');
    meta.className = 'changelog-entry-meta';
    const date = document.createElement('time');
    date.dateTime = entry.createdAt;
    date.textContent = new Date(entry.createdAt).toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    });
    const title = document.createElement('h2');
    title.textContent = entry.title;
    const description = document.createElement('p');
    description.className = 'changelog-entry-description';
    description.textContent = entry.description;
    const actions = document.createElement('div');
    actions.className = 'changelog-entry-actions';
    actions.hidden = true;
    const deleteButton = announcementActionButton('Delete', 'delete');
    deleteButton.classList.add('changelog-delete-button');
    deleteButton.setAttribute('aria-label', `Delete ${entry.title}`);
    const confirmation = document.createElement('span');
    confirmation.className = 'changelog-delete-confirm';
    confirmation.hidden = true;
    const prompt = document.createElement('span');
    prompt.textContent = 'Delete this announcement?';
    confirmation.append(prompt, announcementActionButton('Confirm delete', 'confirm'), announcementActionButton('Cancel', 'cancel'));
    actions.append(deleteButton, confirmation);
    const dates = document.createElement('div'); dates.className = 'news-entry-date'; dates.append(date);
    meta.append(dates, newsEntryAuthor(entry));
    article.append(meta, title, description, actions);
    window.PepperNewsComments?.mount(article, 'announcements', entry);
    fragment.append(article);
  }
  $('announcementEntries').replaceChildren(fragment);
  renderAnnouncementEditor();
  announcementLoadFailed = false;
  message($('announcementMessage'), entries.length ? '' : 'No announcements yet.');
  $('announcementRetry').hidden = true;
  window.PepperAnnouncementPopup?.syncEntries(entries);
}

async function loadAnnouncements(refresh = false) {
  if (pageKind !== 'announcements') return;
  if (announcementLoadPromise) {
    await announcementLoadPromise;
    if (refresh) return loadAnnouncements();
    return;
  }
  const revision = announcementRevision;
  announcementLoadPromise = (async () => {
    try {
      const data = await api('announcements');
      // A read started before a publish or deletion cannot overwrite its result.
      if (revision !== announcementRevision) return;
      state.announcementEntries = data.entries;
      if (announcementLoadFailed) {
        message($('announcementMessage'), data.entries.length ? '' : 'No announcements yet.');
        announcementLoadFailed = false;
      }
      renderAnnouncements(data.entries);
    } catch (error) {
      if (revision !== announcementRevision) return;
      announcementLoadFailed = true;
      message($('announcementMessage'), 'Announcements unavailable. Try again.');
      $('announcementRetry').hidden = false;
    }
  })();
  try { await announcementLoadPromise; }
  finally { announcementLoadPromise = null; }
}

function setAnnouncementSubmitting(submitting) {
  state.announcementSubmitting = submitting;
  setAccountSubmitting(submitting);
  $('announcementSubmit').disabled = submitting;
  $('announcementEntries').querySelectorAll('.changelog-entry-actions button').forEach(button => { button.disabled = submitting; });
}

function focusAnnouncementMessage() {
  $('announcementMessage').tabIndex = -1;
  $('announcementMessage').focus();
}

function announcementPermissionError(error) {
  if (error.status !== 401 && error.status !== 403) return false;
  if (error.banned || accountBanned) return true;
  if (error.status === 401) setUser(null);
  else {
    if (state.user) state.user.canManageAnnouncements = false;
    renderAnnouncementEditor();
  }
  announcementLoadFailed = false;
  message($('announcementMessage'), error.message);
  if (error.status === 401) $('accountButton').focus();
  else focusAnnouncementMessage();
  return true;
}

$('announcementEntries').addEventListener('click', event => {
  const button = event.target.closest('button[data-announcement-action]');
  if (!button || !state.user?.canManageAnnouncements || !moderationViewEnabled() || state.announcementSubmitting || state.accountSubmitting) return;
  const article = button.closest('.changelog-entry');
  const confirmation = article.querySelector('.changelog-delete-confirm');
  const deleteButton = article.querySelector('.changelog-delete-button');
  if (button.dataset.announcementAction === 'delete') {
    deleteButton.hidden = true;
    confirmation.hidden = false;
    confirmation.querySelector('button').focus();
  } else if (button.dataset.announcementAction === 'cancel') {
    confirmation.hidden = true;
    deleteButton.hidden = false;
    deleteButton.focus();
  } else if (button.dataset.announcementAction === 'confirm') {
    void deleteAnnouncementEntry(article.dataset.entryId);
  }
});

async function deleteAnnouncementEntry(entryId) {
  if (!state.user?.canManageAnnouncements || !moderationViewEnabled() || state.announcementSubmitting || state.accountSubmitting || !canDeleteAnnouncement(state.announcementEntries?.find(entry => entry.id === entryId))) return;
  setAnnouncementSubmitting(true);
  let deleted = false;
  try {
    const data = await api(`announcements/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
    announcementRevision++;
    state.announcementEntries = data.entries;
    renderAnnouncements(data.entries);
    message($('announcementMessage'), 'Announcement deleted.', true);
    deleted = true;
    void loadAnnouncements(true);
  } catch (error) {
    if (!announcementPermissionError(error)) {
      if (error.status === 404) await loadAnnouncements(true);
      announcementLoadFailed = false;
      message($('announcementMessage'), error.message);
      if (error.status === 404) focusAnnouncementMessage();
    }
  } finally {
    setAnnouncementSubmitting(false);
    if (deleted) {
      const nextDelete = $('announcementEntries').querySelector('.changelog-delete-button');
      (nextDelete || $('announcementSubmit')).focus();
    }
  }
}

$('announcementForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.announcementSubmitting || state.accountSubmitting || !moderationViewEnabled() || !state.user?.canManageAnnouncements) return;
  setAnnouncementSubmitting(true);
  message($('announcementFormMessage'), 'Publishing announcement…');
  try {
    const data = await api('announcements', { method: 'POST', body: JSON.stringify({
      title: $('announcementTitle').value,
      description: $('announcementDescription').value
    }) });
    announcementRevision++;
    state.announcementEntries = [data.entry, ...(state.announcementEntries || []).filter(entry => entry.id !== data.entry.id)];
    renderAnnouncements(state.announcementEntries);
    $('announcementForm').reset();
    message($('announcementFormMessage'), 'Announcement published.', true);
    void loadAnnouncements(true);
  } catch (error) {
    if (!announcementPermissionError(error)) message($('announcementFormMessage'), error.message);
  } finally {
    setAnnouncementSubmitting(false);
  }
});

function renderOnlinePlayers() {
  const players = presencePlayers;
  const list = $('onlinePlayersList');
  message($('onlinePlayersMessage'), players === null ? 'Online players unavailable.' : players.length ? '' : 'Nobody online yet.');
  const signature = JSON.stringify(players);
  if (signature === presenceListSignature) return;
  presenceListSignature = signature;
  const focused = document.activeElement;
  const existing = new Map(Array.from(list.children).map(row => [row.dataset.accountId, row]));
  const retained = new Set();
  (players || []).forEach((player, index) => {
    const id = player.accountId || player.username;
    retained.add(id);
    let row = existing.get(id);
    if (!row) {
      row = document.createElement('li');
      row.dataset.accountId = id;
      const link = document.createElement('a');
      link.className = 'online-player-link';
      link.append(profileAvatar(player), document.createElement('span'));
      row.append(link);
    }
    const link = row.firstElementChild;
    link.href = profileHref(player.username);
    link.lastElementChild.textContent = player.username;
    setProfileAvatar(link.firstElementChild, player);
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  });
  Array.from(list.children).forEach(row => { if (!retained.has(row.dataset.accountId)) row.remove(); });
  if (focused && !focused.isConnected && $('onlinePlayersDialog').open) $('onlinePlayersClose').focus({ preventScroll: true });
}

function renderPresence(count, players = null) {
  const available = Number.isSafeInteger(count) && count >= 0;
  const text = available ? `${count.toLocaleString()} ${count === 1 ? 'player' : 'players'} online` : 'Player count unavailable';
  if ($('playerCount').textContent !== text) $('playerCount').textContent = text;
  $('playerCount').dataset.status = available ? 'live' : 'unavailable';
  const mobileText = available ? `${count.toLocaleString()} online` : 'count unavailable';
  if ($('mobilePlayerCount').textContent !== mobileText) $('mobilePlayerCount').textContent = mobileText;
  presencePlayers = available && Array.isArray(players) ? players : null;
  refreshOnlineAvatars();
  if ($('onlinePlayersDialog').open) renderOnlinePlayers();
}

function openOnlinePlayers() {
  const dialog = $('onlinePlayersDialog');
  if (dialog.open) return;
  renderOnlinePlayers();
  if (presencePlayers === null) message($('onlinePlayersMessage'), 'Loading players…');
  dialog.showModal();
  ['playerCount', 'mobilePlayerCount'].forEach(id => $(id).setAttribute('aria-expanded', 'true'));
  void loadPresence(true);
}

['playerCount', 'mobilePlayerCount'].forEach(id => $(id).addEventListener('click', openOnlinePlayers));
$('onlinePlayersClose').addEventListener('click', () => $('onlinePlayersDialog').close());
$('onlinePlayersDialog').addEventListener('close', () => { ['playerCount', 'mobilePlayerCount'].forEach(id => $(id).setAttribute('aria-expanded', 'false')); });
$('onlinePlayersList').addEventListener('click', event => {
  if (event.target.closest('a')) { setChatOpen(false); $('onlinePlayersDialog').close(); }
});

function loadPresence(refresh = false) {
  if (presenceSuspended) return Promise.resolve();
  if (presenceLoadPromise) {
    if (refresh) presenceRefreshQueued = true;
    return presenceLoadPromise;
  }
  const revision = presenceRevision;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  presenceLoadPromise = (async () => {
    try {
      const data = await api('presence', { signal: controller.signal, ...(state.user ? { method: 'POST', body: '{}' } : {}) });
      if (revision !== presenceRevision) return;
      renderPresence(data.count, data.players);
    } catch {
      if (revision === presenceRevision) renderPresence(null);
    }
  })().finally(() => {
    window.clearTimeout(timeout);
    presenceLoadPromise = null;
    if (presenceRefreshQueued) {
      presenceRefreshQueued = false;
      void loadPresence();
    }
  });
  return presenceLoadPromise;
}

function renderPictureControls() {
  const busy = state.accountSubmitting || accountPicture.reading || !state.user;
  $('pictureFile').disabled = busy;
  $('pictureSave').disabled = busy || !accountPicture.draft;
  $('pictureReset').disabled = busy || (!accountPicture.draft && profilePictureUrl(state.user) === '/favicon.svg');
}

function syncPictureSettings() {
  const identity = state.user?.accountId || state.user?.username || null;
  if (identity !== accountPicture.identity) {
    accountPicture.identity = identity;
    accountPicture.revision++;
    accountPicture.draft = null;
    accountPicture.reading = false;
    $('pictureForm').reset();
    message($('pictureMessage'), '');
  }
  if (!accountPicture.draft) setProfileAvatar($('picturePreview'), state.user);
  renderPictureControls();
}

function readPictureFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result), { once: true });
    reader.addEventListener('error', () => reject(new Error('Image could not load.')), { once: true });
    reader.addEventListener('abort', () => reject(new Error('Image could not load.')), { once: true });
    reader.readAsDataURL(file);
  });
}

$('pictureFile').addEventListener('change', async () => {
  if (!state.user || state.accountSubmitting) return;
  const file = $('pictureFile').files?.[0];
  if (!file) return;
  const revision = ++accountPicture.revision;
  const identity = accountPicture.identity;
  message($('pictureMessage'), '');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    $('pictureFile').value = '';
    message($('pictureMessage'), 'Choose PNG, JPG, or WebP.');
    return;
  }
  if (!file.size || file.size > 2 * 1024 * 1024) {
    $('pictureFile').value = '';
    message($('pictureMessage'), 'Image must be under 2MB.');
    return;
  }
  accountPicture.reading = true;
  renderPictureControls();
  try {
    const dataUrl = await readPictureFile(file);
    if (identity !== accountPicture.identity || revision !== accountPicture.revision) return;
    accountPicture.draft = dataUrl;
    $('picturePreview').src = dataUrl;
    $('picturePreview').onerror = () => {
      if (identity !== accountPicture.identity || revision !== accountPicture.revision) return;
      accountPicture.draft = null;
      $('pictureFile').value = '';
      setProfileAvatar($('picturePreview'), state.user);
      message($('pictureMessage'), 'Image could not load.');
      renderPictureControls();
    };
  } catch (error) {
    if (identity === accountPicture.identity && revision === accountPicture.revision) message($('pictureMessage'), error.message);
  } finally {
    if (identity === accountPicture.identity && revision === accountPicture.revision) {
      accountPicture.reading = false;
      renderPictureControls();
    }
  }
});

async function saveProfilePicture(reset = false) {
  if (!state.user || state.accountSubmitting || accountPicture.reading || (!reset && !accountPicture.draft)) return;
  const identity = state.user.accountId || state.user.username;
  const revision = userIdentityRevision;
  const isCurrent = () => revision === userIdentityRevision && identity === (state.user?.accountId || state.user?.username);
  const actionRevision = setAccountSubmitting(true);
  message($('pictureMessage'), reset ? 'Resetting picture…' : 'Saving picture…');
  try {
    const { user } = await api('account/avatar', reset ? { method: 'DELETE' } : { method: 'PUT', body: JSON.stringify({ imageDataUrl: accountPicture.draft }) });
    if (!isCurrent()) return;
    accountPicture.revision++;
    accountPicture.draft = null;
    $('pictureForm').reset();
    setUser({ ...state.user, avatarUrl: user.avatarUrl });
    state.chatOutbox.forEach(entry => { if (entry.identity === identity) entry.avatarUrl = user.avatarUrl; });
    renderChat(state.chatMessages);
    message($('pictureMessage'), reset ? 'Default picture restored.' : 'Profile picture updated.', true);
    presenceRevision++;
    void loadPresence(true);
    void loadChat(true);
  } catch (error) {
    if (isCurrent()) settingsError($('pictureMessage'), error);
  } finally { setAccountSubmitting(false, actionRevision); }
}

$('pictureForm').addEventListener('submit', event => { event.preventDefault(); void saveProfilePicture(); });
$('pictureReset').addEventListener('click', () => { void saveProfilePicture(true); });
$('profilePictureEdit').addEventListener('click', () => {
  if (!state.user || state.accountSubmitting || viewingPublicProfile) return;
  navigateTo('/settings');
  $('pictureFile').click();
});

$('deleteAccountOpen').addEventListener('click', () => {
  if (!state.user || state.accountSubmitting) return;
  $('deleteAccountForm').reset();
  message($('deleteAccountMessage'), '');
  $('deleteAccountDialog').showModal();
  $('deleteAccountPassword').focus();
});
['deleteAccountClose', 'deleteAccountCancel'].forEach(id => $(id).addEventListener('click', () => { if (!deletingAccount) $('deleteAccountDialog').close(); }));
$('deleteAccountDialog').addEventListener('cancel', event => { if (deletingAccount) event.preventDefault(); });
$('deleteAccountDialog').addEventListener('close', () => { $('deleteAccountForm').reset(); });
$('deleteAccountForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.user || state.accountSubmitting || deletingAccount) return;
  if ($('deleteAccountConfirmation').value !== 'DELETE') {
    message($('deleteAccountMessage'), 'Type DELETE to confirm.');
    $('deleteAccountConfirmation').focus();
    return;
  }
  const identity = state.user.accountId || state.user.username;
  const revision = userIdentityRevision;
  const isCurrent = () => revision === userIdentityRevision && identity === (state.user?.accountId || state.user?.username);
  const body = JSON.stringify({ currentPassword: $('deleteAccountPassword').value, confirmation: 'DELETE' });
  deletingAccount = true;
  const actionRevision = setAccountSubmitting(true);
  message($('deleteAccountMessage'), 'Deleting account…');
  try {
    await api('account', { method: 'DELETE', body });
    if (!isCurrent()) return;
    setUser(null);
    $('deleteAccountDialog').close();
    message($('accountMessage'), 'Account deleted.', true);
    leaderboardRevision++;
    void loadLeaderboard(true);
    void loadChat(true);
    $('settingsJoin').focus();
  } catch (error) {
    if (isCurrent()) settingsError($('deleteAccountMessage'), error);
  } finally {
    $('deleteAccountPassword').value = '';
    deletingAccount = false;
    setAccountSubmitting(false, actionRevision);
  }
});

function settingsError(element, error) {
  if (error.status === 401) {
    setUser(null);
    message($('accountMessage'), error.message);
    $('settingsJoin').focus();
  } else message(element, error.message);
}

$('usernameForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.accountSubmitting) return;
  setAccountSubmitting(true);
  message($('usernameMessage'), '');
  const previousUsername = state.user.username;
  const updatingIdentity = state.user.accountId || state.user.username;
  const updatingRevision = userIdentityRevision;
  try {
    const { user } = await api('account/username', { method: 'PATCH', body: JSON.stringify({
      username: $('newUsername').value,
      currentPassword: $('usernameCurrentPassword').value
    }) });
    if (userIdentityRevision !== updatingRevision || (state.user?.accountId || state.user?.username) !== updatingIdentity) return;
    const updatedUser = { ...user };
    if ((state.user.lastClaimAt || 0) > (user.lastClaimAt || 0)) {
      ['balance', 'lastClaimAt', 'nextClaimAt', 'hourlyTokenMin', 'hourlyTokenMax'].forEach(key => { updatedUser[key] = state.user[key]; });
    }
    setUser(updatedUser);
    $('chatMessages').querySelectorAll('.chat-author').forEach(author => {
      if (author.dataset.username.toLowerCase() !== previousUsername.toLowerCase()) return;
      author.dataset.username = user.username;
      author.textContent = user.username;
      author.href = '/profile';
      author.setAttribute('aria-label', `View ${user.username}'s profile`);
    });
    message($('usernameMessage'), 'Username updated.', true);
    void loadChat(true);
    leaderboardRevision++;
    void loadLeaderboard(true);
  } catch (error) {
    settingsError($('usernameMessage'), error);
  } finally {
    $('usernameCurrentPassword').value = '';
    setAccountSubmitting(false);
  }
});

$('passwordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.accountSubmitting) return;
  message($('passwordMessage'), '');
  if ($('newPassword').value !== $('confirmPassword').value) {
    message($('passwordMessage'), 'New passwords do not match.');
    $('confirmPassword').focus();
    return;
  }
  setAccountSubmitting(true);
  try {
    await api('account/password', { method: 'PATCH', body: JSON.stringify({
      currentPassword: $('passwordCurrentPassword').value,
      newPassword: $('newPassword').value
    }) });
    $('passwordForm').reset();
    message($('passwordMessage'), 'Password updated; other sessions ended.', true);
  } catch (error) {
    settingsError($('passwordMessage'), error);
  } finally {
    $('passwordCurrentPassword').value = '';
    setAccountSubmitting(false);
  }
});

function tradeCardSnapshot(card) {
  return { id: card.id, cardId: card.cardId, name: card.name, rarity: card.rarity, setName: card.setName, imageUrl: card.imageUrl || null };
}

function tradeCardMetadata(card) {
  const details = document.createElement('span');
  details.className = 'trading-copy-details';
  const name = document.createElement('strong');
  name.textContent = card.name;
  const meta = document.createElement('span');
  meta.className = 'trading-copy-meta';
  meta.textContent = [card.rarity, card.setName].filter(Boolean).join(' · ');
  const id = document.createElement('code');
  id.textContent = `Copy ${card.id}`;
  details.append(name, meta, id);
  return details;
}

function tradeCardArtwork(card) {
  if (!card.imageUrl) return null;
  try {
    const url = new URL(card.imageUrl, location.origin);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const image = document.createElement('img');
    image.className = 'trading-copy-art';
    image.src = url.href;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true });
    return image;
  } catch { return null; }
}

function renderTradeAssets(element, tokens, cards = []) {
  const tokenAmount = document.createElement('span');
  tokenAmount.className = 'trading-assets-tokens';
  tokenAmount.textContent = `${Number.isSafeInteger(tokens) && tokens >= 0 ? tokens.toLocaleString() : '—'} tokens`;
  const count = document.createElement('span');
  count.className = 'trading-assets-count';
  count.textContent = `${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`;
  const list = document.createElement('ul');
  list.className = 'trading-asset-cards';
  list.setAttribute('aria-label', 'Cards');
  if (!cards.length) {
    const empty = document.createElement('li');
    empty.className = 'trading-asset-empty';
    empty.textContent = 'None';
    list.append(empty);
  }
  for (const card of cards) {
    const item = document.createElement('li');
    const art = tradeCardArtwork(card);
    if (art) item.append(art);
    item.append(tradeCardMetadata(card));
    list.append(item);
  }
  element.replaceChildren(tokenAmount, count, list);
}

function tradeProfileLink(player) {
  const link = document.createElement('a');
  link.href = profileHref(player.username);
  link.textContent = player.username;
  link.title = `Permanent account ID: ${player.accountId}`;
  return link;
}

function tradeButton(label, action, id, disabled = false) {
  const button = document.createElement('button');
  button.className = 'button';
  button.type = 'button';
  button.textContent = label;
  button.dataset.tradeAction = action;
  button.dataset.tradeId = id;
  button.disabled = disabled;
  return button;
}

function tradingIdentityIsCurrent(identity, revision) {
  return !!identity && identity === state.user?.accountId && revision === userIdentityRevision;
}
function prefillTradingRecipient(fresh = false) {
  const username = new URLSearchParams(location.search).get('to')?.trim().slice(0, 32);
  if (!username) return;
  if (fresh) {
    cancelTradeAutosave();
    trading.lookupRevision++; trading.lookupLoading = false; trading.sessionRevision++; trading.chatRevision++;
    trading.sessionId = null; trading.session = null; trading.sessionDraft = null; trading.confirmReviewVersion = null;
    trading.chatMessages = []; trading.chatSignature = null; $('tradingChatInput').value = ''; $('tradingChatMessages').replaceChildren();
    if (trading.submitting || trading.sendUncertain) {
      $('tradingRecipient').value = trading.review?.recipient.username || $('tradingRecipient').value;
      if (trading.sendUncertain) message($('tradingFormMessage'), 'Resolve your pending request first.');
      return;
    }
    trading.review = null; trading.recipient = null; message($('tradingFormMessage'), '');
  } else if ($('tradingRecipient').value || trading.review || trading.sessionId || trading.lookupLoading) return;
  $('tradingRecipient').value = username;
}
function ownTradeSide(trade) {
  const sender = trade.sender.accountId === state.user?.accountId;
  return { tokens: sender ? trade.offeredTokens : trade.requestedTokens, cards: (sender ? trade.offeredCards : trade.requestedCards) || [], confirmed: sender ? trade.senderConfirmed : trade.recipientConfirmed };
}
function partnerTradeSide(trade) {
  const sender = trade.sender.accountId === state.user?.accountId;
  return { player: sender ? trade.recipient : trade.sender, tokens: sender ? trade.requestedTokens : trade.offeredTokens, cards: (sender ? trade.requestedCards : trade.offeredCards) || [], confirmed: sender ? trade.recipientConfirmed : trade.senderConfirmed };
}
function activeTrade(trade) { return ['pending', 'negotiating'].includes(trade.status); }
function acceptedTradeRequest(trade) { return trade.requestAccepted === true || ['negotiating', 'accepted'].includes(trade.status); }
function tradeStatusLabel(status) { return { pending: 'Requested', negotiating: 'In progress', accepted: 'Completed', declined: 'Declined', cancelled: 'Cancelled' }[status] || status; }
function newestTrade(incoming, previous) {
  if (!previous || incoming.id !== previous.id) return incoming;
  const incomingVersion = incoming.version || 0, previousVersion = previous.version || 0;
  if (incomingVersion < previousVersion) return previous;
  if (!activeTrade(previous) && activeTrade(incoming)) return previous;
  if (incomingVersion === previousVersion) {
    if ((new Date(incoming.updatedAt).getTime() || 0) < (new Date(previous.updatedAt).getTime() || 0)) return previous;
    if (activeTrade(previous) && activeTrade(incoming) && (previous.senderConfirmed && !incoming.senderConfirmed || previous.recipientConfirmed && !incoming.recipientConfirmed)) return previous;
  }
  return incoming;
}
function unavailableTradeCards(cards) { return cards.filter(card => !(tradeInventories.offered.cards || []).some(owned => owned.id === card.id)); }
function tradingBusy() { return trading.submitting || !!trading.action || state.accountSubmitting; }
function mergeTradingUser(user) {
  if (user?.accountId !== state.user?.accountId || !user) return;
  const updated = { ...state.user, ...user };
  if (JSON.stringify(updated) !== JSON.stringify(state.user)) setUser(updated);
}
function rememberTrade(trade) {
  trade = newestTrade(trade, trading.trades?.find(item => item.id === trade.id));
  const all = [trade, ...(trading.trades || []).filter(item => item.id !== trade.id)].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  trading.trades = [...all.filter(activeTrade), ...all.filter(item => !activeTrade(item)).slice(0, 100)];
}
function syncTradingUser() {
  const identity = state.user?.accountId || null, changed = trading.identity !== identity;
  if (changed) {
    cancelTradeAutosave();
    tradeRevision++; trading.lookupRevision++; trading.sessionRevision++; trading.chatRevision++;
    Object.assign(trading, { identity, trades: null, signature: null, recipient: null, lookupLoading: false, review: null, submitting: false, sendUncertain: false, action: null, actionRetry: null, sessionId: null, session: null, sessionDraft: null, confirmReviewVersion: null, chatMessages: [], chatSignature: null, chatOutbox: [] });
    tradeNotification.id = null; tradeNotification.error = null; tradeNotification.signature = null;
    tradeInventories.offered = newTradeInventory(identity); $('tradingForm').reset(); $('tradingChatForm').reset();
    ['tradingFormMessage', 'tradingMessage', 'tradingActionMessage', 'tradingSessionMessage', 'tradingChatMessage'].forEach(id => message($(id), ''));
    $('tradingRetry').hidden = true; ['tradingReceived', 'tradingSent', 'tradingHistory', 'tradingChatMessages', 'tradingSessionCards', 'tradingOwnReadonly', 'tradingPartnerAssets'].forEach(id => $(id).replaceChildren());
    $('tradingSessionCards').removeAttribute('data-signature');
  } else if (state.user) {
    trading.chatOutbox.forEach(entry => { if (entry.identity === identity) { entry.sender.username = state.user.username; entry.sender.avatarUrl = state.user.avatarUrl; } });
  }
  renderTradingState();
  if (changed && identity) void loadTrades(true);
  if (pageKind === 'trading') { prefillTradingRecipient(); if (changed && identity) refreshTradeInventories(); }
}
function renderTradeNotification() {
  const requests = state.user ? (trading.trades || []).filter(trade => trade.status === 'pending' && trade.recipient.accountId === state.user.accountId).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)) : [];
  const request = requests.find(trade => trade.id === tradeNotification.id) || requests[0];
  tradeNotification.id = request?.id || null;
  const popup = $('tradeNotification'), wasFocused = popup.contains(document.activeElement); popup.hidden = !request;
  window.PepperGames?.renderNotification();
  if (!request) {
    tradeNotification.signature = null; tradeNotification.error = null;
    if (wasFocused) { if ($('chat').classList.contains('open')) $('chatClose').focus({ preventScroll: true }); else focusRouteHeading(); }
    return;
  }
  const accepting = trading.action?.id === request.id && trading.action.action === 'join';
  const declining = trading.action?.id === request.id && trading.action.action === 'decline';
  const retryAccept = trading.actionRetry?.id === request.id && trading.actionRetry.action === 'join';
  const retryDecline = trading.actionRetry?.id === request.id && trading.actionRetry.action === 'decline';
  const busy = tradingBusy();
  const error = tradeNotification.error?.id === request.id ? tradeNotification.error.text : '';
  const signature = JSON.stringify([request.id, request.sender.username, requests.length, accepting, declining, retryAccept, retryDecline, !!trading.actionRetry, busy, error]);
  if (signature === tradeNotification.signature) return; tradeNotification.signature = signature;
  $('tradeNotificationSender').textContent = request.sender.username; $('tradeNotificationSender').href = profileHref(request.sender.username);
  $('tradeNotificationCount').textContent = requests.length > 1 ? `${requests.length} requests waiting` : ''; $('tradeNotificationCount').hidden = requests.length < 2;
  $('tradeNotificationAccept').disabled = busy || (!!trading.actionRetry && !retryAccept); $('tradeNotificationAccept').textContent = accepting ? 'Accepting…' : retryAccept ? 'Retry acceptance' : 'Accept';
  $('tradeNotificationDecline').disabled = busy || (!!trading.actionRetry && !retryDecline); $('tradeNotificationDecline').textContent = declining ? 'Declining…' : retryDecline ? 'Retry decline' : 'Decline';
  message($('tradeNotificationMessage'), retryAccept ? 'Connection lost. Retry acceptance.' : retryDecline ? 'Connection lost. Retry decline.' : error);
}
async function acceptTradeNotification() {
  const id = tradeNotification.id, request = trading.trades?.find(trade => trade.id === id);
  if (!state.user || tradingBusy() || !request || request.status !== 'pending' || request.recipient.accountId !== state.user.accountId || (trading.actionRetry && (trading.actionRetry.id !== id || trading.actionRetry.action !== 'join'))) return;
  const identity = state.user.accountId, identityRevision = userIdentityRevision;
  tradeNotification.error = null;
  setChatOpen(false); navigateTo('/trading', { focus: false }); openTradeSession(id, request);
  await actOnTrade(id, 'join');
  if (!tradingIdentityIsCurrent(identity, identityRevision)) return;
  if (trading.trades?.find(trade => trade.id === id)?.status === 'pending') tradeNotification.error = { id, text: 'Accept failed. Try again.' };
  renderTradeNotification();
}
async function declineTradeNotification() {
  const id = tradeNotification.id, request = trading.trades?.find(trade => trade.id === id);
  if (!state.user || tradingBusy() || !request || request.status !== 'pending' || request.recipient.accountId !== state.user.accountId || (trading.actionRetry && (trading.actionRetry.id !== id || trading.actionRetry.action !== 'decline'))) return;
  const identity = state.user.accountId, identityRevision = userIdentityRevision;
  tradeNotification.error = null;
  await actOnTrade(id, 'decline');
  if (!tradingIdentityIsCurrent(identity, identityRevision)) return;
  if (trading.trades?.find(trade => trade.id === id)?.status === 'pending') tradeNotification.error = { id, text: 'Decline failed. Try again.' };
  renderTradeNotification();
}
$('tradeNotificationAccept').addEventListener('click', () => void acceptTradeNotification());
$('tradeNotificationDecline').addEventListener('click', () => void declineTradeNotification());
function renderOwnCardPicker(containerId, countId, messageId, selected, disabled) {
  const inventory = tradeInventories.offered, container = $(containerId), missing = unavailableTradeCards(selected);
  $(countId).textContent = `${selected.length} / 50 selected`; container.setAttribute('aria-busy', String(inventory.loading));
  const status = $(messageId);
  status.textContent = inventory.error ? 'Cards unavailable. Try refreshing.' : inventory.loading && !inventory.cards ? 'Loading your cards…' : missing.length ? 'Remove unavailable card copies.' : inventory.cards?.length === 0 ? 'No tradable cards yet.' : '';
  status.hidden = !status.textContent;
  status.classList.toggle('trading-inventory-error', !!inventory.error || missing.length > 0);
  const signature = JSON.stringify([inventory.cards, selected, disabled]); if (container.dataset.signature === signature) return; container.dataset.signature = signature;
  const focused = document.activeElement?.closest(`#${containerId} [data-card-id]`), focusedId = focused?.dataset.cardId, focusedTag = focused?.tagName;
  const selectedIds = new Set(selected.map(card => card.id));
  container.replaceChildren(...[...(inventory.cards || []), ...missing].map(card => {
    const available = (inventory.cards || []).some(owned => owned.id === card.id), checked = selectedIds.has(card.id);
    const row = document.createElement('div'); row.className = 'trading-card-choice'; row.classList.toggle('is-selected', checked); row.classList.toggle('is-unavailable', !available);
    const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked; input.dataset.cardId = card.id;
    input.disabled = disabled || !available || (!checked && selected.length >= 50); input.setAttribute('aria-label', `Give ${card.name}, copy ${card.id}`); label.append(input);
    const art = tradeCardArtwork(card); if (art) label.append(art); label.append(tradeCardMetadata(card)); row.append(label);
    if (!available) {
      const notice = document.createElement('span'); notice.className = 'trading-unavailable-label'; notice.textContent = 'Unavailable';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button'; remove.textContent = 'Remove'; remove.dataset.cardId = card.id; remove.dataset.removeCard = 'true'; remove.disabled = disabled;
      remove.setAttribute('aria-label', `Remove unavailable ${card.name}, copy ${card.id}`); row.append(notice, remove);
    }
    return row;
  }));
  if (focusedId) Array.from(container.querySelectorAll('[data-card-id]')).find(item => item.dataset.cardId === focusedId && item.tagName === focusedTag && !item.disabled)?.focus({ preventScroll: true });
}
function loadTradeInventory(side = 'offered', refresh = false) {
  if (side !== 'offered') return Promise.resolve();
  const inventory = tradeInventories.offered; if (pageKind !== 'trading' || !state.user || !inventory.ownerId) return Promise.resolve();
  if (tradingBusy()) { inventory.refreshQueued = true; return Promise.resolve(); }
  if (inventory.loadPromise) { if (refresh) inventory.refreshQueued = true; return inventory.loadPromise; }
  const identity = state.user.accountId, identityRevision = userIdentityRevision, revision = tradeRevision;
  const current = () => tradeInventories.offered === inventory && tradingIdentityIsCurrent(identity, identityRevision);
  inventory.loading = true; inventory.error = null;
  inventory.loadPromise = (async () => {
    try {
      const data = await api('trades/inventory'); if (!current()) return;
      if (revision !== tradeRevision) { inventory.refreshQueued = true; return; }
      if (data.owner.accountId !== identity) throw new Error('Collection changed. Please refresh.');
      inventory.cards = data.cards.filter(card => card.tradable === true).map(tradeCardSnapshot);
    } catch (error) { if (!current()) return; if (error.status === 401) { setUser(null); return; } inventory.error = error.message; }
    finally { if (!current()) return; inventory.loading = false; inventory.loadPromise = null; if (trading.session?.status === 'negotiating' && trading.sessionDraft?.dirty) { validateTradeDraft(); scheduleTradeAutosave(); } renderTradingState(); if (inventory.refreshQueued) { inventory.refreshQueued = false; void loadTradeInventory(); } }
  })();
  renderTradingState(); return inventory.loadPromise;
}
function refreshTradeInventories() { if (trading.session?.status === 'negotiating') void loadTradeInventory('offered', true); }
function renderTradingState() {
  const loading = document.body.classList.contains('auth-loading'), busy = tradingBusy() || !!trading.actionRetry;
  $('tradingAuthLoading').hidden = !loading; $('tradingGuest').hidden = loading || !!state.user; $('tradingAccount').hidden = loading || !state.user;
  $('tradingBalance').textContent = state.user ? state.user.balance.toLocaleString() : '0'; $('tradingLayout').hidden = !!trading.sessionId; $('tradingSession').hidden = !trading.sessionId;
  $('tradingRecipient').disabled = busy || trading.lookupLoading || trading.sendUncertain;
  if ($('tradingRecipient').disabled || trading.sessionId || !state.user) trading.playerPicker?.close();
  $('tradingForm').hidden = false;
  $('tradingSend').disabled = busy || trading.lookupLoading; $('tradingSend').textContent = trading.lookupLoading ? 'Finding…' : trading.submitting ? 'Sending…' : trading.sendUncertain ? 'Retry request' : 'Send request';
  $('tradingRefresh').disabled = tradingBusy() || !!tradeLoadPromise; $('tradingRetry').disabled = tradingBusy() || !!tradeLoadPromise;
  $('tradingActionRetry').hidden = !trading.actionRetry; $('tradingActionRetry').disabled = tradingBusy();
  $('tradingSessionBack').disabled = busy;
  $('tradingSessionInventoryRefresh').disabled = busy || tradeInventories.offered.loading;
  renderTradeLists(); renderTradeSession(); renderTradeNotification();
}
function renderTradeCard(trade) {
  const own = ownTradeSide(trade), partner = partnerTradeSide(trade), row = document.createElement('article'); row.className = 'trading-card trading-offer-card'; row.dataset.tradeId = trade.id;
  const heading = document.createElement('h3'); heading.append(trade.sender.accountId === state.user.accountId ? 'With ' : 'From ', tradeProfileLink(partner.player));
  const status = document.createElement('span'); status.className = `trading-status trading-status-${trade.status}`; status.textContent = tradeStatusLabel(trade.status);
  const header = document.createElement('div'); header.className = 'trading-offer-heading'; header.append(heading, status);
  const terms = document.createElement('dl'); terms.className = 'trading-terms';
  const ownLabel = document.createElement('dt'); ownLabel.textContent = trade.status === 'accepted' ? 'You gave' : 'Your offer';
  const ownAssets = document.createElement('dd'); renderTradeAssets(ownAssets, own.tokens, own.cards);
  const partnerLabel = document.createElement('dt'); partnerLabel.textContent = trade.status === 'accepted' ? 'You received' : 'Their offer';
  const partnerAssets = document.createElement('dd'); renderTradeAssets(partnerAssets, partner.tokens, partner.cards); terms.append(ownLabel, ownAssets, partnerLabel, partnerAssets);
  const date = document.createElement('p'); date.className = 'trading-date'; date.textContent = `Updated ${formatProfileDate(trade.updatedAt, true)}`;
  const actions = document.createElement('div'), disabled = tradingBusy() || !!trading.actionRetry; actions.className = 'trading-actions'; actions.append(tradeButton(trade.status === 'pending' ? 'Open request' : activeTrade(trade) ? 'Open trade' : 'View trade', 'open', trade.id, disabled));
  if (trade.status === 'pending' && trade.recipient.accountId === state.user.accountId) actions.append(tradeButton('Accept request', 'join', trade.id, disabled), tradeButton('Decline', 'decline', trade.id, disabled));
  else if (activeTrade(trade)) actions.append(tradeButton('Cancel trade', 'cancel', trade.id, disabled));
  row.append(header); if (acceptedTradeRequest(trade)) row.append(terms); row.append(date, actions); return row;
}
function renderTradeLists() {
  if (!state.user || !trading.trades) { ['tradingReceivedEmpty', 'tradingSentEmpty', 'tradingHistoryEmpty'].forEach(id => { $(id).hidden = true; }); return; }
  const signature = JSON.stringify([trading.trades, state.user.accountId, state.user.username, tradingBusy(), trading.actionRetry]); if (signature === trading.signature) return; trading.signature = signature;
  const focused = document.activeElement?.closest('#tradingLists button[data-trade-action]'), focusedId = focused?.dataset.tradeId, focusedAction = focused?.dataset.tradeAction;
  const received = trading.trades.filter(trade => activeTrade(trade) && trade.recipient.accountId === state.user.accountId), sent = trading.trades.filter(trade => activeTrade(trade) && trade.sender.accountId === state.user.accountId), history = trading.trades.filter(trade => !activeTrade(trade));
  for (const [id, emptyId, trades] of [['tradingReceived', 'tradingReceivedEmpty', received], ['tradingSent', 'tradingSentEmpty', sent], ['tradingHistory', 'tradingHistoryEmpty', history]]) { $(id).replaceChildren(...trades.map(renderTradeCard)); $(emptyId).hidden = trades.length > 0; }
  if (focusedId) Array.from($('tradingLists').querySelectorAll('button[data-trade-action]')).find(button => button.dataset.tradeId === focusedId && button.dataset.tradeAction === focusedAction && !button.disabled)?.focus({ preventScroll: true });
}
function loadTrades(refresh = false) {
  if (!state.user) return Promise.resolve();
  if (tradingBusy()) { trading.refreshQueued = true; return Promise.resolve(); }
  if (tradeLoadPromise) { if (refresh) trading.refreshQueued = true; return tradeLoadPromise; }
  const identity = state.user.accountId, identityRevision = userIdentityRevision, revision = tradeRevision, accountRevision = authRevision;
  if (!trading.trades) message($('tradingMessage'), 'Loading trades…'); $('tradingLists').setAttribute('aria-busy', 'true');
  tradeLoadPromise = (async () => {
    try {
      const data = await api('trades'); if (!tradingIdentityIsCurrent(identity, identityRevision)) return;
      if (revision !== tradeRevision) { trading.refreshQueued = true; return; }
      trading.trades = data.trades.map(trade => newestTrade(trade, trading.trades?.find(previous => previous.id === trade.id))); if (accountRevision === authRevision) mergeTradingUser(data.user);
      if (trading.actionRetry) { const recovered = trading.trades.find(trade => trade.id === trading.actionRetry.id); if (recovered) reconcileTradeAction(recovered); }
      if (trading.sendUncertain && trading.review) { const recovered = trading.trades.find(trade => trade.clientOfferId === trading.review.clientOfferId && trade.sender.accountId === identity); if (recovered) finishSendingTrade(recovered); }
      if (trading.sessionId) { const session = trading.trades.find(trade => trade.id === trading.sessionId); if (session) updateTradeSession(session); }
      message($('tradingMessage'), ''); $('tradingRetry').hidden = true; renderTradingState();
    } catch (error) {
      if (!tradingIdentityIsCurrent(identity, identityRevision) || revision !== tradeRevision) return;
      if (error.status === 401) { setUser(null); return; }
      message($('tradingMessage'), trading.trades ? 'Refresh failed. Previous trades shown.' : 'Trades unavailable. Try again.'); $('tradingRetry').hidden = false;
    }
  })().finally(() => { tradeLoadPromise = null; $('tradingLists').setAttribute('aria-busy', 'false'); renderTradingState(); if (trading.refreshQueued) { trading.refreshQueued = false; void loadTrades(); } });
  renderTradingState(); return tradeLoadPromise;
}
function invalidateTradeReview() { if (trading.submitting || trading.sendUncertain) return; trading.review = null; trading.recipient = null; message($('tradingFormMessage'), ''); renderTradingState(); }
async function findTradingRecipient() {
  if (!state.user || trading.lookupLoading || tradingBusy() || trading.sendUncertain) return null;
  const username = $('tradingRecipient').value.trim(); trading.recipient = null;
  if (!username) { message($('tradingFormMessage'), 'Enter a player username.'); $('tradingRecipient').focus(); renderTradingState(); return null; }
  const revision = ++trading.lookupRevision, identity = state.user.accountId, identityRevision = userIdentityRevision, lookupRouteRevision = routeRevision, lookupSessionRevision = trading.sessionRevision;
  const current = () => tradingIdentityIsCurrent(identity, identityRevision) && revision === trading.lookupRevision && lookupRouteRevision === routeRevision && lookupSessionRevision === trading.sessionRevision && pageKind === 'trading';
  trading.lookupLoading = true; message($('tradingFormMessage'), 'Finding player…'); renderTradingState();
  try {
    const { profile } = await api(`profiles/${encodeURIComponent(username)}`); if (!current()) return null;
    if (profile.accountId === identity) throw new Error('Choose another player.'); if (!profile.accountId) throw new Error('Account ID unavailable.');
    trading.recipient = { username: profile.username, accountId: profile.accountId }; $('tradingRecipient').value = profile.username;
    return { ...trading.recipient };
  } catch (error) { if (current()) message($('tradingFormMessage'), error.message); return null; }
  finally { if (tradingIdentityIsCurrent(identity, identityRevision) && revision === trading.lookupRevision) { trading.lookupLoading = false; renderTradingState(); } }
}
function selectedTradeSnapshots(selected) { return selected.map(card => tradeCardSnapshot(tradeInventories.offered.cards.find(owned => owned.id === card.id))).sort((a, b) => a.id.localeCompare(b.id)); }
function validTradeContribution(tokens, cards, element) {
  const fail = text => { element.classList.remove('trading-draft-info'); message(element, text); if (element.id === 'tradingDraftMessage' && trading.sessionDraft) trading.sessionDraft.error = text; return false; };
  if (!Number.isSafeInteger(tokens) || tokens < 0 || cards.length > 50) return fail('Invalid tokens or card count.');
  if (unavailableTradeCards(cards).length) return fail('Remove unavailable card copies.');
  if (cards.length && tradeInventories.offered.loading) return fail('Wait for cards to refresh.');
  if (element.id === 'tradingDraftMessage' && trading.sessionDraft) trading.sessionDraft.error = null;
  return true;
}
function setupTradingPlayerPicker() {
  trading.playerPicker = window.PepperPlayerPicker?.attach({
    input: $('tradingRecipient'),
    isEnabled: () => !!state.user && !accountBanned && pageKind === 'trading' && !trading.sessionId && !tradingBusy() && !trading.actionRetry && !trading.sendUncertain && !trading.lookupLoading,
    renderAvatar: player => profileAvatar(player),
    search: async prefix => {
      const identity = state.user?.accountId, revision = userIdentityRevision, navigation = routeRevision;
      const { players } = await api(`players?username=${encodeURIComponent(prefix)}`);
      return tradingIdentityIsCurrent(identity, revision) && navigation === routeRevision && pageKind === 'trading' ? players : [];
    },
    onSelect: () => { trading.lookupRevision++; trading.lookupLoading = false; invalidateTradeReview(); }
  });
}
setupTradingPlayerPicker();
$('tradingRecipient').addEventListener('input', () => { if (trading.submitting || trading.sendUncertain) return; trading.lookupRevision++; trading.lookupLoading = false; invalidateTradeReview(); });
$('tradingForm').addEventListener('submit', async event => {
  trading.playerPicker?.close();
  event.preventDefault(); if (!state.user || tradingBusy() || trading.lookupLoading || trading.actionRetry) return;
  const identity = state.user.accountId, identityRevision = userIdentityRevision, requestRouteRevision = routeRevision, requestSessionRevision = trading.sessionRevision;
  if (trading.sendUncertain && trading.review?.identity === identity) {
    trading.review = { ...trading.review, routeRevision: requestRouteRevision, sessionRevision: requestSessionRevision };
    await sendTradingOffer();
    return;
  }
  trading.review = null;
  const recipient = await findTradingRecipient();
  if (!recipient || !tradingIdentityIsCurrent(identity, identityRevision) || requestRouteRevision !== routeRevision || requestSessionRevision !== trading.sessionRevision || pageKind !== 'trading') return;
  trading.review = { recipient, clientOfferId: crypto.randomUUID(), identity, routeRevision: requestRouteRevision, sessionRevision: requestSessionRevision };
  await sendTradingOffer();
});
function finishSendingTrade(trade, request = trading.review) {
  rememberTrade(trade); trading.review = null; trading.sendUncertain = false; trading.recipient = null; trading.lookupRevision++; $('tradingForm').reset();
  message($('tradingFormMessage'), `Request sent to ${trade.recipient.username}.`, true);
  if (pageKind === 'trading' && request?.routeRevision === routeRevision && request.sessionRevision === trading.sessionRevision) openTradeSession(trade.id, trade);
  if (pageKind === 'trading') prefillTradingRecipient();
}
async function sendTradingOffer() {
  const request = trading.review;
  if (!request || request.identity !== state.user?.accountId || tradingBusy() || trading.actionRetry) return;
  const identityRevision = userIdentityRevision; tradeRevision++; trading.submitting = true; message($('tradingFormMessage'), 'Sending trade request…'); renderTradingState();
  try {
    const data = await api('trades', { method: 'POST', body: JSON.stringify({ recipientAccountId: request.recipient.accountId, offeredTokens: 0, offeredCardIds: [], clientOfferId: request.clientOfferId }) });
    if (!tradingIdentityIsCurrent(request.identity, identityRevision)) return; tradeRevision++; mergeTradingUser(data.user); finishSendingTrade(data.trade, request);
  } catch (error) {
    if (!tradingIdentityIsCurrent(request.identity, identityRevision)) return; tradeRevision++; if (error.status === 401) { setUser(null); return; }
    mergeTradingUser(error.user); trading.sendUncertain = !error.status || error.status >= 500;
    if (!trading.sendUncertain) { trading.review = null; trading.recipient = null; }
    message($('tradingFormMessage'), trading.sendUncertain ? 'Result unknown. Retry safely.' : error.message);
  } finally { if (tradingIdentityIsCurrent(request.identity, identityRevision)) { trading.submitting = false; renderTradingState(); void loadTrades(true); void loadTradeSession(true); refreshTradeInventories(); } }
}
function newSessionDraft(trade) { const own = ownTradeSide(trade); return { tokens: own.tokens, cards: own.cards.map(tradeCardSnapshot), baseVersion: trade.version, dirty: false, error: null, status: 'Updated' }; }
function sameContribution(side, payload) { return side.tokens === payload.tokens && JSON.stringify(side.cards.map(card => card.id).sort()) === JSON.stringify([...payload.cardIds].sort()); }
function cancelTradeAutosave() {
  window.clearTimeout(tradeAutosave.timer); tradeAutosave.timer = null; tradeAutosave.retryAt = 0; tradeAutosave.attempts = 0;
  // A previous session's request must not block a new session or account.
  tradeAutosave.inFlight = null;
}
function tradeDraftPayload(draft = trading.sessionDraft) {
  return { tokens: Number(draft.tokens), cardIds: draft.cards.map(card => card.id).sort(), version: trading.session.version };
}
function validateTradeDraft() {
  const draft = trading.sessionDraft;
  if (!draft) return false;
  const tokens = Number(draft.tokens);
  draft.error = !String(draft.tokens).trim() || !Number.isSafeInteger(tokens) || tokens < 0 ? 'Enter whole tokens, zero minimum.'
    : tokens > state.user.balance ? 'Not enough tokens.' : draft.cards.length > 50 ? 'Choose at most 50 cards.'
    : unavailableTradeCards(draft.cards).length ? 'Remove unavailable cards.' : null;
  return !draft.error;
}
function syncTradeAutosaveRoute() {
  if (pageKind !== 'trading') { window.clearTimeout(tradeAutosave.timer); tradeAutosave.timer = null; return; }
  if (trading.sessionDraft?.dirty && !trading.sessionDraft.error) scheduleTradeAutosave();
}
function scheduleTradeAutosave(delay = 250) {
  window.clearTimeout(tradeAutosave.timer); tradeAutosave.timer = null;
  if (pageKind !== 'trading' || !state.user || trading.session?.status !== 'negotiating' || !trading.sessionDraft?.dirty || trading.sessionDraft.error || tradeAutosave.inFlight) return;
  const identity = state.user.accountId, identityRevision = userIdentityRevision, sessionRevision = trading.sessionRevision, navigation = routeRevision, id = trading.sessionId;
  tradeAutosave.timer = window.setTimeout(() => {
    tradeAutosave.timer = null;
    if (tradingIdentityIsCurrent(identity, identityRevision) && sessionRevision === trading.sessionRevision && navigation === routeRevision && id === trading.sessionId && pageKind === 'trading') void saveTradeContribution();
  }, Math.max(delay, tradeAutosave.retryAt - Date.now()));
}
function changeTradeDraft() {
  if (trading.session?.status !== 'negotiating' || !trading.sessionDraft) return;
  const draft = trading.sessionDraft; draft.dirty = true; draft.error = null; draft.status = 'Updating…'; trading.confirmReviewVersion = null;
  if (validateTradeDraft()) scheduleTradeAutosave();
  else { window.clearTimeout(tradeAutosave.timer); tradeAutosave.timer = null; }
  renderTradeSession();
}
async function saveTradeContribution() {
  const draft = trading.sessionDraft, trade = trading.session;
  if (pageKind !== 'trading' || !state.user || trade?.status !== 'negotiating' || !draft?.dirty || tradeAutosave.inFlight) return;
  if (tradingBusy() || trading.actionRetry) { scheduleTradeAutosave(); return; }
  if (!validateTradeDraft()) { renderTradeSession(); return; }
  const payload = tradeDraftPayload(draft);
  if (!draft.refreshNeeded && sameContribution(ownTradeSide(trade), payload)) {
    draft.dirty = false; draft.baseVersion = trade.version; draft.status = 'Updated'; renderTradeSession(); return;
  }
  const operation = { id: trade.id, identity: state.user.accountId, identityRevision: userIdentityRevision, sessionRevision: trading.sessionRevision, navigation: routeRevision, payload };
  const current = () => tradingIdentityIsCurrent(operation.identity, operation.identityRevision) && operation.sessionRevision === trading.sessionRevision && operation.id === trading.sessionId && operation.navigation === routeRevision && pageKind === 'trading';
  tradeAutosave.inFlight = operation; draft.status = 'Updating…'; trading.confirmReviewVersion = null; renderTradeSession();
  try {
    if (draft.refreshNeeded) {
      const latest = await api(`trades/${encodeURIComponent(operation.id)}`);
      if (!current()) return;
      draft.refreshNeeded = false;
      rememberTrade(latest.trade); updateTradeSession(latest.trade); mergeTradingUser(latest.user);
      if (trading.session?.status !== 'negotiating' || !trading.sessionDraft?.dirty || !validateTradeDraft()) return;
      operation.payload = tradeDraftPayload();
      if (sameContribution(ownTradeSide(trading.session), operation.payload)) return;
    }
    const data = await api(`trades/${encodeURIComponent(operation.id)}/contribution`, { method: 'POST', body: JSON.stringify(operation.payload) });
    if (!current()) return;
    tradeAutosave.retryAt = 0; tradeAutosave.attempts = 0; tradeRevision++;
    rememberTrade(data.trade); updateTradeSession(data.trade); mergeTradingUser(data.user);
  } catch (error) {
    if (!current()) return;
    if (error.status === 401) { setUser(null); return; }
    mergeTradingUser(error.user); trading.confirmReviewVersion = null;
    if (error.status === 409 || !error.status || error.status >= 500) {
      try {
        const data = await api(`trades/${encodeURIComponent(operation.id)}`);
        if (!current()) return;
        rememberTrade(data.trade); updateTradeSession(data.trade); mergeTradingUser(data.user);
      } catch (refreshError) { if (current() && refreshError.status === 401) { setUser(null); return; } }
    }
    if (!current() || trading.session?.status !== 'negotiating') return;
    if ([400, 403, 404].includes(error.status)) {
      if (error.status !== 400 || sameContribution({ tokens: Number(trading.sessionDraft.tokens), cards: trading.sessionDraft.cards }, operation.payload)) trading.sessionDraft.error = 'Check your offer.';
    }
    else {
      tradeAutosave.attempts++;
      const retry = Number(error.retryAfterMs);
      tradeAutosave.retryAt = Date.now() + (error.status === 429 && Number.isFinite(retry) && retry > 0 ? retry : error.status === 409 ? 250 : Math.min(5000, 500 * 2 ** Math.min(tradeAutosave.attempts, 4)));
      trading.sessionDraft.status = 'Waiting…';
      validateTradeDraft();
    }
  } finally {
    if (tradeAutosave.inFlight === operation) tradeAutosave.inFlight = null;
    const sameSession = tradingIdentityIsCurrent(operation.identity, operation.identityRevision) && operation.sessionRevision === trading.sessionRevision && operation.id === trading.sessionId;
    if (sameSession && !current() && trading.sessionDraft?.dirty) trading.sessionDraft.refreshNeeded = true;
    if (sameSession && pageKind === 'trading') {
      const latest = trading.sessionDraft;
      if (trading.session?.status === 'negotiating' && latest?.dirty && !latest.error && !latest.refreshNeeded && sameContribution(ownTradeSide(trading.session), tradeDraftPayload(latest))) {
        latest.dirty = false; latest.baseVersion = trading.session.version; latest.status = 'Updated'; tradeAutosave.retryAt = 0; tradeAutosave.attempts = 0;
      }
      renderTradeSession(); scheduleTradeAutosave();
    } else syncTradeAutosaveRoute();
  }
}
function reconcileTradeAction(trade) {
  const retry = trading.actionRetry;
  if (retry?.id === trade.id) {
    const recovered = (retry.action === 'join' && trade.status === 'negotiating') || (retry.action === 'contribution' && trade.version > retry.payload.version && sameContribution(ownTradeSide(trade), retry.payload)) || (retry.action === 'confirm' && (ownTradeSide(trade).confirmed || trade.status === 'accepted')) || (retry.action === 'cancel' && trade.status === 'cancelled') || (retry.action === 'decline' && trade.status === 'declined');
    if (recovered) { if (retry.action === 'contribution' && trading.sessionId === trade.id) trading.sessionDraft = newSessionDraft(trade); trading.actionRetry = null; message($('tradingActionMessage'), 'Done. Latest trade shown.', true); }
    else if (!activeTrade(trade)) { trading.actionRetry = null; message($('tradingActionMessage'), `Trade ${tradeStatusLabel(trade.status).toLowerCase()}.`); }
  }
}
function updateTradeSession(trade, saved = false) {
  if (trade.id !== trading.sessionId) return;
  const previous = trading.session;
  trade = newestTrade(trade, previous);
  trading.session = trade;
  if (!trading.sessionDraft || !trading.sessionDraft.dirty || !activeTrade(trade)) trading.sessionDraft = newSessionDraft(trade);
  else {
    trading.sessionDraft.baseVersion = trade.version;
    if (!tradeAutosave.inFlight && !trading.sessionDraft.error && !trading.sessionDraft.refreshNeeded && sameContribution(ownTradeSide(trade), tradeDraftPayload())) trading.sessionDraft = newSessionDraft(trade);
  }
  if (!activeTrade(trade)) cancelTradeAutosave();
  if (trading.confirmReviewVersion !== trade.version) trading.confirmReviewVersion = null;
  if (previous && !trading.action) {
    if (previous.status !== 'accepted' && trade.status === 'accepted') message($('tradingActionMessage'), 'Trade completed. Assets transferred.', true);
    else if (activeTrade(previous) && !activeTrade(trade)) message($('tradingActionMessage'), `Trade ${trade.status}.`);
    else if (trade.version > previous.version) message($('tradingActionMessage'), previous.status === 'pending' && trade.status === 'negotiating' ? 'Request accepted. Choose your offer.' : 'Offers changed. Confirm again.');
  }
  if (trade.status === 'negotiating' && previous?.status !== 'negotiating') refreshTradeInventories();
  reconcileTradeAction(trade);
  renderTradeSession();
  if (trading.sessionDraft?.dirty && !trading.sessionDraft.error) scheduleTradeAutosave();
}
function openTradeSession(id, trade = null) {
  if (!state.user || tradingBusy() && !trading.submitting) return;
  if (trading.sessionId !== id) {
    cancelTradeAutosave();
    trading.sessionRevision++; trading.chatRevision++; trading.sessionId = id; trading.session = null; trading.sessionDraft = null; trading.confirmReviewVersion = null; trading.chatMessages = []; trading.chatSignature = null; $('tradingChatInput').value = '';
    $('tradingChatMessages').replaceChildren();
    message($('tradingSessionMessage'), 'Loading trade…'); message($('tradingChatMessage'), ''); $('tradingSessionRetry').hidden = true;
    message($('tradingActionMessage'), '');
  }
  if (trade) updateTradeSession(trade); renderTradingState(); void loadTradeSession(true); void loadTradeChat(true); $('tradingSessionTitle').focus({ preventScroll: true });
}
$('tradingSessionBack').addEventListener('click', () => {
  cancelTradeAutosave();
  trading.sessionRevision++; trading.chatRevision++; trading.sessionId = null; trading.session = null; trading.sessionDraft = null; trading.confirmReviewVersion = null;
  renderTradingState(); $('tradingCreateTitle').tabIndex = -1; $('tradingCreateTitle').focus({ preventScroll: true });
});
function renderTradeSession() {
  const trade = trading.session; $('tradingSessionContent').hidden = !trade;
  if (!trade || !state.user) {
    $('tradingSessionTitle').textContent = 'Trade session';
    ['tradingSessionStatus', 'tradingOwnConfirmed', 'tradingPartnerConfirmed'].forEach(id => { $(id).textContent = ''; });
    ['tradingOwnOffer', 'tradingPartnerOffer', 'tradingOfferEditor'].forEach(id => { $(id).hidden = true; });
    ['tradingOwnReadonly', 'tradingPartnerAssets'].forEach(id => $(id).replaceChildren());
    return;
  }
  const own = ownTradeSide(trade), partner = partnerTradeSide(trade), sender = trade.sender.accountId === state.user.accountId;
  const pending = trade.status === 'pending', requestAccepted = acceptedTradeRequest(trade), editable = trade.status === 'negotiating', busy = tradingBusy() || !!trading.actionRetry, draft = trading.sessionDraft;
  $('tradingOwnOffer').hidden = !requestAccepted; $('tradingPartnerOffer').hidden = !requestAccepted;
  $('tradingSessionTitle').textContent = `Trade with ${partner.player.username}`; $('tradingSessionStatus').textContent = tradeStatusLabel(trade.status); $('tradingSessionStatus').className = `trading-status trading-status-${trade.status}`;
  const previewDraft = editable && draft;
  $('tradingOwnConfirmed').textContent = trade.status === 'accepted' ? 'Completed' : previewDraft?.dirty ? 'Updating…' : own.confirmed ? 'Confirmed' : 'Not confirmed';
  $('tradingPartnerConfirmed').textContent = trade.status === 'accepted' ? 'Completed' : partner.confirmed ? 'Confirmed' : 'Not confirmed';
  $('tradingOwnConfirmed').classList.toggle('success', !!own.confirmed && !previewDraft?.dirty); $('tradingPartnerConfirmed').classList.toggle('success', !!partner.confirmed);
  if (!requestAccepted) {
    ['tradingOwnReadonly', 'tradingPartnerAssets', 'tradingSessionCards'].forEach(id => $(id).replaceChildren());
    $('tradingSessionCards').removeAttribute('data-signature');
    $('tradingSessionTokens').value = '0';
  } else {
    renderTradeAssets($('tradingOwnReadonly'), previewDraft ? (String(draft.tokens).trim() ? Number(draft.tokens) : null) : own.tokens, previewDraft ? draft.cards : own.cards);
    renderTradeAssets($('tradingPartnerAssets'), partner.tokens, partner.cards);
  }
  $('tradingOwnReadonly').hidden = !requestAccepted; $('tradingOfferEditor').hidden = !editable; $('tradingContributionForm').hidden = !editable;
  if (editable && draft) {
    if ($('tradingSessionTokens').value !== String(draft.tokens)) $('tradingSessionTokens').value = draft.tokens; $('tradingSessionTokens').disabled = busy;
    renderOwnCardPicker('tradingSessionCards', 'tradingSessionCardCount', 'tradingSessionInventoryMessage', draft.cards, busy);
    message($('tradingDraftMessage'), draft.error || (draft.dirty || tradeAutosave.inFlight ? draft.status || 'Updating…' : 'Updated'), !draft.error && !draft.dirty && !tradeAutosave.inFlight);
    $('tradingDraftMessage').classList.toggle('trading-draft-info', !draft.error && (draft.dirty || !!tradeAutosave.inFlight));
  }
  const actions = $('tradingSessionActions'), focusedAction = document.activeElement?.closest('#tradingSessionActions button')?.dataset.tradeAction; actions.replaceChildren();
  if (pending && !sender) actions.append(tradeButton('Accept request', 'join', trade.id, busy), tradeButton('Decline', 'decline', trade.id, busy));
  if (trade.status === 'negotiating') actions.append(tradeButton(own.confirmed ? 'You confirmed' : 'Review & confirm', 'review-confirm', trade.id, busy || !!tradeAutosave.inFlight || own.confirmed || draft.dirty || !!draft.error || draft.baseVersion !== trade.version));
  if (activeTrade(trade)) actions.append(tradeButton('Cancel trade', 'cancel', trade.id, busy));
  if (focusedAction) Array.from(actions.children).find(button => button.dataset.tradeAction === focusedAction && !button.disabled)?.focus({ preventScroll: true });
  $('tradingConfirmReview').hidden = trading.confirmReviewVersion !== trade.version || trade.status !== 'negotiating' || !!draft?.dirty || !!draft?.error || !!tradeAutosave.inFlight || !!own.confirmed;
  $('tradingConfirmFinal').disabled = busy || trading.confirmReviewVersion !== trade.version || !!draft?.dirty || !!draft?.error || !!tradeAutosave.inFlight; $('tradingConfirmBack').disabled = busy;
  const chatVisible = requestAccepted; $('tradingPrivateChat').hidden = !chatVisible; $('tradingChatForm').hidden = trade.status !== 'negotiating'; $('tradingChatClosed').hidden = !chatVisible || trade.status === 'negotiating';
  $('tradingChatSend').disabled = trading.chatOutbox.some(entry => entry.tradeId === trade.id && ['sending', 'waiting'].includes(entry.status)); renderTradeChat();
}
function loadTradeSession(refresh = false) {
  if (pageKind !== 'trading' || !state.user || !trading.sessionId) return Promise.resolve();
  if (tradingBusy()) { tradeSessionRefreshQueued = true; return Promise.resolve(); }
  if (tradeSessionLoadPromise) { if (refresh) tradeSessionRefreshQueued = true; return tradeSessionLoadPromise; }
  const identity = state.user.accountId, identityRevision = userIdentityRevision, sessionRevision = trading.sessionRevision, id = trading.sessionId, revision = tradeRevision, accountRevision = authRevision;
  const current = () => tradingIdentityIsCurrent(identity, identityRevision) && sessionRevision === trading.sessionRevision && id === trading.sessionId;
  tradeSessionLoadPromise = (async () => {
    try {
      const data = await api(`trades/${encodeURIComponent(id)}`); if (!current()) return; if (revision !== tradeRevision) { tradeSessionRefreshQueued = true; return; }
      rememberTrade(data.trade); updateTradeSession(data.trade); if (accountRevision === authRevision) mergeTradingUser(data.user);
      message($('tradingSessionMessage'), ''); $('tradingSessionRetry').hidden = true;
    } catch (error) {
      if (!current()) return; if (error.status === 401) { setUser(null); return; } message($('tradingSessionMessage'), trading.session ? 'Refresh failed. Previous terms shown.' : error.message); $('tradingSessionRetry').hidden = false;
    }
  })().finally(() => { tradeSessionLoadPromise = null; renderTradingState(); if (tradeSessionRefreshQueued) { tradeSessionRefreshQueued = false; void loadTradeSession(); } });
  return tradeSessionLoadPromise;
}
async function actOnTrade(id, action, payload = {}) {
  if (!state.user || tradingBusy()) return; if (trading.actionRetry && (trading.actionRetry.id !== id || trading.actionRetry.action !== action)) return;
  const identity = state.user.accountId, identityRevision = userIdentityRevision, actionRouteRevision = routeRevision, actionSessionRevision = trading.sessionRevision; trading.action = { id, action }; tradeRevision++;
  message($('tradingActionMessage'), { join: 'Accepting request…', contribution: 'Saving your offer…', confirm: 'Confirming trade…', decline: 'Declining trade…', cancel: 'Cancelling trade…' }[action]); renderTradingState();
  try {
    const data = await api(`trades/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(payload) });
    if (!tradingIdentityIsCurrent(identity, identityRevision)) return; tradeRevision++; rememberTrade(data.trade); trading.actionRetry = null; updateTradeSession(data.trade, action === 'contribution'); mergeTradingUser(data.user);
    if (action === 'join' && trading.sessionId !== id && actionRouteRevision === routeRevision && actionSessionRevision === trading.sessionRevision) { trading.action = null; openTradeSession(id, data.trade); }
    const result = data.trade.status === 'accepted' ? 'Trade completed. Assets transferred.' : { join: 'Request accepted. Choose your offer.', contribution: 'Saved. Both confirmations reset.', confirm: 'Confirmed. Waiting for partner.', decline: 'Trade declined.', cancel: 'Trade cancelled.' }[action];
    message($('tradingActionMessage'), result, true); trading.confirmReviewVersion = null;
    if (data.trade.status === 'accepted') { leaderboardRevision++; void loadLeaderboard(true); }
  } catch (error) {
    if (!tradingIdentityIsCurrent(identity, identityRevision)) return; tradeRevision++; if (error.status === 401) { setUser(null); return; } mergeTradingUser(error.user);
    trading.actionRetry = !error.status || error.status >= 500 ? { id, action, payload: { ...payload, ...(payload.cardIds ? { cardIds: [...payload.cardIds] } : {}) }, identity } : null;
    if (error.status === 409) trading.confirmReviewVersion = null;
    message($('tradingActionMessage'), trading.actionRetry ? 'Result unknown. Retry safely.' : error.message);
  } finally { if (tradingIdentityIsCurrent(identity, identityRevision)) { trading.action = null; renderTradingState(); void loadTrades(true); void loadTradeSession(true); refreshTradeInventories(); } }
}
function handleTradeAction(event) {
  const button = event.target.closest('button[data-trade-action]'); if (!button || button.disabled || !state.user) return;
  const id = button.dataset.tradeId, action = button.dataset.tradeAction;
  if (action === 'open') { openTradeSession(id, trading.trades?.find(trade => trade.id === id)); return; }
  if (action === 'review-confirm') { if (trading.sessionDraft?.dirty || trading.sessionDraft?.error || tradeAutosave.inFlight) return; trading.confirmReviewVersion = trading.session?.version; renderTradeSession(); $('tradingConfirmFinal').focus({ preventScroll: true }); return; }
  if (['join', 'decline', 'cancel'].includes(action)) void actOnTrade(id, action);
}
$('tradingLists').addEventListener('click', handleTradeAction); $('tradingSessionActions').addEventListener('click', handleTradeAction);
$('tradingSessionTokens').addEventListener('input', () => { if (!trading.sessionDraft || trading.session?.status !== 'negotiating' || tradingBusy()) return; trading.sessionDraft.tokens = $('tradingSessionTokens').value; changeTradeDraft(); });
$('tradingContributionForm').addEventListener('submit', event => {
  event.preventDefault(); if (trading.sessionDraft?.dirty && !trading.sessionDraft.error) scheduleTradeAutosave(0);
});
$('tradingConfirmFinal').addEventListener('click', () => { const trade = trading.session; if (trade?.status === 'negotiating' && trading.confirmReviewVersion === trade.version && !trading.sessionDraft?.dirty && !trading.sessionDraft?.error && !tradeAutosave.inFlight) void actOnTrade(trade.id, 'confirm', { version: trade.version }); });
$('tradingConfirmBack').addEventListener('click', () => { trading.confirmReviewVersion = null; renderTradeSession(); });
$('tradingActionRetry').addEventListener('click', () => { const retry = trading.actionRetry; if (retry?.identity === state.user?.accountId) void actOnTrade(retry.id, retry.action, retry.payload); });
$('tradingSessionRetry').addEventListener('click', () => loadTradeSession(true));
['tradingRefresh', 'tradingRetry'].forEach(id => $(id).addEventListener('click', () => { void loadTrades(true); void loadTradeSession(true); refreshTradeInventories(); }));
$('tradingSessionInventoryRefresh').addEventListener('click', refreshTradeInventories);
for (const containerId of ['tradingSessionCards']) {
  const edit = (id, checked) => {
    if (tradingBusy() || trading.actionRetry || trading.session?.status !== 'negotiating' || !trading.sessionDraft) return;
    const cards = trading.sessionDraft.cards;
    if (checked) { const card = tradeInventories.offered.cards?.find(card => card.id === id); if (!card || cards.length >= 50 || cards.some(card => card.id === id)) return; cards.push(tradeCardSnapshot(card)); }
    else { const index = cards.findIndex(card => card.id === id); if (index >= 0) cards.splice(index, 1); }
    changeTradeDraft();
  };
  $(containerId).addEventListener('change', event => { const input = event.target.closest('input[data-card-id]'); if (input && !input.disabled) edit(input.dataset.cardId, input.checked); });
  $(containerId).addEventListener('click', event => { const button = event.target.closest('button[data-remove-card]'); if (button && !button.disabled) edit(button.dataset.cardId, false); });
}
function renderTradeChat() {
  const trade = trading.session; if (!trade || !acceptedTradeRequest(trade)) return;
  const outbox = trading.chatOutbox.filter(entry => entry.tradeId === trade.id && entry.identity === state.user?.accountId), signature = JSON.stringify([trading.chatMessages, outbox, trade.status, state.user?.username]);
  if (signature === trading.chatSignature) return; trading.chatSignature = signature;
  const container = $('tradingChatMessages'), follow = container.scrollHeight - container.scrollTop - container.clientHeight < 80 || !container.children.length;
  const receivedIds = new Set(trading.chatMessages.map(item => `${item.sender.accountId}:${item.clientMessageId}`)), entries = [...trading.chatMessages, ...outbox.filter(item => !receivedIds.has(`${item.sender.accountId}:${item.clientMessageId}`))];
  container.replaceChildren(...entries.map(entry => {
    const row = document.createElement('article'); row.className = 'trading-chat-row';
    const header = document.createElement('div'); header.className = 'trading-chat-meta'; header.append(profileAvatar(entry.sender, 'player-avatar chat-avatar'), tradeProfileLink(entry.sender), playerRoleBadges(entry.sender));
    const time = document.createElement('time'); time.dateTime = entry.createdAt; time.textContent = formatProfileDate(entry.createdAt, true); header.append(time);
    const body = document.createElement('p'); body.textContent = entry.body; row.append(header, body);
    if (entry.status) { const status = document.createElement('span'); status.className = 'trading-chat-send-status'; status.textContent = ['sending', 'waiting'].includes(entry.status) ? 'Sending…' : entry.error || 'Could not send.'; row.append(status); }
    if (entry.status === 'failed') { const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.textContent = trade.status === 'negotiating' ? 'Retry message' : 'Check message result'; retry.dataset.tradeChatRetry = entry.clientMessageId; row.append(retry); }
    return row;
  })); if (follow) container.scrollTop = container.scrollHeight;
}
function loadTradeChat(refresh = false) {
  const trade = trading.session; if (pageKind !== 'trading' || !state.user || !trade || !acceptedTradeRequest(trade)) return Promise.resolve();
  if (tradeChatLoadPromise) { if (refresh) tradeChatRefreshQueued = true; return tradeChatLoadPromise; }
  const identity = state.user.accountId, identityRevision = userIdentityRevision, sessionRevision = trading.sessionRevision, chatRevision = trading.chatRevision, id = trade.id;
  const current = () => tradingIdentityIsCurrent(identity, identityRevision) && sessionRevision === trading.sessionRevision && id === trading.sessionId;
  tradeChatLoadPromise = (async () => {
    try {
      const data = await api(`trades/${encodeURIComponent(id)}/messages`); if (!current()) return; if (chatRevision !== trading.chatRevision) { tradeChatRefreshQueued = true; return; }
      trading.chatMessages = data.messages; const known = new Set(data.messages.map(item => `${item.sender.accountId}:${item.clientMessageId}`)); trading.chatOutbox = trading.chatOutbox.filter(item => item.tradeId !== id || !known.has(`${item.sender.accountId}:${item.clientMessageId}`));
      message($('tradingChatMessage'), data.messages.length ? '' : 'No messages yet.'); $('tradingChatRetry').hidden = true; renderTradeChat();
    } catch (error) { if (!current()) return; if (error.status === 401) { setUser(null); return; } message($('tradingChatMessage'), 'Chat unavailable. Try again.'); $('tradingChatRetry').hidden = false; }
  })().finally(() => { tradeChatLoadPromise = null; if (tradeChatRefreshQueued) { tradeChatRefreshQueued = false; void loadTradeChat(); } }); return tradeChatLoadPromise;
}
async function sendTradeChatEntry(entry) {
  if (entry.identity !== state.user?.accountId || entry.status === 'sending' || tradeChatRetryTimers.has(entry.clientMessageId) || !trading.chatOutbox.includes(entry)) return;
  const trade = entry.tradeId === trading.sessionId ? trading.session : trading.trades?.find(item => item.id === entry.tradeId);
  if (trade && (!acceptedTradeRequest(trade) || (trade.status !== 'negotiating' && entry.status !== 'failed'))) {
    entry.status = 'failed'; entry.error = 'Chat closed.'; renderTradeChat(); return;
  }
  const identityRevision = userIdentityRevision; entry.status = 'sending'; entry.error = null; renderTradeSession();
  try {
    const data = await api(`trades/${encodeURIComponent(entry.tradeId)}/messages`, { method: 'POST', body: JSON.stringify({ body: entry.body, clientMessageId: entry.clientMessageId }) });
    if (!tradingIdentityIsCurrent(entry.identity, identityRevision)) return; trading.chatRevision++; trading.chatOutbox = trading.chatOutbox.filter(item => item !== entry);
    if (entry.tradeId === trading.sessionId) { trading.chatMessages = [...trading.chatMessages.filter(item => item.id !== data.message.id), data.message].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id.localeCompare(b.id)).slice(-100); message($('tradingChatMessage'), trading.session?.status === 'negotiating' ? '' : 'Message was sent.', true); }
  } catch (error) {
    if (!tradingIdentityIsCurrent(entry.identity, identityRevision)) return; if (error.status === 401) { setUser(null); return; }
    if (!trading.chatOutbox.includes(entry)) return;
    if (error.status === 429) { entry.status = 'waiting'; entry.error = null; queueTradeChatRetry(entry, error); }
    else { entry.status = 'failed'; entry.error = error.message; }
    if (error.status === 409) void loadTradeSession(true);
  } finally { if (tradingIdentityIsCurrent(entry.identity, identityRevision) && entry.tradeId === trading.sessionId) { renderTradeSession(); void loadTradeChat(true); } }
}
$('tradingChatForm').addEventListener('submit', event => {
  event.preventDefault(); const trade = trading.session, body = $('tradingChatInput').value.trim();
  if (!state.user || !trade || trade.status !== 'negotiating' || !body || trading.chatOutbox.some(entry => entry.tradeId === trade.id && ['sending', 'waiting'].includes(entry.status))) return;
  if (body.length > 1000) { message($('tradingChatMessage'), 'Use 1,000 characters or fewer.'); return; }
  const entry = { tradeId: trade.id, identity: state.user.accountId, clientMessageId: crypto.randomUUID(), sender: { username: state.user.username, accountId: state.user.accountId, avatarUrl: state.user.avatarUrl, role: accountRole(state.user), banned: !!state.user.banned }, body, createdAt: new Date().toISOString(), status: 'new' };
  trading.chatOutbox.push(entry); $('tradingChatInput').value = ''; message($('tradingChatMessage'), ''); void sendTradeChatEntry(entry);
});
$('tradingChatMessages').addEventListener('click', event => { const button = event.target.closest('button[data-trade-chat-retry]'); if (button) { const entry = trading.chatOutbox.find(item => item.clientMessageId === button.dataset.tradeChatRetry && item.tradeId === trading.sessionId); if (entry) void sendTradeChatEntry(entry); } });
$('tradingChatRetry').addEventListener('click', () => loadTradeChat(true));

async function loadProfile() {
  if (pageKind !== 'profile' || !viewingPublicProfile || !profileRoute) return;
  const revision = routeRevision;
  const loadRevision = ++profileLoadRevision;
  const usernamePath = profileRoute[1];
  state.profile = null;
  window.PepperModeration?.renderProfileControls();
  $('profileRetry').hidden = true;
  $('profileDetails').hidden = true;
  $('profileDescription').textContent = 'Loading profile…';
  try {
    const { profile } = await api(`profiles/${usernamePath}`);
    if (revision !== routeRevision || loadRevision !== profileLoadRevision) return;
    state.profile = profile;
    if (isOwnProfile(profile.username)) {
      navigateTo('/profile', { replace: true, focus: false, scroll: false });
      return;
    }
    document.title = `${profile.username} — Pepper TCG`;
    $('profileTitle').textContent = profile.username;
    $('profileDescription').textContent = '';
    renderProfileDetails(profile);
    renderClaim();
    $('profileDetails').hidden = false;
    $('profileTrade').href = `/trading?to=${encodeURIComponent(profile.username)}`;
    $('profileTrade').hidden = false;
  } catch (error) {
    if (revision !== routeRevision || loadRevision !== profileLoadRevision) return;
    document.title = 'Profile unavailable — Pepper TCG';
    $('profileTitle').textContent = 'Profile unavailable';
    $('profileDescription').textContent = error.message;
    $('profileRetry').hidden = false;
  }
}

function renderLeaderboard(data) {
  const signature = JSON.stringify([data.entries, data.totalPlayers, state.user?.accountId || null]);
  if (signature === state.leaderboardSignature) return;
  state.leaderboardSignature = signature;
  const focusedAccountId = document.activeElement?.closest('#leaderboardRows tr')?.dataset.accountId;
  const fragment = document.createDocumentFragment();
  for (const entry of data.entries) {
    const row = document.createElement('tr');
    row.dataset.accountId = entry.accountId;
    const own = !!state.user?.accountId && state.user.accountId === entry.accountId;
    row.classList.toggle('leaderboard-own-row', own);
    const rank = document.createElement('td');
    rank.textContent = entry.rank.toLocaleString();
    const player = document.createElement('td');
    const profile = document.createElement('a');
    profile.className = 'leaderboard-profile';
    profile.href = profileHref(entry.username);
    const name = document.createElement('span'); name.textContent = entry.username;
    profile.append(profileAvatar(entry, 'player-avatar', true), name, playerRoleBadges(entry));
    profile.setAttribute('aria-label', `View ${entry.username}'s profile`);
    player.append(profile);
    if (own) {
      const badge = document.createElement('span');
      badge.className = 'leaderboard-you';
      badge.textContent = 'You';
      player.append(badge);
    }
    const balance = document.createElement('td');
    balance.textContent = entry.balance.toLocaleString();
    row.append(rank, player, balance);
    fragment.append(row);
  }
  $('leaderboardRows').replaceChildren(fragment);
  if (focusedAccountId) {
    Array.from($('leaderboardRows').children).find(row => row.dataset.accountId === focusedAccountId)?.querySelector('a').focus({ preventScroll: true });
  }
  $('leaderboardSummary').textContent = `${data.entries.length.toLocaleString()} of ${data.totalPlayers.toLocaleString()} ${data.totalPlayers === 1 ? 'player' : 'players'}`;
}

function loadLeaderboard(refresh = false) {
  if (pageKind !== 'leaderboard' && !refresh) return Promise.resolve();
  if (leaderboardLoadPromise) {
    if (refresh) leaderboardRefreshQueued = true;
    return leaderboardLoadPromise;
  }
  const revision = leaderboardRevision;
  leaderboardLoadPromise = (async () => {
    try {
      const data = await api('leaderboard');
      if (revision !== leaderboardRevision) return;
      state.leaderboard = data;
      renderLeaderboard(data);
      message($('leaderboardMessage'), data.entries.length ? '' : 'No players yet.');
      $('leaderboardRetry').hidden = true;
    } catch {
      if (revision !== leaderboardRevision) return;
      message($('leaderboardMessage'), 'Leaderboard unavailable. Try again.');
      $('leaderboardRetry').hidden = false;
    }
  })().finally(() => {
    leaderboardLoadPromise = null;
    if (leaderboardRefreshQueued) {
      leaderboardRefreshQueued = false;
      void loadLeaderboard();
    }
  });
  return leaderboardLoadPromise;
}

function isOwnChatMessage(item) {
  return !!state.user && (item.accountId ? item.accountId === state.user.accountId : isOwnProfile(String(item.username || '').trim()));
}

function clearChatReply() {
  state.chatReply = null;
  $('chatReplyPreview').hidden = true;
  $('chatReplyAuthor').textContent = '';
  $('chatReplyText').textContent = '';
}

function chooseChatReply(messageId) {
  if (!state.user) return;
  const item = state.chatMessages.find(item => item.id === messageId);
  if (!item || item.deleted || isOwnChatMessage(item)) return;
  state.chatReply = { id: item.id, accountId: item.accountId, username: item.username, text: item.text, role: item.role, banned: item.banned };
  $('chatReplyAuthor').textContent = item.username;
  $('chatReplyAuthor').append(playerRoleBadges(item));
  $('chatReplyText').textContent = item.text;
  $('chatReplyPreview').hidden = false;
  message($('chatMessage'), '');
  $('chatInput').focus({ preventScroll: true });
}

$('cancelChatReply').addEventListener('click', () => { clearChatReply(); $('chatInput').focus({ preventScroll: true }); });

function jumpToChatMessage(messageId) {
  const container = $('chatMessages');
  const row = Array.from(container.children).find(row => row.dataset.messageId === messageId);
  if (!row) {
    message($('chatMessage'), 'Original message unavailable.');
    return;
  }
  state.chatFollowLatest = false;
  const top = container.scrollTop + row.getBoundingClientRect().top - container.getBoundingClientRect().top - (container.clientHeight - row.clientHeight) / 2;
  container.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  container.querySelectorAll('.is-reply-highlighted').forEach(item => item.classList.remove('is-reply-highlighted'));
  row.classList.add('is-reply-highlighted');
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
  window.clearTimeout(chatHighlightTimer);
  chatHighlightTimer = window.setTimeout(() => {
    Array.from(container.children).find(item => item.dataset.messageId === messageId)?.classList.remove('is-reply-highlighted');
  }, 2500);
}

$('chatMessages').addEventListener('click', event => {
  const reply = event.target.closest('button[data-reply-id]');
  const quote = event.target.closest('button[data-reply-jump]');
  const retry = event.target.closest('button[data-retry-client-id]');
  if (reply) chooseChatReply(reply.dataset.replyId);
  else if (quote) jumpToChatMessage(quote.dataset.replyJump);
  else if (retry) {
    const pending = state.chatOutbox.find(item => item.clientMessageId === retry.dataset.retryClientId);
    if (pending?.status === 'failed') void sendChatEntry(pending);
  }
});

function scrollChatToLatest() {
  const container = $('chatMessages');
  container.scrollTop = container.scrollHeight;
}

$('chatMessages').addEventListener('scroll', () => {
  const container = $('chatMessages');
  state.chatFollowLatest = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
}, { passive: true });

new ResizeObserver(() => {
  if (state.chatFollowLatest) scrollChatToLatest();
}).observe($('chatMessages'));

function createChatRow(item) {
  const row = document.createElement('div');
  row.className = 'chat-row';
  row.dataset.messageId = item.id;
  if (item.clientMessageId) row.dataset.clientMessageId = item.clientMessageId;
  row.dataset.signature = JSON.stringify(item);
  row.classList.toggle('is-pending', item.status === 'pending');
  row.classList.toggle('is-failed', item.status === 'failed');
  const head = document.createElement('div');
  head.className = 'chat-row-head';
  const author = document.createElement('a');
  author.className = 'chat-author';
  author.dataset.username = item.username;
  author.href = profileHref(item.username);
  author.textContent = item.username;
  author.setAttribute('aria-label', `View ${item.username}'s profile`);
  const time = document.createElement('time');
  time.dateTime = item.createdAt;
  time.textContent = new Date(item.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  const identity = document.createElement('span'); identity.className = 'chat-author-identity'; identity.append(author, playerRoleBadges(item));
  head.append(profileAvatar(item, 'player-avatar chat-avatar', true), identity, time);
  row.append(head);
  if (item.replyTo) {
    const quote = document.createElement(item.replyTo.available ? 'button' : 'div');
    quote.className = 'chat-reply-quote';
    if (item.replyTo.available) {
      quote.type = 'button';
      quote.dataset.replyJump = item.replyTo.id;
      quote.setAttribute('aria-label', `View ${item.replyTo.username}'s original message: ${item.replyTo.text}`);
    }
    const quoteAuthor = document.createElement('span');
    quoteAuthor.className = 'chat-reply-quote-author';
    quoteAuthor.textContent = `Reply to ${item.replyTo.username}`;
    quoteAuthor.append(playerRoleBadges(item.replyTo));
    const quoteText = document.createElement('span');
    quoteText.className = 'chat-reply-quote-text';
    quoteText.textContent = item.replyTo.text;
    quote.append(quoteAuthor, quoteText);
    if (!item.replyTo.available) {
      const unavailable = document.createElement('span');
      unavailable.className = 'chat-reply-unavailable';
      unavailable.textContent = 'Original message unavailable.';
      quote.append(unavailable);
    }
    row.append(quote);
  }
  const body = document.createElement('p');
  body.textContent = item.text;
  const reply = document.createElement('button');
  reply.type = 'button';
  reply.className = 'chat-reply-button';
  reply.dataset.replyId = item.id;
  reply.textContent = 'Reply';
  reply.hidden = !state.user || !!item.status || item.deleted || isOwnChatMessage(item);
  reply.setAttribute('aria-label', `Reply to ${item.username}: ${item.text}`);
  row.append(body, reply);
  const deletion = window.PepperModeration?.chatDeleteButton(item); if (deletion) row.append(deletion);
  if (item.status) {
    const status = document.createElement('span');
    status.className = 'chat-message-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = item.status === 'pending' ? 'Sending…' : item.error || 'Not sent. Try again.';
    row.append(status);
    if (item.status === 'failed') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'chat-retry-button';
      retry.dataset.retryClientId = item.clientMessageId;
      retry.textContent = 'Retry';
      retry.disabled = chatInFlight.has(item.clientMessageId);
      retry.setAttribute('aria-label', `Retry sending: ${item.text}`);
      row.append(retry);
    }
  }
  return row;
}

function renderChat(messages) {
  const canonical = messages.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).slice(-100);
  state.chatMessages = canonical;
  const savedClientIds = new Set(canonical.map(item => item.clientMessageId).filter(Boolean));
  state.chatOutbox = state.chatOutbox.filter(item => !savedClientIds.has(item.clientMessageId));
  // Accepted messages use server time; pending messages keep their local queue order.
  const latest = [...canonical, ...state.chatOutbox];
  const signature = JSON.stringify(latest);
  if (signature === state.chatSignature) return;
  const container = $('chatMessages');
  const focused = document.activeElement;
  const focusedRow = focused?.closest('.chat-row');
  const focusedMessageId = focusedRow && container.contains(focusedRow) ? focusedRow.dataset.messageId : null;
  const focusedSelector = focused?.classList.contains('chat-author') ? '.chat-author' : focused?.classList.contains('chat-reply-button') ? '.chat-reply-button' : focused?.classList.contains('chat-reply-quote') ? '.chat-reply-quote' : focused?.classList.contains('chat-retry-button') ? '.chat-retry-button' : null;
  const followLatest = state.chatSignature === null || state.chatFollowLatest;
  const retainedIds = new Set(latest.map(item => item.id));
  const top = container.getBoundingClientRect().top;
  const anchor = !followLatest && Array.from(container.children).find(row =>
    retainedIds.has(row.dataset.messageId) && row.getBoundingClientRect().bottom > top);
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const previousScrollTop = container.scrollTop;
  state.chatSignature = signature;
  state.chatFollowLatest = followLatest;
  if (!latest.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'No messages yet.';
    container.replaceChildren(empty);
    state.chatFollowLatest = true;
    return;
  }
  const existing = new Map(Array.from(container.children).filter(row => row.dataset.messageId).map(row => [row.dataset.messageId, row]));
  for (const child of Array.from(container.childNodes)) {
    if (!retainedIds.has(child.dataset?.messageId)) child.remove();
  }
  latest.forEach((item, index) => {
    let row = existing.get(item.id);
    if (!row || row.dataset.signature !== JSON.stringify(item)) {
      const updated = createChatRow(item);
      if (row) {
        updated.classList.toggle('is-reply-highlighted', row.classList.contains('is-reply-highlighted'));
        row.replaceWith(updated);
      }
      row = updated;
    }
    if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
  });
  if (focusedMessageId && !focused.isConnected) {
    const restored = Array.from(container.children).find(row => row.dataset.messageId === focusedMessageId);
    if (restored) {
      let target = (focusedSelector ? restored.querySelector(focusedSelector) : restored) || restored;
      if (target.hidden) target = restored.querySelector('.chat-author') || restored;
      if (!target.matches('a, button')) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    else {
      container.tabIndex = -1;
      container.focus({ preventScroll: true });
    }
  }
  if (followLatest) {
    scrollChatToLatest();
  } else {
    container.scrollTop = previousScrollTop;
    if (anchor) {
      const retainedAnchor = Array.from(container.children).find(row => row.dataset.messageId === anchor.dataset.messageId);
      if (retainedAnchor) container.scrollTop += retainedAnchor.getBoundingClientRect().top - top - anchorOffset;
    }
  }
  if (state.chatReply) {
    const target = latest.find(item => item.id === state.chatReply.id);
    if (target && (target.deleted || isOwnChatMessage(target))) {
      clearChatReply();
    } else if (target && (target.accountId !== state.chatReply.accountId || target.username !== state.chatReply.username || target.text !== state.chatReply.text)) {
      state.chatReply = { id: target.id, accountId: target.accountId, username: target.username, text: target.text, role: target.role, banned: target.banned };
      $('chatReplyAuthor').textContent = target.username;
      $('chatReplyAuthor').append(playerRoleBadges(target));
      $('chatReplyText').textContent = target.text;
    }
  }
}

async function loadChat(refresh = false) {
  if (chatLoadPromise) {
    await chatLoadPromise;
    if (refresh) return loadChat(true);
    return;
  }
  const revision = chatRevision;
  chatLoadPromise = (async () => {
    try {
      const data = await api('chat');
      if (revision !== chatRevision) return;
      renderChat(data.messages);
    } catch (error) {
      if (state.chatSignature === null) $('chatMessages').textContent = 'Chat unavailable. Try again.';
    }
  })();
  try { await chatLoadPromise; }
  finally { chatLoadPromise = null; }
}

function chatRetryDelay(error) {
  const delay = Number(error.retryAfterMs);
  return Math.max(100, Number.isFinite(delay) && delay > 0 ? delay : 3000) + 100;
}

function resetChatSending() {
  window.clearTimeout(chatRetryTimer); chatRetryTimer = undefined; chatRetryAt = 0; chatInFlight.clear();
  tradeChatRetryTimers.forEach(timer => window.clearTimeout(timer)); tradeChatRetryTimers.clear();
}

function scheduleChatSend() {
  window.clearTimeout(chatRetryTimer); chatRetryTimer = undefined;
  const identity = state.user?.accountId || state.user?.username;
  if (!identity || chatInFlight.size) return;
  const entry = state.chatOutbox.find(item => item.identity === identity && item.status === 'pending');
  if (!entry) return;
  chatRetryTimer = window.setTimeout(() => { chatRetryTimer = undefined; void sendChatEntry(entry); }, Math.max(0, chatRetryAt - Date.now()));
}

function queueTradeChatRetry(entry, error) {
  window.clearTimeout(tradeChatRetryTimers.get(entry.clientMessageId));
  const revision = userIdentityRevision;
  const timer = window.setTimeout(() => {
    tradeChatRetryTimers.delete(entry.clientMessageId);
    if (tradingIdentityIsCurrent(entry.identity, revision) && trading.chatOutbox.includes(entry)) void sendTradeChatEntry(entry);
  }, chatRetryDelay(error));
  tradeChatRetryTimers.set(entry.clientMessageId, timer);
}

async function sendChatEntry(entry) {
  const identity = state.user?.accountId || state.user?.username;
  if (chatInFlight.has(entry.clientMessageId) || !identity || identity !== entry.identity || !state.chatOutbox.includes(entry)) return;
  const sendingRevision = userIdentityRevision;
  const sendingIsCurrent = () => userIdentityRevision === sendingRevision && identity === (state.user?.accountId || state.user?.username);
  entry.status = 'pending'; entry.error = null;
  if (chatInFlight.size || Date.now() < chatRetryAt || state.chatOutbox.find(item => item.identity === identity && item.status === 'pending') !== entry) { renderChat(state.chatMessages); scheduleChatSend(); return; }
  chatInFlight.add(entry.clientMessageId);
  message($('chatMessage'), '');
  entry.status = 'pending';
  entry.error = null;
  state.chatFollowLatest = true;
  renderChat(state.chatMessages);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const data = await api('chat', { method: 'POST', signal: controller.signal, body: JSON.stringify({
      text: entry.text,
      clientMessageId: entry.clientMessageId,
      ...(entry.replyTo ? { replyToId: entry.replyTo.id } : {})
    }) });
    if (!sendingIsCurrent()) return;
    chatRevision++;
    state.chatOutbox = state.chatOutbox.filter(item => item.clientMessageId !== entry.clientMessageId);
    if (data.message) renderChat([...state.chatMessages.filter(item => item.id !== data.message.id), data.message]);
    else renderChat(state.chatMessages);
    void loadChat(true);
  } catch (error) {
    if (!sendingIsCurrent()) return;
    if (error.status === 401) {
      setUser(null);
      message($('chatMessage'), error.message);
    } else if (state.chatOutbox.includes(entry)) {
      if (error.status === 429) { chatRetryAt = Date.now() + chatRetryDelay(error); }
      else { entry.status = 'failed'; entry.error = error.name === 'AbortError' ? 'Sending timed out. Try again.' : error.message; }
      renderChat(state.chatMessages);
    }
  } finally {
    window.clearTimeout(timeout);
    chatInFlight.delete(entry.clientMessageId);
    scheduleChatSend();
    $('chatMessages').querySelectorAll('.chat-retry-button').forEach(button => {
      if (button.dataset.retryClientId === entry.clientMessageId) button.disabled = false;
    });
  }
}

$('chatForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!state.user) return;
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) {
    message($('chatMessage'), 'Write a message first.');
    input.focus();
    return;
  }
  const clientMessageId = crypto.randomUUID();
  const reply = state.chatReply;
  if (reply && isOwnChatMessage(reply)) {
    clearChatReply();
    message($('chatMessage'), 'Cannot reply to yourself.');
    return;
  }
  const entry = {
    id: `local:${clientMessageId}`,
    clientMessageId,
    accountId: state.user.accountId ?? null,
    username: state.user.username,
    avatarUrl: state.user.avatarUrl,
    role: accountRole(state.user), banned: !!state.user.banned,
    text,
    createdAt: new Date().toISOString(),
    replyTo: reply ? { ...reply, available: true } : null,
    identity: state.user.accountId || state.user.username,
    status: 'pending',
    error: null
  };
  state.chatOutbox.push(entry);
  input.value = '';
  clearChatReply();
  void sendChatEntry(entry);
});

renderRoute();
const initialAuthRevision = authRevision;
fetch('/api/me', { credentials: 'same-origin' })
  .then(response => response.json())
  .then(data => { if (authRevision === initialAuthRevision) { if (data.banned) handleBannedAccount(); else setUser(data.user); } })
  .catch(() => { if (authRevision === initialAuthRevision) setUser(null); });
setInterval(renderClaim, 1000);
loadChat();
setInterval(loadChat, 4000);
loadChangelog();
loadAnnouncements();
setInterval(() => { if (!document.hidden) { loadChangelog(); loadAnnouncements(); } }, 60000);
setInterval(() => { if (!document.hidden && pageKind === 'leaderboard') void loadLeaderboard(); }, 15000);
setInterval(() => { if (!document.hidden && state.user) { void loadTrades(); void window.PepperGames?.load(); if (pageKind === 'trading') refreshTradeInventories(); } }, 5000);
setInterval(() => { if (!document.hidden && pageKind === 'trading' && trading.sessionId) void loadTradeSession(); }, 1000);
setInterval(() => { if (!document.hidden && pageKind === 'trading' && trading.sessionId) void loadTradeChat(); }, 4000);
loadPresence();
setInterval(() => loadPresence(), 20000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    loadChangelog();
    loadAnnouncements();
    if (pageKind === 'leaderboard') void loadLeaderboard(true);
    if (state.user) { void loadTrades(true); void window.PepperGames?.load(); }
    if (pageKind === 'trading') { void loadTradeSession(true); void loadTradeChat(true); refreshTradeInventories(); }
    void loadPresence(true);
  }
});
window.addEventListener('online', () => { presenceRevision++; void loadPresence(true); if (state.user) void loadTrades(true); });
window.addEventListener('offline', () => { presenceRevision++; renderPresence(null); });
window.addEventListener('pagehide', () => { presenceSuspended = true; presenceRevision++; });
window.addEventListener('pageshow', () => { presenceSuspended = false; presenceRevision++; void loadPresence(true); });

// Pack animation test; it does not change accounts, tokens, or collections.
const packStage = $('packStage');
const revealCards = $('revealCards');
const openPackButton = $('openPack');
const demoPackButton = $('demoPack');
const replayPackButton = $('replayPack');
const packStatus = $('packStatus');
const reducePackMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let packTimers = [];

function packLater(callback, delay) {
  packTimers.push(window.setTimeout(callback, delay));
}

function resetPack() {
  packTimers.forEach(id => window.clearTimeout(id));
  packTimers = [];
  packStage.dataset.phase = 'sealed';
  revealCards.hidden = true;
  revealCards.replaceChildren();
  openPackButton.disabled = false;
  demoPackButton.disabled = false;
  replayPackButton.hidden = true;
  packStatus.textContent = 'Ready';
  demoPackButton.focus();
}

function openDemoPack() {
  if (packStage.dataset.phase !== 'sealed') return;
  packStage.dataset.phase = 'opening';
  openPackButton.disabled = true;
  demoPackButton.disabled = true;
  packStatus.textContent = 'Opening';

  packLater(() => {
    const cards = Array.from({ length: 5 }, (_, index) => {
      const card = document.createElement('div');
      card.className = 'reveal-card';
      card.setAttribute('role', 'img');
      card.setAttribute('aria-label', `Blank demo card ${index + 1}`);
      return card;
    });
    revealCards.replaceChildren(...cards);
    revealCards.hidden = false;
    packStage.dataset.phase = 'revealed';
    packStatus.textContent = '5 blank cards';
    replayPackButton.hidden = false;
    cards.forEach((card, index) => packLater(() => card.classList.add('is-dealt'), reducePackMotion.matches ? 0 : index * 110));
    packLater(() => { if (pageKind === 'home') replayPackButton.focus({ preventScroll: true }); }, reducePackMotion.matches ? 0 : 1000);
  }, reducePackMotion.matches ? 0 : 900);
}

openPackButton.addEventListener('click', openDemoPack);
demoPackButton.addEventListener('click', openDemoPack);
replayPackButton.addEventListener('click', resetPack);
