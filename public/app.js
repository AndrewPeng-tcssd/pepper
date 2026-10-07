const $ = (id) => document.getElementById(id);
let routePath = '';
let profileRoute = null;
let viewingPublicProfile = false;
let pageKind = 'home';
let routeRevision = 0;
let profileLoadRevision = 0;
let authRevision = 0;
let userIdentityRevision = 0;
const state = { user: null, profile: null, authMode: 'signup', turnstileToken: null, turnstileWidgetId: null, turnstileLoading: false, turnstileFailed: false, turnstileGeneration: 0, claimSubmitting: false, accountSubmitting: false, changelogSubmitting: false, changelogVisitorPreview: false, changelogEntries: null, changelogSignature: null, announcementSubmitting: false, announcementVisitorPreview: false, announcementEntries: null, announcementSignature: null, chatSignature: null, chatFollowLatest: true, chatMessages: [], chatOutbox: [], chatReply: null, leaderboard: null, leaderboardSignature: null };
const chatInFlight = new Set();
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
let leaderboardLoadPromise;
let leaderboardRefreshQueued = false;
let leaderboardRevision = 0;
let chatHighlightTimer;

async function api(path, options = {}) {
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
    throw error;
  }
  return data;
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

function renderProfileDetails(profile) {
  $('profileUsername').textContent = profile.username;
  $('profileAccountId').textContent = profile.accountId || 'Not available';
  $('profileJoined').textContent = profile.createdAt ? formatProfileDate(profile.createdAt) : 'Not available';
  $('profileBalance').textContent = profile.balance.toLocaleString();
  $('profileLastClaim').textContent = formatProfileDate(profile.lastClaimAt, true);
}

