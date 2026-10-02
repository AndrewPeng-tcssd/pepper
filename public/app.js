const $ = (id) => document.getElementById(id);
const routePath = location.pathname.replace(/\/+$/, '') || '/';
const pageKind = routePath === '/profile' ? 'profile' : routePath === '/packs/test' ? 'pack' : 'home';
document.querySelector(`.main-nav a[href="${pageKind === 'pack' ? '/packs/test' : pageKind === 'profile' ? '/profile' : '/'}"]`)?.setAttribute('aria-current', 'page');
const state = { user: null, authMode: 'signup', turnstileToken: null, turnstileWidgetId: null, turnstileLoading: false, turnstileFailed: false, turnstileGeneration: 0, claimSubmitting: false, chatLoading: false, chatSignature: null };
let turnstileScriptPromise;

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong.');
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

function setUser(user) {
  state.user = user;
  $('profileDescription').textContent = user
    ? 'Your account and tokens.'
    : 'Sign up or log in to see your account and tokens.';
  $('profileDetails').hidden = !user;
  $('accountButton').hidden = !!user;
  $('accountMenu').hidden = !user;
  if (!user) $('accountMenu').open = false;
  $('loggedOutClaim').hidden = !!user;
  $('loggedInClaim').hidden = !user;
  $('chatLoggedOut').hidden = !!user;
  $('chatLoggedIn').hidden = !user;
  if (user) {
    $('profileUsername').textContent = user.username;
    $('profileJoined').textContent = user.createdAt ? formatProfileDate(user.createdAt) : 'Not available';
    $('profileBalance').textContent = user.balance.toLocaleString();
    $('profileLastClaim').textContent = formatProfileDate(user.lastClaimAt, true);
    $('profileNextClaim').textContent = user.nextClaimAt ? formatProfileDate(user.nextClaimAt, true) : 'Ready now';
    $('menuUsername').textContent = user.username;
    $('menuBalance').textContent = user.balance.toLocaleString();
    $('panelBalance').textContent = user.balance.toLocaleString();
    $('accountBalance').textContent = user.balance.toLocaleString();
    $('accountName').textContent = user.username;
    $('accountEmailLabel').hidden = !user.email;
    $('accountEmail').hidden = !user.email;
    $('accountEmail').textContent = user.email || '';
    $('accountJoined').textContent = user.createdAt ? formatProfileDate(user.createdAt) : 'Not available';
    $('accountLastClaim').textContent = formatProfileDate(user.lastClaimAt, true);
    $('chatUsername').textContent = user.username;
  } else {
    removeTurnstile();
    $('claimTitle').textContent = 'Sign in to claim';
    $('claimDescription').textContent = 'Sign up or log in to claim 5 tokens each hour.';
    message($('claimMessage'), '');
  }
  renderClaim();
  document.body.classList.remove('auth-loading');
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderClaim() {
  if (!state.user || pageKind !== 'profile') return;
  const remaining = state.user.nextClaimAt ? state.user.nextClaimAt - Date.now() : 0;
  const ready = remaining <= 0;
  $('profileNextClaim').textContent = ready ? 'Ready now' : formatTime(remaining);
  $('claimReady').hidden = !ready;
  $('claimCooldown').hidden = ready;
  $('claimTitle').textContent = ready ? 'Ready to claim' : 'Next claim';
  $('claimDescription').textContent = ready
    ? 'Complete the check below, then claim 5 tokens.'
    : 'You can claim again when the timer ends.';
  if (ready && state.turnstileWidgetId === null && !state.turnstileLoading && !state.turnstileFailed) loadTurnstile();
  if (!ready) { removeTurnstile(); $('cooldownClock').textContent = formatTime(remaining); }
}

function setClaimToken(token) {
  state.turnstileToken = token || null;
  $('claimForm').querySelector('button').disabled = !state.turnstileToken || state.claimSubmitting;
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
  if (!state.user || pageKind !== 'profile' || state.turnstileLoading || state.turnstileWidgetId !== null) return;
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
    : 'Older accounts can still use email sign-in. That sends a verification link.';
  message($('authMessage'), '');
}

function openAccount() {
  setChatOpen(false);
  if (state.user) $('accountDialog').showModal();
  else { setAuthMode('signup'); $('authDialog').showModal(); }
}

function setChatOpen(open) {
  $('chat').classList.toggle('open', open);
  $('chat').inert = !open && window.matchMedia('(max-width: 850px)').matches;
  $('chatOverlay').hidden = !open;
  $('chatToggle').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('chat-open', open);
  if (open) $('chatClose').focus();
  else if (document.activeElement === $('chatClose')) $('chatToggle').focus();
}

$('chatToggle').addEventListener('click', () => setChatOpen(!$('chat').classList.contains('open')));
$('chatClose').addEventListener('click', () => setChatOpen(false));
$('chatOverlay').addEventListener('click', () => setChatOpen(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && $('chat').classList.contains('open')) setChatOpen(false); });
window.matchMedia('(min-width: 851px)').addEventListener('change', () => setChatOpen(false));
setChatOpen(false);

