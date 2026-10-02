const $ = (id) => document.getElementById(id);
const routePath = location.pathname.replace(/\/+$/, '') || '/';
const profileRoute = routePath.match(/^\/profile\/([^/]+)$/);
const viewingPublicProfile = !!profileRoute;
const pageKind = routePath === '/profile' || viewingPublicProfile ? 'profile' : routePath === '/packs/test' ? 'pack' : routePath === '/settings' ? 'settings' : routePath === '/changelog' ? 'changelog' : 'home';
const navigationPath = { home: '/', profile: '/profile', pack: '/packs/test', settings: '/settings', changelog: '/changelog' }[pageKind];
const navigationSelector = pageKind === 'settings' ? '.account-dropdown' : '.main-nav';
document.querySelector(`${navigationSelector} a[href="${navigationPath}"]`)?.setAttribute('aria-current', 'page');
const state = { user: null, profile: null, authMode: 'signup', turnstileToken: null, turnstileWidgetId: null, turnstileLoading: false, turnstileFailed: false, turnstileGeneration: 0, claimSubmitting: false, accountSubmitting: false, changelogSubmitting: false, changelogVisitorPreview: false, changelogEntries: null, changelogSignature: null, chatSignature: null, chatFollowLatest: true };
let turnstileScriptPromise;
let chatLoadPromise;
let claimRewardAnimation;
let changelogLoadPromise;
let changelogRevision = 0;
let changelogLoadFailed = false;

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
  state.user = user;
  renderChangelogEditor();
  $('chatMessages').querySelectorAll('.chat-author').forEach(author => {
    author.href = profileHref(author.dataset.username);
  });
  if (viewingPublicProfile && state.profile && isOwnProfile(state.profile.username)) {
    location.replace('/profile');
    return;
  }
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
  document.body.classList.remove('auth-loading');
  if (state.chatFollowLatest) scrollChatToLatest();
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
  if (state.user) location.assign('/settings');
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
$('year').textContent = new Date().getFullYear();