function setUser(user) {
  if (!user || (state.user && state.user.username !== user.username)) clearClaimReward();
  const previousPresenceIdentity = state.user?.accountId || state.user?.username || null;
  state.user = user;
  authRevision++;
  renderChangelogEditor();
  renderAnnouncementEditor();
  if (previousPresenceIdentity !== (user?.accountId || user?.username || null)) {
    userIdentityRevision++;
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
    $('profileDescription').textContent = user
      ? 'Your account and tokens.'
      : 'Sign up or log in to see your account and tokens.';
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
  if (user) {
    $('newUsername').value = user.username;
    $('menuUsername').textContent = user.username;
    $('menuBalance').textContent = user.balance.toLocaleString();
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
    message($('usernameMessage'), '');
    message($('passwordMessage'), '');
    ['accountName', 'accountId', 'accountEmail', 'accountJoined', 'accountLastClaim'].forEach(id => { $(id).textContent = ''; });
    if (!viewingPublicProfile) $('profileAccountId').textContent = '';
    $('accountBalance').textContent = '0';
    removeTurnstile();
    $('claimTitle').textContent = 'Sign in to claim';
    $('claimDescription').textContent = 'Sign up or log in to claim a random 10–20 tokens each hour.';
    message($('claimMessage'), '');
  }
  renderClaim();
  $('chatMessages').querySelectorAll('.chat-reply-button').forEach(button => { button.hidden = !user || button.closest('.chat-row').matches('.is-pending, .is-failed'); });
  if (state.leaderboard) renderLeaderboard(state.leaderboard);
  document.body.classList.remove('auth-loading');
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

function renderClaim() {
  const profile = viewingPublicProfile ? state.profile : state.user;
  if (!profile || pageKind !== 'profile') return;
  const remaining = profile.nextClaimAt ? profile.nextClaimAt - Date.now() : 0;
  const ready = remaining <= 0;
  $('profileNextClaim').textContent = ready ? 'Ready now' : formatTime(remaining);
  if (viewingPublicProfile) return;
  $('claimReady').hidden = !ready;
  $('claimCooldown').hidden = ready;
  $('claimTitle').textContent = ready ? 'Ready to claim' : 'Next claim';
  $('claimDescription').textContent = ready
    ? 'Complete the check below, then claim a random 10–20 tokens.'
    : 'You can claim again when the timer ends.';
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
  if (!state.user || pageKind !== 'profile' || viewingPublicProfile || state.turnstileLoading || state.turnstileWidgetId !== null) return;
  state.turnstileLoading = true;
  const generation = ++state.turnstileGeneration;
  try {
    const config = await api('turnstile-config');
    if (!config.siteKey) throw new Error('Cloudflare verification is not configured yet.');
    await loadTurnstileScript();
    if (generation !== state.turnstileGeneration || !state.user) return;
    state.turnstileWidgetId = window.turnstile.render('#turnstileWidget', {
      sitekey: config.siteKey,
      action: 'claim_tokens',
      size: window.matchMedia('(max-width: 450px)').matches ? 'compact' : 'normal',
      callback: token => { if (generation === state.turnstileGeneration) { setClaimToken(token); message($('claimMessage'), ''); } },
      'expired-callback': () => { if (generation === state.turnstileGeneration) setClaimToken(null); },
      'error-callback': () => { if (generation === state.turnstileGeneration) { setClaimToken(null); message($('claimMessage'), 'Verification could not finish. Reset it and try again.'); } }
    });
    message($('claimMessage'), '');
    window.setTimeout(() => {
      if (generation === state.turnstileGeneration && !state.turnstileToken && !$('turnstileWidget').querySelector('iframe')) {
        message($('claimMessage'), 'Cloudflare verification could not load. Reset verification and try again.');
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
  $('authHint').hidden = signup;
  $('authHint').textContent = signup
    ? ''
    : 'no more email signup for u sry';
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

['accountButton', 'claimJoin', 'chatJoin', 'settingsJoin'].forEach(id => $(id).addEventListener('click', openAccount));
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
  return ['/', '/profile', '/packs/test', '/settings', '/changelog', '/announcements', '/leaderboard'].includes(path) || /^\/profile\/[^/]+$/.test(path);
}

function renderRoute() {
  routeRevision++;
  profileLoadRevision++;
  routePath = location.pathname.replace(/\/+$/, '') || '/';
  profileRoute = routePath.match(/^\/profile\/([^/]+)$/);
  viewingPublicProfile = !!profileRoute;
  pageKind = routePath === '/profile' || viewingPublicProfile ? 'profile' : routePath === '/packs/test' ? 'pack' : routePath === '/settings' ? 'settings' : routePath === '/changelog' ? 'changelog' : routePath === '/announcements' ? 'announcements' : routePath === '/leaderboard' ? 'leaderboard' : 'home';
  if (viewingPublicProfile && isOwnProfile(routeProfileUsername())) {
    navigateTo('/profile', { replace: true, focus: false, scroll: false });
    return;
  }
  const navigationPath = { home: '/', profile: '/profile', pack: '/packs/test', settings: '/settings', changelog: '/changelog', announcements: '/announcements', leaderboard: '/leaderboard' }[pageKind];
  document.querySelectorAll('.main-nav a[aria-current], .account-dropdown a[aria-current]').forEach(link => link.removeAttribute('aria-current'));
  const navigationSelector = pageKind === 'settings' ? '.account-dropdown' : '.main-nav';
  document.querySelector(`${navigationSelector} a[href="${navigationPath}"]`)?.setAttribute('aria-current', 'page');
  document.body.classList.remove('profile-route', 'public-profile-route', 'pack-route', 'settings-route', 'changelog-route', 'announcements-route', 'leaderboard-route');
  if (pageKind !== 'home') document.body.classList.add(`${pageKind}-route`);
  document.body.classList.toggle('public-profile-route', viewingPublicProfile);
  ['home', 'profileIntro', 'tokens', 'cards', 'settingsPage', 'changelogPage', 'announcementsPage', 'leaderboardPage'].forEach(id => { $(id).hidden = true; });
  const sectionId = { home: 'home', profile: 'profileIntro', pack: 'cards', settings: 'settingsPage', changelog: 'changelogPage', announcements: 'announcementsPage', leaderboard: 'leaderboardPage' }[pageKind];
  $(sectionId).hidden = false;
  document.title = { home: 'Pepper TCG — Development', profile: 'Profile — Pepper TCG', pack: 'Pack opening test — Pepper TCG', settings: 'Settings — Pepper TCG', changelog: 'Changelog — Pepper TCG', announcements: 'Announcements — Pepper TCG', leaderboard: 'Leaderboard — Pepper TCG' }[pageKind];
  state.profile = null;
  $('profileRetry').hidden = true;
  $('profileTitle').textContent = 'Profile';
  $('profileAccountTitle').textContent = viewingPublicProfile ? 'About' : 'Account';
  if (pageKind === 'profile') {
    $('tokensTitle').textContent = 'Hourly claim';
    $('tokensIntro').textContent = 'Claim a random 10–20 tokens every hour.';
    if (viewingPublicProfile) {
      removeTurnstile();
      void loadProfile();
    } else {
      $('tokens').hidden = false;
      $('profileDescription').textContent = state.user ? 'Your account and tokens.' : 'Sign up or log in to see your account and tokens.';
      $('profileDetails').hidden = !state.user;
      if (state.user) renderProfileDetails(state.user);
      renderClaim();
    }
  } else removeTurnstile();
  if (pageKind === 'changelog') void loadChangelog(true);
  if (pageKind === 'announcements') void loadAnnouncements(true);
  if (pageKind === 'leaderboard') void loadLeaderboard(true);
}

function focusRouteHeading() {
  if ($('chat').classList.contains('open')) return;
  const headingId = { home: 'overviewTitle', profile: 'profileTitle', pack: 'cardsTitle', settings: 'settingsTitle', changelog: 'changelogTitleHeading', announcements: 'announcementsTitle', leaderboard: 'leaderboardTitle' }[pageKind];
  $(headingId).tabIndex = -1;
  $(headingId).focus({ preventScroll: true });
}

function navigateTo(href, { replace = false, focus = true, scroll = true } = {}) {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin || !isAppPath(url.pathname)) return false;
  const target = `${url.pathname}${url.search}${url.hash}`;
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (target !== current) {
    history.replaceState({ ...history.state, pepperScroll: [window.scrollX, window.scrollY] }, '', current);
    history[replace ? 'replaceState' : 'pushState']({ pepperScroll: [0, 0] }, '', target);
    renderRoute();
  }
  $('accountMenu').open = false;
  if (scroll) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
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
      message($('authMessage'), data.message, true);
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
    else if (pageKind !== 'leaderboard') navigateTo('/profile');
  } catch (error) {
    message($('authMessage'), error.message);
  } finally { button.disabled = false; }
});

$('claimForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.claimSubmitting || state.accountSubmitting || !state.user) return;
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
      message($('claimMessage'), `${data.awarded} tokens added to your balance.`, true);
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

function setAccountSubmitting(submitting) {
  state.accountSubmitting = submitting;
  ['usernameSubmit', 'passwordSubmit', 'logoutButton', 'headerLogoutButton'].forEach(id => {
    $(id).disabled = submitting;
  });
}

function renderChangelogEditor() {
  const canManage = state.user?.canManageChangelog === true;
  if (!canManage) state.changelogVisitorPreview = false;
  const showControls = canManage && !state.changelogVisitorPreview;
  $('changelogTools').hidden = !canManage;
  $('changelogPreviewNotice').hidden = !state.changelogVisitorPreview;
  $('changelogPreviewToggle').textContent = state.changelogVisitorPreview ? 'Back to editing' : 'View as visitor';
  $('changelogPreviewToggle').setAttribute('aria-pressed', String(state.changelogVisitorPreview));
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

$('changelogPreviewToggle').addEventListener('click', () => {
  if (!state.user?.canManageChangelog || state.changelogSubmitting || state.accountSubmitting) return;
  state.changelogVisitorPreview = !state.changelogVisitorPreview;
  renderChangelogEditor();
});

function changelogActionButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button';
  button.dataset.changelogAction = action;
  button.textContent = label;
  button.disabled = state.changelogSubmitting;
  return button;
}

function renderChangelog(entries, latestVersion) {
  $('siteVersion').textContent = latestVersion;
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
    meta.append(version, date);
    article.append(meta, title, description, actions);
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
        message($('changelogMessage'), 'The changelog could not load. Please try again.');
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
  $('changelogPreviewToggle').disabled = submitting;
  $('changelogEntries').querySelectorAll('.changelog-entry-actions button').forEach(button => { button.disabled = submitting; });
}

function changelogPermissionError(error) {
  if (error.status !== 401 && error.status !== 403) return false;
  if (error.status === 401) setUser(null);
  else { state.user.canManageChangelog = false; renderChangelogEditor(); }
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
  if (!button || !state.user?.canManageChangelog || state.changelogVisitorPreview || state.changelogSubmitting || state.accountSubmitting) return;
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
  if (!state.user?.canManageChangelog || state.changelogVisitorPreview || state.changelogSubmitting || state.accountSubmitting) return;
  setChangelogSubmitting(true);
  let deleted = false;
  try {
    const data = await api(`changelog/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
    changelogRevision++;
    state.changelogEntries = data.entries;
    renderChangelog(data.entries, data.latestVersion);
    message($('changelogMessage'), 'Entry deleted. The site version is updated.', true);
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
      (nextDelete || $('changelogPreviewToggle')).focus();
    }
  }
}

$('changelogForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.changelogSubmitting || state.accountSubmitting || state.changelogVisitorPreview || !state.user?.canManageChangelog) return;
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
    message($('changelogFormMessage'), 'Changelog entry added. The site version is updated.', true);
    void loadChangelog(true);
  } catch (error) {
    if (!changelogPermissionError(error)) message($('changelogFormMessage'), error.message);
  } finally {
    setChangelogSubmitting(false);
  }
});

function renderAnnouncementEditor() {
  const canManage = state.user?.canManageAnnouncements === true;
  if (!canManage) state.announcementVisitorPreview = false;
  const showControls = canManage && !state.announcementVisitorPreview;
  $('announcementTools').hidden = !canManage;
  $('announcementPreviewNotice').hidden = !state.announcementVisitorPreview;
  $('announcementPreviewToggle').textContent = state.announcementVisitorPreview ? 'Back to editing' : 'View as visitor';
  $('announcementPreviewToggle').setAttribute('aria-pressed', String(state.announcementVisitorPreview));
  $('announcementEditor').hidden = !showControls;
  $('announcementEntries').querySelectorAll('.changelog-entry-actions').forEach(actions => {
    actions.hidden = !showControls;
    if (!showControls) {
      actions.querySelector('.changelog-delete-confirm').hidden = true;
      actions.querySelector('.changelog-delete-button').hidden = false;
    }
  });
  if (!canManage) {
    $('announcementForm').reset();
    message($('announcementFormMessage'), '');
  }
}

$('announcementPreviewToggle').addEventListener('click', () => {
  if (!state.user?.canManageAnnouncements || state.announcementSubmitting || state.accountSubmitting) return;
  state.announcementVisitorPreview = !state.announcementVisitorPreview;
  renderAnnouncementEditor();
});

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
  const signature = JSON.stringify(entries);
  if (signature === state.announcementSignature) {
    renderAnnouncementEditor();
    $('announcementRetry').hidden = true;
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
    meta.append(date);
    article.append(meta, title, description, actions);
    fragment.append(article);
  }
  $('announcementEntries').replaceChildren(fragment);
  renderAnnouncementEditor();
  announcementLoadFailed = false;
  message($('announcementMessage'), entries.length ? '' : 'No announcements yet.');
  $('announcementRetry').hidden = true;
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
      message($('announcementMessage'), 'Announcements could not load. Please try again.');
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
  $('announcementPreviewToggle').disabled = submitting;
  $('announcementEntries').querySelectorAll('.changelog-entry-actions button').forEach(button => { button.disabled = submitting; });
}

function focusAnnouncementMessage() {
  $('announcementMessage').tabIndex = -1;
  $('announcementMessage').focus();
}

function announcementPermissionError(error) {
  if (error.status !== 401 && error.status !== 403) return false;
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
  if (!button || !state.user?.canManageAnnouncements || state.announcementVisitorPreview || state.announcementSubmitting || state.accountSubmitting) return;
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
  if (!state.user?.canManageAnnouncements || state.announcementVisitorPreview || state.announcementSubmitting || state.accountSubmitting) return;
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
      (nextDelete || $('announcementPreviewToggle')).focus();
    }
  }
}

$('announcementForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.announcementSubmitting || state.accountSubmitting || state.announcementVisitorPreview || !state.user?.canManageAnnouncements) return;
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

function renderPresence(count) {
  const available = Number.isSafeInteger(count) && count >= 0;
  const text = available ? `${count.toLocaleString()} ${count === 1 ? 'player' : 'players'} online` : 'Player count unavailable';
  if ($('playerCount').textContent !== text) $('playerCount').textContent = text;
  $('playerCount').dataset.status = available ? 'live' : 'unavailable';
  const mobileText = available ? `${count.toLocaleString()} online` : 'count unavailable';
  if ($('mobilePlayerCount').textContent !== mobileText) $('mobilePlayerCount').textContent = mobileText;
}

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
      renderPresence(data.count);
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
    message($('passwordMessage'), 'The new passwords do not match.');
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
    message($('passwordMessage'), 'Password updated. Other devices have been signed out.', true);
  } catch (error) {
    settingsError($('passwordMessage'), error);
  } finally {
    $('passwordCurrentPassword').value = '';
    setAccountSubmitting(false);
  }
});

async function loadProfile() {
  if (pageKind !== 'profile' || !viewingPublicProfile || !profileRoute) return;
  const revision = routeRevision;
  const loadRevision = ++profileLoadRevision;
  const usernamePath = profileRoute[1];
  state.profile = null;
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
    $('profileDescription').textContent = 'Account and tokens.';
    renderProfileDetails(profile);
    renderClaim();
    $('profileDetails').hidden = false;
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
    profile.textContent = entry.username;
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
  $('leaderboardSummary').textContent = `Showing ${data.entries.length.toLocaleString()} of ${data.totalPlayers.toLocaleString()} ${data.totalPlayers === 1 ? 'player' : 'players'}. Updates every 15 seconds.`;
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
      message($('leaderboardMessage'), 'The leaderboard could not load. Please try again.');
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

function clearChatReply() {
  state.chatReply = null;
  $('chatReplyPreview').hidden = true;
  $('chatReplyAuthor').textContent = '';
  $('chatReplyText').textContent = '';
}

function chooseChatReply(messageId) {
  if (!state.user) return;
  const item = state.chatMessages.find(item => item.id === messageId);
  if (!item) return;
  state.chatReply = { id: item.id, username: item.username, text: item.text };
  $('chatReplyAuthor').textContent = item.username;
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
    message($('chatMessage'), 'The original message is no longer in recent chat.');
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
  head.append(author, time);
  row.append(head);
  if (item.replyTo) {
    const quote = document.createElement(item.replyTo.available ? 'button' : 'div');
    quote.className = 'chat-reply-quote';
    if (item.replyTo.available) {
      quote.type = 'button';
      quote.dataset.replyJump = item.replyTo.id;
      quote.setAttribute('aria-label', `View original message from ${item.replyTo.username}: ${item.replyTo.text}`);
    }
    const quoteAuthor = document.createElement('span');
    quoteAuthor.className = 'chat-reply-quote-author';
    quoteAuthor.textContent = `Reply to ${item.replyTo.username}`;
    const quoteText = document.createElement('span');
    quoteText.className = 'chat-reply-quote-text';
    quoteText.textContent = item.replyTo.text;
    quote.append(quoteAuthor, quoteText);
    if (!item.replyTo.available) {
      const unavailable = document.createElement('span');
      unavailable.className = 'chat-reply-unavailable';
      unavailable.textContent = 'Original message is no longer available.';
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
  reply.hidden = !state.user || !!item.status;
  reply.setAttribute('aria-label', `Reply to ${item.username}: ${item.text}`);
  row.append(body, reply);
  if (item.status) {
    const status = document.createElement('span');
    status.className = 'chat-message-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = item.status === 'pending' ? 'Sending…' : `Not sent. ${item.error || 'Please try again.'}`;
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
  const canonical = messages.slice(-100);
  state.chatMessages = canonical;
  const savedClientIds = new Set(canonical.map(item => item.clientMessageId).filter(Boolean));
  state.chatOutbox = state.chatOutbox.filter(item => !savedClientIds.has(item.clientMessageId));
  const latest = [...canonical, ...state.chatOutbox].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
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
      const target = (focusedSelector ? restored.querySelector(focusedSelector) : restored) || restored;
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
    if (target && (target.username !== state.chatReply.username || target.text !== state.chatReply.text)) {
      state.chatReply = { id: target.id, username: target.username, text: target.text };
      $('chatReplyAuthor').textContent = target.username;
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
      if (state.chatSignature === null) $('chatMessages').textContent = 'Chat is unavailable right now. Please try again.';
    }
  })();
  try { await chatLoadPromise; }
  finally { chatLoadPromise = null; }
}

async function sendChatEntry(entry) {
  const identity = state.user?.accountId || state.user?.username;
  if (chatInFlight.has(entry.clientMessageId) || !identity || identity !== entry.identity || !state.chatOutbox.includes(entry)) return;
  const sendingRevision = userIdentityRevision;
  const sendingIsCurrent = () => userIdentityRevision === sendingRevision && identity === (state.user?.accountId || state.user?.username);
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
      entry.status = 'failed';
      entry.error = error.name === 'AbortError' ? 'Sending timed out. Try again.' : error.message;
      renderChat(state.chatMessages);
    }
  } finally {
    window.clearTimeout(timeout);
    chatInFlight.delete(entry.clientMessageId);
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
  const entry = {
    id: `local:${clientMessageId}`,
    clientMessageId,
    username: state.user.username,
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
  .then(data => { if (authRevision === initialAuthRevision) setUser(data.user); })
  .catch(() => { if (authRevision === initialAuthRevision) setUser(null); });
setInterval(renderClaim, 1000);
loadChat();
setInterval(loadChat, 4000);
loadChangelog();
loadAnnouncements();
setInterval(() => { if (!document.hidden) { loadChangelog(); loadAnnouncements(); } }, 60000);
setInterval(() => { if (!document.hidden && pageKind === 'leaderboard') void loadLeaderboard(); }, 15000);
loadPresence();
setInterval(() => loadPresence(), 20000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    loadChangelog();
    loadAnnouncements();
    if (pageKind === 'leaderboard') void loadLeaderboard(true);
    void loadPresence(true);
  }
});
window.addEventListener('online', () => { presenceRevision++; void loadPresence(true); });
window.addEventListener('offline', () => { presenceRevision++; renderPresence(null); });
window.addEventListener('pagehide', () => { presenceSuspended = true; presenceRevision++; });
window.addEventListener('pageshow', () => { presenceSuspended = false; presenceRevision++; void loadPresence(true); });

// Pack animation test; it does not change accounts, tokens, or collections.
const packStage = $('packStage');
const revealCards = $('revealCards');
const openPackButton = $('openPack');
const demoPackButton = $('demoPack');
const replayPackButton = $('replayPack');
const packHelp = $('packHelp');
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
  packHelp.textContent = 'Open the pack below, or use the button.';
  packStatus.textContent = 'Ready';
  demoPackButton.focus();
}

function openDemoPack() {
  if (packStage.dataset.phase !== 'sealed') return;
  packStage.dataset.phase = 'opening';
  openPackButton.disabled = true;
  demoPackButton.disabled = true;
  packHelp.textContent = 'Opening…';
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
    packHelp.textContent = 'Press Reset to open it again.';
    replayPackButton.hidden = false;
    cards.forEach((card, index) => packLater(() => card.classList.add('is-dealt'), reducePackMotion.matches ? 0 : index * 110));
    packLater(() => replayPackButton.focus(), reducePackMotion.matches ? 0 : 1000);
  }, reducePackMotion.matches ? 0 : 900);
}

openPackButton.addEventListener('click', openDemoPack);
demoPackButton.addEventListener('click', openDemoPack);
replayPackButton.addEventListener('click', resetPack);