['accountButton', 'claimJoin', 'chatJoin'].forEach(id => $(id).addEventListener('click', openAccount));
$('accountDetailsButton').addEventListener('click', () => {
  $('accountMenu').open = false;
  openAccount();
});
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
$('closeAccount').addEventListener('click', () => $('accountDialog').close());
$('signupTab').addEventListener('click', () => setAuthMode('signup'));
$('loginTab').addEventListener('click', () => setAuthMode('login'));
$('resetTurnstile').addEventListener('click', () => { message($('claimMessage'), ''); resetTurnstile(); });
$('goToTokens').addEventListener('click', () => $('accountDialog').close());
$('year').textContent = new Date().getFullYear();

if (pageKind === 'profile') {
  document.title = 'Profile — Pepper TCG';
  document.body.classList.add('profile-route');
  $('tokensTitle').textContent = 'Hourly claim';
  $('tokensIntro').textContent = 'You can claim 5 tokens every hour.';
  $('home').hidden = true;
  $('profileIntro').hidden = false;
  $('cards').hidden = true;
} else if (pageKind === 'pack') {
  document.title = 'Pack opening test — Pepper TCG';
  document.body.classList.add('pack-route');
  $('home').hidden = true;
  $('tokens').hidden = true;
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
    if (pageKind === 'profile') $('tokens').scrollIntoView({ behavior: 'smooth' });
    else location.assign('/profile');
  } catch (error) {
    message($('authMessage'), error.message);
  } finally { button.disabled = false; }
});

$('claimForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.turnstileToken) { message($('claimMessage'), 'Complete Cloudflare verification first.'); return; }
  const button = $('claimForm').querySelector('button');
  const token = state.turnstileToken;
  state.claimSubmitting = true;
  button.disabled = true;
  try {
    const data = await api('claim', { method: 'POST', body: JSON.stringify({ turnstileToken: token }) });
    setUser(data.user);
    message($('claimMessage'), `${data.awarded} tokens added to your balance.`, true);
  } catch (error) {
    if (error.user) setUser(error.user);
    message($('claimMessage'), error.message);
    resetTurnstile();
  } finally { state.claimSubmitting = false; button.disabled = !state.turnstileToken; }
});

async function signOut() {
  $('accountMenu').open = false;
  const buttons = [$('logoutButton'), $('headerLogoutButton')];
  buttons.forEach(button => { button.disabled = true; });
  message($('accountMessage'), '');
  try {
    await api('logout', { method: 'POST', body: '{}' });
    if ($('accountDialog').open) $('accountDialog').close();
    setUser(null);
  } catch (error) {
    message($('accountMessage'), error.message);
    if (!$('accountDialog').open) $('accountDialog').showModal();
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

$('logoutButton').addEventListener('click', signOut);
$('headerLogoutButton').addEventListener('click', signOut);

function renderChat(messages) {
  const signature = messages.map(item => item.id).join(',');
  if (signature === state.chatSignature) return;
  state.chatSignature = signature;
  const container = $('chatMessages');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 70;
  container.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'No messages yet.';
    container.append(empty);
    return;
  }
  for (const item of messages) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    const head = document.createElement('div');
    head.className = 'chat-row-head';
    const author = document.createElement('strong');
    author.textContent = item.username;
    const time = document.createElement('time');
    time.dateTime = item.createdAt;
    time.textContent = new Date(item.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    const body = document.createElement('p');
    body.textContent = item.text;
    head.append(author, time);
    row.append(head, body);
    container.append(row);
  }
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

async function loadChat() {
  if (state.chatLoading) return;
  state.chatLoading = true;
  try {
    const data = await api('chat');
    renderChat(data.messages);
  } catch (error) {
    if (state.chatSignature === null) $('chatMessages').textContent = 'Chat is unavailable right now. Please try again.';
  } finally { state.chatLoading = false; }
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
loadChat();
setInterval(loadChat, 4000);

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