if (pageKind === 'profile') {
  document.title = 'Profile — Pepper TCG';
  document.body.classList.add('profile-route');
  $('tokensTitle').textContent = 'Hourly claim';
  $('tokensIntro').textContent = 'Claim a random 10–20 tokens every hour.';
  $('home').hidden = true;
  $('profileIntro').hidden = false;
  $('cards').hidden = true;
  if (viewingPublicProfile) {
    document.body.classList.add('public-profile-route');
    $('profileDescription').textContent = 'Loading profile…';
    $('profileAccountTitle').textContent = 'About';
    $('tokens').hidden = true;
  }
} else if (pageKind === 'pack') {
  document.title = 'Pack opening test — Pepper TCG';
  document.body.classList.add('pack-route');
  $('home').hidden = true;
  $('tokens').hidden = true;
} else if (pageKind === 'settings') {
  document.title = 'Settings — Pepper TCG';
  document.body.classList.add('settings-route');
  $('home').hidden = true;
  $('tokens').hidden = true;
  $('cards').hidden = true;
  $('settingsPage').hidden = false;
} else if (pageKind === 'changelog') {
  document.title = 'Changelog — Pepper TCG';
  document.body.classList.add('changelog-route');
  $('home').hidden = true;
  $('tokens').hidden = true;
  $('cards').hidden = true;
  $('changelogPage').hidden = false;
} else {
  $('tokens').hidden = true;
  $('cards').hidden = true;
}

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
    else location.assign('/profile');
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
  const claimingUser = state.user;
  state.claimSubmitting = true;
  button.disabled = true;
  clearClaimReward();
  message($('claimMessage'), 'Claiming tokens…');
  try {
    const data = await api('claim', { method: 'POST', body: JSON.stringify({ turnstileToken: token }) });
    if (state.user !== claimingUser) return;
    setUser(data.user);
    message($('claimMessage'), 'Rolling your reward…', true);
    if (await revealClaimReward(data.awarded)) {
      message($('claimMessage'), `${data.awarded} tokens added to your balance.`, true);
    }
  } catch (error) {
    if (state.user !== claimingUser) return;
    if (error.user) setUser(error.user);
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
  try {
    const { user } = await api('account/username', { method: 'PATCH', body: JSON.stringify({
      username: $('newUsername').value,
      currentPassword: $('usernameCurrentPassword').value
    }) });
    setUser(user);
    $('chatMessages').querySelectorAll('.chat-author').forEach(author => {
      if (author.dataset.username.toLowerCase() !== previousUsername.toLowerCase()) return;
      author.dataset.username = user.username;
      author.textContent = user.username;
      author.href = '/profile';
      author.setAttribute('aria-label', `View ${user.username}'s profile`);
    });
    message($('usernameMessage'), 'Username updated.', true);
    void loadChat(true);
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
  state.profile = null;
  $('profileRetry').hidden = true;
  $('profileDetails').hidden = true;
  $('profileDescription').textContent = 'Loading profile…';
  try {
    const { profile } = await api(`profiles/${profileRoute[1]}`);
    state.profile = profile;
    if (isOwnProfile(profile.username)) {
      location.replace('/profile');
      return;
    }
    document.title = `${profile.username} — Pepper TCG`;
    $('profileTitle').textContent = profile.username;
    $('profileDescription').textContent = 'Account and tokens.';
    renderProfileDetails(profile);
    renderClaim();
    $('profileDetails').hidden = false;
  } catch (error) {
    document.title = 'Profile unavailable — Pepper TCG';
    $('profileTitle').textContent = 'Profile unavailable';
    $('profileDescription').textContent = error.message;
    $('profileRetry').hidden = false;
  }
}

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

function renderChat(messages) {
  const latest = messages.slice(-100);
  const signature = latest.map(item => `${item.id}:${item.username}`).join(',');
  if (signature === state.chatSignature) return;
  const container = $('chatMessages');
  const focusedAuthor = document.activeElement?.closest('.chat-author');
  const focusedMessageId = focusedAuthor && container.contains(focusedAuthor)
    ? focusedAuthor.closest('.chat-row').dataset.messageId : null;
  const followLatest = state.chatSignature === null || state.chatFollowLatest;
  const retainedIds = new Set(latest.map(item => item.id));
  const top = container.getBoundingClientRect().top;
  const anchor = !followLatest && Array.from(container.children).find(row =>
    retainedIds.has(row.dataset.messageId) && row.getBoundingClientRect().bottom > top);
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const previousScrollTop = container.scrollTop;
  state.chatSignature = signature;
  state.chatFollowLatest = followLatest;
  const fragment = document.createDocumentFragment();
  if (!latest.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'No messages yet.';
    container.replaceChildren(empty);
    state.chatFollowLatest = true;
    return;
  }
  for (const item of latest) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.dataset.messageId = item.id;
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
    const body = document.createElement('p');
    body.textContent = item.text;
    head.append(author, time);
    row.append(head, body);
    fragment.append(row);
  }
  container.replaceChildren(fragment);
  if (focusedMessageId) {
    const focusedRow = Array.from(container.children).find(row => row.dataset.messageId === focusedMessageId);
    focusedRow?.querySelector('.chat-author').focus({ preventScroll: true });
  }
  if (followLatest) {
    scrollChatToLatest();
  } else {
    container.scrollTop = previousScrollTop;
    if (anchor) {
      const retainedAnchor = Array.from(container.children).find(row => row.dataset.messageId === anchor.dataset.messageId);
      container.scrollTop += retainedAnchor.getBoundingClientRect().top - top - anchorOffset;
    }
  }
}

async function loadChat(refresh = false) {
  if (chatLoadPromise) {
    await chatLoadPromise;
    if (refresh) return loadChat(true);
    return;
  }
  chatLoadPromise = (async () => {
    try {
      const data = await api('chat');
      renderChat(data.messages);
    } catch (error) {
      if (state.chatSignature === null) $('chatMessages').textContent = 'Chat is unavailable right now. Please try again.';
    }
  })();
  try { await chatLoadPromise; }
  finally { chatLoadPromise = null; }
}

$('chatForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('chatInput');
  const button = $('chatForm').querySelector('button');
  button.disabled = true;
  message($('chatMessage'), '');
  try {
    await api('chat', { method: 'POST', body: JSON.stringify({ text: input.value }) });
    input.value = '';
    state.chatFollowLatest = true;
    scrollChatToLatest();
    await loadChat();
  } catch (error) {
    message($('chatMessage'), error.message);
  } finally { button.disabled = false; }
});

fetch('/api/me', { credentials: 'same-origin' })
  .then(response => response.json())
  .then(data => setUser(data.user))
  .catch(() => setUser(null));
setInterval(renderClaim, 1000);
if (viewingPublicProfile) loadProfile();
loadChat();
setInterval(loadChat, 4000);
loadChangelog();
setInterval(() => { if (!document.hidden) loadChangelog(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadChangelog(); });

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
