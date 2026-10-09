const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { ObjectId } = require('mongodb');
const { connectMongo, CHAT_HISTORY_LIMIT, trimChatHistory, resolveChangelogOwner, createAccountId, ensureAccountId } = require('./mongo');
const { createMailer } = require('./mailer');
const { registerTrading } = require('./trading');
const { registerGames } = require('./games');
const { registerFriends } = require('./friends');
const { registerNews } = require('./news');
const { avatarUrl, AccountError, withAccountActivity, registerAccountFeatures } = require('./accounts');
const { createModeration, ModerationError } = require('./moderation');

const PORT = Number(process.env.PORT || 3000);
const HOURLY_TOKEN_MIN = 10;
const HOURLY_TOKEN_MAX = 20;
const CLAIM_INTERVAL_MS = 60 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PRESENCE_TIMEOUT_MS = 75 * 1000;
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';
const SIGNUP_VERIFY_MS = 24 * 60 * 60 * 1000;
const LOGIN_VERIFY_MS = 10 * 60 * 1000;
const EMAIL_ATTEMPT_INTERVAL_MS = 10 * 60 * 1000;
const cookieName = 'pepper_session';
const DEFAULT_BUILD_VERSION = '0.4.0-0';
const BUILD_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(0|[1-9]\d*)$/;
const LEGACY_BUILD_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const displayBuildVersion = value => {
  const version = typeof value === 'string' ? value.trim().replace(/^v/i, '') : '';
  if (BUILD_VERSION_PATTERN.test(version)) return version;
  if (LEGACY_BUILD_VERSION_PATTERN.test(version)) return `${version}-0`;
  return DEFAULT_BUILD_VERSION;
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const passwordHash = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
};
const passwordMatches = (password, stored) => {
  const [salt, hex] = (stored || '').split(':');
  if (!salt || !hex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};
const publicUser = (user, fields = { role: 'player', banned: false }) => ({
  username: user.username,
  accountId: user.accountId,
  avatarUrl: avatarUrl(user),
  email: user.email ?? null,
  createdAt: user.createdAt ?? null,
  balance: user.balance,
  lastClaimAt: user.lastClaimAt ?? null,
  nextClaimAt: user.lastClaimAt ? user.lastClaimAt + CLAIM_INTERVAL_MS : null,
  hourlyTokenMin: HOURLY_TOKEN_MIN,
  hourlyTokenMax: HOURLY_TOKEN_MAX,
  ...fields,
  canManageChangelog: fields.role === 'admin',
  canManageAnnouncements: ['admin', 'senior_mod', 'mod'].includes(fields.role)
});
const sendError = (res, status, message) => res.status(status).json({ error: message });
const sendRateLimit = (res, message, remainingMs) => {
  const retryAfterMs = Math.max(1, Math.ceil(remainingMs));
  res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  return res.status(429).json({ error: message, retryAfterMs });
};
const cookieOptions = () => `HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
const cookieToken = (req) => req.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);

function createApp({ client, users, sessions, messages, verificationTokens, changelog, announcements, trades, games, tradeMessages, friendships, friendMessages, newsComments, announcementSeen, cardDefinitions, cardInstances, siteSettings }, options = {}) {
  const app = express();
  const rateBuckets = new Map();
  const currentTime = options.now || Date.now;
  const moderation = createModeration({ client, users, sessions, messages, verificationTokens, trades, games, siteSettings }, { now: currentTime });
  const randomInt = options.randomInt || crypto.randomInt;
  const emailSendingPaused = options.emailSendingPaused === undefined
    ? process.env.EMAIL_SENDING_PAUSED === 'true' : options.emailSendingPaused;
  const mailer = emailSendingPaused ? null : options.mailer === undefined ? createMailer() : options.mailer;
  const publicUrl = options.publicUrl || process.env.APP_URL || `http://localhost:${PORT}`;
  const siteOrigin = new URL(publicUrl).origin;
  const localPreview = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(new URL(publicUrl).hostname);
  const turnstileSiteKey = options.turnstileSiteKey || process.env.TURNSTILE_SITE_KEY || (localPreview ? TURNSTILE_TEST_SITE_KEY : null);
  const turnstileSecretKey = options.turnstileSecretKey || process.env.TURNSTILE_SECRET_KEY || (localPreview ? TURNSTILE_TEST_SECRET_KEY : null);
  const turnstileConfigured = Boolean(turnstileSiteKey && turnstileSecretKey) &&
    !(process.env.NODE_ENV === 'production' &&
      (turnstileSiteKey === TURNSTILE_TEST_SITE_KEY || turnstileSecretKey === TURNSTILE_TEST_SECRET_KEY));
  const verifyTurnstile = options.verifyTurnstile || (async token => {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: turnstileSecretKey, response: token }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Turnstile Siteverify returned ${response.status}`);
    const result = await response.json();
    if (!result.success) return false;
    if (turnstileSecretKey === TURNSTILE_TEST_SECRET_KEY) return true;
    return result.action === 'claim_tokens' && result.hostname === new URL(publicUrl).hostname;
  });
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', req.path === '/verify.html' ? 'no-referrer' : 'strict-origin-when-cross-origin');
    if (req.path.startsWith('/api/') || req.path === '/verify.html') res.set('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin) {
        try {
          if (new URL(origin).host !== req.get('host')) return sendError(res, 403, 'Request origin was not accepted.');
        } catch { return sendError(res, 403, 'Request origin was not accepted.'); }
      }
    }
    next();
  });
  app.use('/api/account/avatar', express.json({ limit: '3mb' }));
  app.use(express.json({ limit: '32kb' }));

  function rateLimit(max, windowMs) {
    return (req, res, next) => {
      const key = `${req.ip}:${req.path}`;
      const now = currentTime();
      const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
      if (now >= bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + windowMs; }
      bucket.count += 1;
      rateBuckets.set(key, bucket);
      if (bucket.count > max) return sendRateLimit(res, 'Too many attempts. Please try again later.', bucket.resetAt - now);
      next();
    };
  }

  async function currentUser(req) {
    const token = cookieToken(req);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const session = await sessions.findOne({ _id: sha256(token), expiresAt: { $gt: new Date() } });
    if (!session) return null;
    if (session.banned) req.bannedSession = true;
    const user = await users.findOne({ _id: session.userId });
    if (user) await ensureAccountId(users, user);
    return user;
  }
  async function requireUser(req, res, next) {
    try {
      req.user = await currentUser(req);
      if (req.bannedSession || req.user?.banned) return res.status(403).json({ error: 'Account banned.', banned: true });
      if (!req.user) return sendError(res, 401, 'Please log in first.');
      next();
    } catch (error) { next(error); }
  }
  async function canManageChangelog(user) {
    return (await moderation.publicFields(user)).role === 'admin' && !user.banned;
  }
  async function signedInUser(user) {
    if (user.banned) throw new ModerationError(403, 'Account banned.', true);
    await ensureAccountId(users, user);
    return publicUser(user, await moderation.publicFields(user));
  }
  async function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await withAccountActivity({ client, users }, [userId], session => sessions.insertOne(
      { _id: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_MS) }, session ? { session } : {}
    ));
    res.set('Set-Cookie', `${cookieName}=${token}; ${cookieOptions()}`);
  }

  async function presenceSnapshot() {
    const now = new Date();
    const activeUserIds = await sessions.distinct('userId', {
      expiresAt: { $gt: now },
      lastSeenAt: { $gt: new Date(now.getTime() - PRESENCE_TIMEOUT_MS) }, banned: { $ne: true }
    });
    const activeUsers = activeUserIds.length ? await users.find({ _id: { $in: activeUserIds }, banned: { $ne: true } }, {
      projection: { accountId: 1, username: 1, avatarVersion: 1, role: 1, banned: 1 }
    }).sort({ usernameKey: 1, _id: 1 }).toArray() : [];
    const players = await Promise.all(activeUsers.map(user => moderation.publicPlayer(user)));
    return { count: players.length, players };
  }
  app.get('/api/presence', async (req, res) => {
    res.json(await presenceSnapshot());
  });
  app.post('/api/presence', async (req, res) => {
    const user = await currentUser(req);
    if (user && !user.banned && !req.bannedSession) {
      const now = new Date();
      await sessions.updateOne(
        { _id: sha256(cookieToken(req)), userId: user._id, expiresAt: { $gt: now } },
        { $set: { lastSeenAt: now } }
      );
    }
    res.json(await presenceSnapshot());
  });

  async function sendVerification(user, purpose) {
    if (!mailer) return 'failed';
    const now = Date.now();
    const reserved = await users.findOneAndUpdate(
      { _id: user._id, $or: [
        { lastEmailAttemptAt: { $exists: false } },
        { lastEmailAttemptAt: { $lte: new Date(now - EMAIL_ATTEMPT_INTERVAL_MS) } }
      ] },
      { $set: { lastEmailAttemptAt: new Date(now) } },
      { returnDocument: 'after' }
    );
    if (!reserved) return 'recent';
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + (purpose === 'signup' ? SIGNUP_VERIFY_MS : LOGIN_VERIFY_MS));
    const url = new URL('/verify.html', siteOrigin);
    url.searchParams.set('purpose', purpose);
    url.searchParams.set('token', token);
    await withAccountActivity({ client, users }, [user._id], session => verificationTokens.insertOne(
      { _id: tokenHash, userId: user._id, purpose, expiresAt }, session ? { session } : {}
    ));
    try {
      await mailer.sendVerification({ to: user.email, purpose, url: url.toString() });
    } catch (error) {
      await verificationTokens.deleteOne({ _id: tokenHash });
      console.error('Verification email could not be sent:', error.code || 'delivery error');
      return 'failed';
    }
    await verificationTokens.deleteMany({ userId: user._id, purpose, _id: { $ne: tokenHash } });
    return 'sent';
  }

  app.post('/api/register', rateLimit(5, 15 * 60 * 1000), async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return sendError(res, 400, 'Username must be 3–24 letters, numbers, or underscores.');
    if (password.length < 8 || password.length > 128) return sendError(res, 400, 'Password must be 8–128 characters.');
    try {
      const user = {
        username, usernameKey: username.toLowerCase(),
        accountId: createAccountId(),
        passwordHash: passwordHash(password), balance: 0, lastClaimAt: null,
        createdAt: new Date()
      };
      let result;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { result = await users.insertOne(user); break; }
        catch (error) {
          if (error.code !== 11000 || !error.keyPattern?.accountId || attempt === 4) throw error;
          user.accountId = createAccountId();
        }
      }
      user._id = result.insertedId;
      await startSession(res, user._id);
      res.status(201).json({ user: await signedInUser(user) });
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?.accountId) return sendError(res, 503, 'An account ID could not be assigned. Please try again.');
      if (error.code === 11000) return sendError(res, 409, 'That username is already in use.');
      throw error;
    }
  });

  app.post('/api/login', (req, res, next) => {
    if (emailSendingPaused && String(req.body?.identifier || '').includes('@')) {
      return sendError(res, 503, 'Email sign-in is temporarily paused. You can log in with your username.');
    }
    next();
  }, rateLimit(10, 15 * 60 * 1000), async (req, res) => {
    const identifier = String(req.body?.identifier || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await users.findOne({ $or: [{ usernameKey: identifier }, { email: identifier }] });
    if (!user || !passwordMatches(password, user.passwordHash)) return sendError(res, 401, 'Incorrect username, email, or password.');
    if (user.banned) return res.status(403).json({ error: 'Account banned.', banned: true });
    if (identifier.includes('@')) {
      if (mailer?.canSendTo && !mailer.canSendTo(user.email)) return sendError(res, 503, 'Email sign-in is unavailable for this address during private testing. You can log in with your username.');
      const sendStatus = await sendVerification(user, 'login');
      if (sendStatus === 'recent') return sendError(res, 429, 'A sign-in email was requested recently. Please wait 10 minutes or log in with your username.');
      if (sendStatus !== 'sent') return sendError(res, 503, 'Could not send the sign-in email. You can also log in with your username.');
      return res.json({ pending: true, message: 'Check your email and click the sign-in link to finish logging in.' });
    }
    await startSession(res, user._id);
    res.json({ user: await signedInUser(user) });
  });

  app.post('/api/verify-email', rateLimit(20, 15 * 60 * 1000), async (req, res) => {
    const token = String(req.body?.token || '');
    const purpose = String(req.body?.purpose || '');
    if (!/^[a-f0-9]{64}$/.test(token) || !['signup', 'login'].includes(purpose)) {
      return sendError(res, 400, 'This verification link is invalid.');
    }
    const record = await verificationTokens.findOneAndDelete({
      _id: sha256(token), purpose, expiresAt: { $gt: new Date() }
    });
    if (!record) return sendError(res, 400, 'This verification link is invalid or expired. Log in again with your password to request a new link.');
    if (purpose === 'signup') {
      await users.updateOne({ _id: record.userId, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date() } });
    }
    const user = await users.findOne({ _id: record.userId });
    if (user?.banned) return res.status(403).json({ error: 'Account banned.', banned: true });
    if (!user || user.emailVerifiedAt === null) return sendError(res, 400, 'This account is not ready to sign in.');
    await startSession(res, user._id);
    res.json({ user: await signedInUser(user) });
  });

  app.post('/api/logout', async (req, res) => {
    const token = cookieToken(req);
    if (token && /^[a-f0-9]{64}$/.test(token)) await sessions.deleteOne({ _id: sha256(token) });
    res.set('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', async (req, res) => {
    const user = await currentUser(req);
    if (req.bannedSession || user?.banned) return res.json({ user: null, banned: true });
    res.json({ user: user ? await signedInUser(user) : null });
  });

  app.patch('/api/account/username', requireUser, rateLimit(10, 15 * 60 * 1000), async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const currentPassword = String(req.body?.currentPassword || '');
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return sendError(res, 400, 'Username must be 3–24 letters, numbers, or underscores.');
    if (!passwordMatches(currentPassword, req.user.passwordHash)) return sendError(res, 403, 'Incorrect current password.');
    const ownerId = await resolveChangelogOwner(users, siteSettings);
    if (username === '675' && !ownerId) return sendError(res, 403, 'That username is reserved for the changelog owner.');
    try {
      const user = await users.findOneAndUpdate(
        { _id: req.user._id, passwordHash: req.user.passwordHash, banned: { $ne: true } },
        { $set: { username, usernameKey: username.toLowerCase() } },
        { returnDocument: 'after' }
      );
      if (!user) return sendError(res, 409, 'Your account changed. Please try again.');
      res.json({ user: await signedInUser(user) });
    } catch (error) {
      if (error.code === 11000) return sendError(res, 409, 'That username is already in use.');
      throw error;
    }
  });

  app.patch('/api/account/password', requireUser, rateLimit(10, 15 * 60 * 1000), async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 8 || newPassword.length > 128) return sendError(res, 400, 'Password must be 8–128 characters.');
    if (!passwordMatches(currentPassword, req.user.passwordHash)) return sendError(res, 403, 'Incorrect current password.');
    const user = await users.findOneAndUpdate(
      { _id: req.user._id, passwordHash: req.user.passwordHash, banned: { $ne: true } },
      { $set: { passwordHash: passwordHash(newPassword) } },
      { returnDocument: 'after' }
    );
    if (!user) return sendError(res, 409, 'Your account changed. Please try again.');
    try {
      await sessions.deleteMany({ userId: req.user._id, _id: { $ne: sha256(cookieToken(req)) } });
      await verificationTokens.deleteMany({ userId: req.user._id, purpose: 'login' });
    } catch (error) {
      console.error('Other sign-ins could not be cleared:', error.message);
      return sendError(res, 503, 'Your password was changed, but other sign-ins could not be cleared. Try again using your new password as the current password.');
    }
    res.json({ ok: true });
  });

  registerAccountFeatures(app, { client, users, sessions, verificationTokens, messages, trades, games, tradeMessages, friendships, friendMessages, newsComments, announcementSeen, cardInstances }, {
    requireUser, rateLimit, signedInUser, passwordMatches, cookieName, now: currentTime
  });
  moderation.register(app, { requireUser, rateLimit });

  app.get('/api/players', requireUser, async (req, res) => {
    const query = req.query.username;
    if ((query !== undefined && typeof query !== 'string') ||
        Object.keys(req.query).some(key => key.startsWith('username['))) {
      return sendError(res, 400, 'Enter a valid username.');
    }
    const prefix = (query || '').trim();
    if (!/^[a-zA-Z0-9_]{0,24}$/.test(prefix)) return sendError(res, 400, 'Enter a valid username.');
    const players = await users.find({
      _id: { $ne: req.user._id },
      banned: { $ne: true },
      ...(prefix ? { usernameKey: { $regex: `^${prefix.toLowerCase()}` } } : {})
    }, {
      projection: { username: 1, accountId: 1, avatarVersion: 1, role: 1, banned: 1 }
    }).sort({ usernameKey: 1, _id: 1 }).limit(25).toArray();
    res.json({ players: await Promise.all(players.map(player => moderation.publicPlayer(player))) });
  });

  app.get('/api/profiles/:username', async (req, res) => {
    const username = req.params.username;
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return sendError(res, 404, 'Profile not found.');
    const user = await users.findOne(
      { usernameKey: username.toLowerCase() },
      { projection: { username: 1, accountId: 1, createdAt: 1, balance: 1, lastClaimAt: 1, avatarVersion: 1, role: 1, banned: 1 } }
    );
    if (!user) return sendError(res, 404, 'Profile not found.');
    await ensureAccountId(users, user);
    res.json({ profile: {
      username: user.username,
      accountId: user.accountId,
      avatarUrl: avatarUrl(user),
      ...await moderation.publicFields(user),
      createdAt: user.createdAt ?? null,
      balance: user.balance ?? 0,
      lastClaimAt: user.lastClaimAt ?? null,
      nextClaimAt: user.lastClaimAt ? user.lastClaimAt + CLAIM_INTERVAL_MS : null
    } });
  });

  app.get('/api/turnstile-config', (req, res) => {
    res.json({ siteKey: turnstileConfigured ? turnstileSiteKey : null });
  });

  app.post('/api/claim', requireUser, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    if (!turnstileConfigured) return sendError(res, 503, 'Cloudflare verification is not configured yet.');
    if (req.user.lastClaimAt && currentTime() < req.user.lastClaimAt + CLAIM_INTERVAL_MS) {
      return sendError(res, 429, 'Your next claim is not ready yet.');
    }
    const token = String(req.body?.turnstileToken || '');
    if (!token || token.length > 2048) return sendError(res, 400, 'Complete the Cloudflare verification first.');
    let verified;
    try { verified = await verifyTurnstile(token); }
    catch (error) {
      console.error('Turnstile verification failed:', error.message);
      return sendError(res, 503, 'Verification is unavailable right now. Try again.');
    }
    if (!verified) return sendError(res, 400, 'Cloudflare verification failed or expired. Try again.');
    const now = currentTime();
    const awarded = randomInt(HOURLY_TOKEN_MIN, HOURLY_TOKEN_MAX + 1);
    const user = await users.findOneAndUpdate(
      { _id: req.user._id, banned: { $ne: true }, $or: [{ lastClaimAt: null }, { lastClaimAt: { $lte: now - CLAIM_INTERVAL_MS } }],
        $expr: { $lte: [{ $add: ['$balance', { $ifNull: ['$gamePayoutReserve', 0] }, awarded] }, Number.MAX_SAFE_INTEGER] } },
      { $inc: { balance: awarded }, $set: { lastClaimAt: now } },
      { returnDocument: 'after' }
    );
    if (!user) {
      const latest = await users.findOne({ _id: req.user._id });
      if (!latest) return sendError(res, 401, 'Please log in first.');
      if (latest.balance > Number.MAX_SAFE_INTEGER - awarded - (latest.gamePayoutReserve ?? 0)) {
        return res.status(409).json({ error: 'Token balance limit reached.', user: await signedInUser(latest) });
      }
      return res.status(429).json({ error: 'Your next claim is not ready yet.', user: await signedInUser(latest) });
    }
    res.json({ user: await signedInUser(user), awarded });
  });

  registerTrading(app, { client, users, trades, tradeMessages, cardDefinitions, cardInstances }, { requireUser, rateLimit, signedInUser, publicPlayerFields: moderation.publicFields });
  app.locals.games = registerGames(app, { client, users, games }, { requireUser, rateLimit, signedInUser, now: currentTime, publicPlayerFields: moderation.publicFields, randomDice: options.randomDice });
  registerFriends(app, { users, friendships, friendMessages }, { requireUser, rateLimit, moderation, now: currentTime, claimIntervalMs: CLAIM_INTERVAL_MS });
  const news = registerNews(app, { users, changelog, announcements, newsComments, announcementSeen }, {
    requireUser, rateLimit, moderation, now: currentTime, publicAnnouncement: entry => publicAnnouncementEntry(entry)
  });

  const publicChangelogEntry = async (entry) => ({
    id: entry._id.toString(),
    title: entry.title,
    description: entry.description,
    version: displayBuildVersion(entry.version),
    createdAt: entry.createdAt.toISOString(),
    ...await news.publicFields('changelog', entry)
  });
  async function currentBuildVersion() {
    const saved = await siteSettings.findOne({ _id: 'version' });
    if (saved) return displayBuildVersion(saved.version);
    const latest = await changelog.findOne({}, { sort: { createdAt: -1, _id: -1 }, projection: { version: 1 } });
    return displayBuildVersion(latest?.version);
  }
  async function saveBuildVersion(version, actor, session) {
    await siteSettings.updateOne({ _id: 'version' }, { $set: {
      version, updatedAt: new Date(currentTime()), updatedByAccountId: actor.accountId
    } }, { upsert: true, session });
  }
  app.get('/api/version', async (req, res) => {
    res.json({ version: await currentBuildVersion() });
  });
  app.patch('/api/version', requireUser, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    if (!await canManageChangelog(req.user)) return sendError(res, 403, 'Admin access required.');
    const version = typeof req.body?.version === 'string' ? req.body.version.trim().replace(/^v/i, '') : '';
    if (version.length > 32 || !BUILD_VERSION_PATTERN.test(version)) return sendError(res, 400, 'Use a version like 0.6.1-2.');
    await moderation.runAs(req.user._id, async ({ session, actor, role }) => {
      if (role !== 'admin') throw new ModerationError(403, 'Admin access required.');
      await saveBuildVersion(version, actor, session);
    });
    res.json({ version: await currentBuildVersion() });
  });
  async function changelogSnapshot() {
    const entries = await changelog.find().sort({ createdAt: -1, _id: -1 }).toArray();
    const publicEntries = await Promise.all(entries.map(publicChangelogEntry));
    return { entries: publicEntries, latestVersion: await currentBuildVersion() };
  }
  app.get('/api/changelog', async (req, res) => {
    res.json(await changelogSnapshot());
  });
  app.post('/api/changelog', requireUser, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    if (!await canManageChangelog(req.user)) return sendError(res, 403, 'Admin access required.');
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const version = typeof req.body?.version === 'string' ? req.body.version.trim().replace(/^v/i, '') : '';
    if (!title || title.length > 120) return sendError(res, 400, 'Title must be 1–120 characters.');
    if (!description || description.length > 5000) return sendError(res, 400, 'Description must be 1–5,000 characters.');
    if (version.length > 32 || !BUILD_VERSION_PATTERN.test(version)) {
      return sendError(res, 400, 'Use a version like 0.6.1-2.');
    }
    const entry = { title, description, version, createdAt: new Date(), authorId: req.user._id, authorAccountId: req.user.accountId };
    await moderation.runAs(req.user._id, async ({ session, actor, role }) => {
      if (role !== 'admin') throw new ModerationError(403, 'Admin access required.');
      await changelog.insertOne(entry, { session });
      await saveBuildVersion(version, actor, session);
    });
    res.status(201).json({ entry: await publicChangelogEntry(entry), latestVersion: await currentBuildVersion() });
  });
  app.delete('/api/changelog/:id', requireUser, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    if (!await canManageChangelog(req.user)) return sendError(res, 403, 'Admin access required.');
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return sendError(res, 400, 'This changelog entry ID is invalid.');
    const result = await moderation.runAs(req.user._id, async ({ session, role }) => {
      if (role !== 'admin') throw new ModerationError(403, 'Admin access required.');
      const entryId = new ObjectId(req.params.id);
      const deleted = await changelog.deleteOne({ _id: entryId }, { session });
      if (deleted.deletedCount) await news.cleanup('changelog', entryId, session);
      return deleted;
    });
    if (!result.deletedCount) return sendError(res, 404, 'Changelog entry not found.');
    res.json(await changelogSnapshot());
  });

  const publicAnnouncementEntry = async (entry) => ({
    id: entry._id.toString(),
    title: entry.title,
    description: entry.description,
    authorAccountId: entry.authorAccountId ?? null,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt?.toISOString() ?? null,
    ...await news.publicFields('announcements', entry)
  });
  async function announcementsSnapshot() {
    const entries = await announcements.find().sort({ createdAt: -1, _id: -1 }).toArray();
    return { entries: await Promise.all(entries.map(publicAnnouncementEntry)) };
  }
  app.get('/api/announcements', async (req, res) => {
    res.json(await announcementsSnapshot());
  });
  app.post('/api/announcements', requireUser, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    if (!['admin', 'senior_mod', 'mod'].includes((await moderation.publicFields(req.user)).role)) return sendError(res, 403, 'Moderator access required.');
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    if (!title || title.length > 120) return sendError(res, 400, 'Title must be 1–120 characters.');
    if (!description || description.length > 5000) return sendError(res, 400, 'Description must be 1–5,000 characters.');
    const entry = { title, description, createdAt: new Date(), authorId: req.user._id, authorAccountId: req.user.accountId };
    await moderation.runAs(req.user._id, async ({ session, role }) => {
      if (!['admin', 'senior_mod', 'mod'].includes(role)) throw new ModerationError(403, 'Moderator access required.');
      await announcements.insertOne(entry, { session });
      await news.markSeen(entry._id, req.user._id, session);
    });
    res.status(201).json({ entry: await publicAnnouncementEntry(entry) });
  });
  async function requireAnnouncementManagement(entry, { session, actor, role, roleOf }) {
    const own = entry.authorAccountId === actor.accountId || entry.authorId?.equals(actor._id);
    if (role === 'admin' || (['senior_mod', 'mod'].includes(role) && own)) return;
    const author = entry.authorAccountId ? await users.findOne({ accountId: entry.authorAccountId }, { session })
      : entry.authorId ? await users.findOne({ _id: entry.authorId }, { session }) : null;
    if (role === 'senior_mod' && ['player', 'mod'].includes(roleOf(author || { accountId: entry.authorAccountId }))) return;
    throw new ModerationError(403, 'Action unavailable.');
  }
  app.patch('/api/announcements/:id', requireUser, rateLimit(60, 60 * 60 * 1000), async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return sendError(res, 400, 'Invalid announcement.');
    const payload = req.body || {};
    if (Object.keys(payload).some(key => !['title', 'description'].includes(key))) return sendError(res, 400, 'Invalid announcement fields.');
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const description = typeof payload.description === 'string' ? payload.description.trim() : '';
    if (!title || title.length > 120) return sendError(res, 400, 'Title must be 1–120 characters.');
    if (!description || description.length > 5000) return sendError(res, 400, 'Description must be 1–5,000 characters.');
    const saved = await announcements.findOne({ _id: new ObjectId(req.params.id) });
    if (!saved) return sendError(res, 404, 'Announcement not found.');
    await moderation.runAs(req.user._id, async context => {
      const { session, actor } = context;
      const entry = await announcements.findOne({ _id: saved._id }, { session });
      if (!entry) throw new ModerationError(404, 'Announcement not found.');
      await requireAnnouncementManagement(entry, context);
      const own = entry.authorAccountId === actor.accountId || entry.authorId?.equals(actor._id);
      await announcements.updateOne({ _id: entry._id }, {
        $set: { title, description, updatedAt: new Date(currentTime()) },
        ...(!own ? { $addToSet: { editorAccountIds: actor.accountId } } : {})
      }, { session });
    }, saved.authorId ? [saved.authorId] : []);
    res.json(await announcementsSnapshot());
  });
  app.delete('/api/announcements/:id', requireUser, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return sendError(res, 400, 'This announcement entry ID is invalid.');
    const saved = await announcements.findOne({ _id: new ObjectId(req.params.id) });
    if (!saved) return sendError(res, 404, 'Announcement not found.');
    const result = await moderation.runAs(req.user._id, async context => {
      const { session } = context;
      const entry = await announcements.findOne({ _id: new ObjectId(req.params.id) }, { session });
      if (!entry) throw new ModerationError(404, 'Announcement not found.');
      await requireAnnouncementManagement(entry, context);
      const deleted = await announcements.deleteOne({ _id: entry._id }, { session });
      if (deleted.deletedCount) await news.cleanup('announcements', entry._id, session);
      return deleted;
    }, saved.authorId ? [saved.authorId] : []);
    if (!result.deletedCount) return sendError(res, 404, 'Announcement entry not found.');
    res.json(await announcementsSnapshot());
  });

  app.get('/api/leaderboard', async (req, res) => {
    const [leaders, totalPlayers] = await Promise.all([
      users.find({ banned: { $ne: true } }, { projection: { username: 1, accountId: 1, balance: 1, avatarVersion: 1, role: 1, banned: 1 } })
        .sort({ balance: -1, usernameKey: 1, _id: 1 }).limit(100).toArray(),
      users.countDocuments({ banned: { $ne: true } })
    ]);
    let rank = 0;
    let previousBalance;
    const entries = [];
    for (const [index, user] of leaders.entries()) {
      await ensureAccountId(users, user);
      const balance = user.balance ?? 0;
      if (index === 0 || balance !== previousBalance) rank = index + 1;
      previousBalance = balance;
      entries.push({ rank, username: user.username, accountId: user.accountId, balance, avatarUrl: avatarUrl(user), ...await moderation.publicFields(user) });
    }
    res.json({ entries, totalPlayers });
  });

  const publicMessage = (message, authors, availableMessageIds) => ({
    id: message._id.toString(),
    username: authors.get(message.userId?.toString())?.username ?? message.username,
    accountId: authors.get(message.userId?.toString())?.accountId ?? null,
    avatarUrl: authors.get(message.userId?.toString())?.avatarUrl ?? avatarUrl(null),
    role: authors.get(message.userId?.toString())?.role ?? 'player',
    banned: authors.get(message.userId?.toString())?.banned ?? false,
    text: message.deleted ? 'Message deleted.' : message.text,
    ...(message.deleted ? { deleted: true } : {}),
    createdAt: message.createdAt.toISOString(),
    clientMessageId: message.clientMessageId ?? null,
    replyTo: message.replyTo ? {
      id: message.replyTo.id.toString(),
      username: authors.get(message.replyTo.userId?.toString())?.username ?? message.replyTo.username,
      accountId: authors.get(message.replyTo.userId?.toString())?.accountId ?? null,
      avatarUrl: authors.get(message.replyTo.userId?.toString())?.avatarUrl ?? avatarUrl(null),
      role: authors.get(message.replyTo.userId?.toString())?.role ?? 'player',
      banned: authors.get(message.replyTo.userId?.toString())?.banned ?? false,
      text: message.replyTo.deleted ? 'Message deleted.' : message.replyTo.text,
      available: !message.replyTo.deleted && availableMessageIds.has(message.replyTo.id.toString())
    } : null
  });
  async function messageAuthors(chatMessages) {
    const authorIds = [...new Map(chatMessages.flatMap(message => [message.userId, message.replyTo?.userId])
      .filter(Boolean).map(userId => [userId.toString(), userId])).values()];
    const authors = authorIds.length ? await users.find(
      { _id: { $in: authorIds } }, { projection: { username: 1, accountId: 1, avatarVersion: 1, role: 1, banned: 1 } }
    ).toArray() : [];
    return new Map(await Promise.all(authors.map(async author => [author._id.toString(), { username: author.username, accountId: author.accountId ?? null, avatarUrl: avatarUrl(author), ...await moderation.publicFields(author) }])));
  }
  app.get('/api/chat', async (req, res) => {
    const latest = await messages.find().sort({ createdAt: -1, _id: -1 }).limit(CHAT_HISTORY_LIMIT).toArray();
    const authors = await messageAuthors(latest);
    const availableMessageIds = new Set(latest.filter(message => !message.deleted).map(message => message._id.toString()));
    res.json({ messages: latest.reverse().map(message => publicMessage(
      message, authors, availableMessageIds
    )) });
  });
  async function sendPublicChatMessage(res, message) {
    const [retained, authors] = await Promise.all([
      messages.find({ deleted: { $ne: true } }, { projection: { _id: 1 } }).sort({ createdAt: -1, _id: -1 }).limit(CHAT_HISTORY_LIMIT).toArray(),
      messageAuthors([message])
    ]);
    const availableMessageIds = new Set(retained.map(entry => entry._id.toString()));
    res.status(201).json({ message: publicMessage(message, authors, availableMessageIds) });
  }
  app.post('/api/chat', requireUser, rateLimit(12, 60 * 1000), async (req, res) => {
    const requestedClientMessageId = req.body?.clientMessageId;
    let clientMessageId = null;
    if (requestedClientMessageId !== undefined && requestedClientMessageId !== null) {
      if (typeof requestedClientMessageId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestedClientMessageId)) {
        return sendError(res, 400, 'This chat message ID is invalid.');
      }
      clientMessageId = requestedClientMessageId.toLowerCase();
    }
    async function replayIfSaved() {
      if (!clientMessageId) return false;
      const saved = await messages.findOne({ userId: req.user._id, clientMessageId });
      if (!saved) return false;
      await sendPublicChatMessage(res, saved);
      return true;
    }
    if (await replayIfSaved()) return;
    const messageText = String(req.body?.text || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    if (!messageText || messageText.length > 400) return sendError(res, 400, 'Message must be 1–400 characters.');
    const replyToId = req.body?.replyToId;
    let replyTo = null;
    if (replyToId !== undefined && replyToId !== null) {
      if (typeof replyToId !== 'string' || !/^[a-f0-9]{24}$/i.test(replyToId)) {
        return sendError(res, 400, 'The message you are replying to is invalid.');
      }
      const parent = await messages.findOne({ _id: new ObjectId(replyToId) });
      if (!parent || parent.deleted) {
        if (await replayIfSaved()) return;
        return sendError(res, 404, 'The message you are replying to is no longer in chat.');
      }
      const isOwnMessage = parent.userId
        ? parent.userId.toString() === req.user._id.toString()
        : String(parent.username || '').trim().toLowerCase() === req.user.username.trim().toLowerCase();
      if (isOwnMessage) {
        if (await replayIfSaved()) return;
        return sendError(res, 400, 'You cannot reply to your own message.');
      }
      const parentAuthor = parent.userId ? await users.findOne(
        { _id: parent.userId }, { projection: { username: 1 } }
      ) : null;
      replyTo = { id: parent._id, userId: parent.userId ?? null, username: parentAuthor?.username ?? parent.username, text: parent.text };
    }
    const last = await messages.findOne({ userId: req.user._id }, { sort: { createdAt: -1, _id: -1 } });
    const cooldownRemaining = last ? last.createdAt.getTime() + 3000 - currentTime() : 0;
    if (cooldownRemaining > 0) {
      if (await replayIfSaved()) return;
      return sendRateLimit(res, 'Please wait a few seconds before sending another message.', cooldownRemaining);
    }
    const message = { userId: req.user._id, accountId: req.user.accountId, username: req.user.username, text: messageText, createdAt: new Date(currentTime()), replyTo };
    if (clientMessageId) message.clientMessageId = clientMessageId;
    try { await withAccountActivity({ client, users }, [req.user._id, ...(replyTo?.userId ? [replyTo.userId] : [])], async session => {
      const options = session ? { session } : {};
      if (replyTo) {
        const parent = await messages.findOne({ _id: replyTo.id }, options);
        if (!parent || parent.deleted) throw new ModerationError(409, 'Original message unavailable.');
        message.replyTo.text = parent.text;
      }
      return messages.insertOne(message, options);
    }); }
    catch (error) {
      if (error.code !== 11000 || !clientMessageId || (error.keyPattern && !error.keyPattern.clientMessageId)) throw error;
      if (await replayIfSaved()) return;
      throw error;
    }
    await trimChatHistory(messages);
    await sendPublicChatMessage(res, message);
  });

  app.get(['/profile', '/profile/:username', '/settings', '/changelog', '/announcements', '/leaderboard', '/trading', '/games', '/friends', '/packs'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
  app.get('/packs/test', (req, res) => res.redirect(302, '/#cards'));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((error, req, res, next) => {
    if (error.status === 429 && error.retryAfterMs) return sendRateLimit(res, error.message, error.retryAfterMs);
    if (error instanceof ModerationError || error?.banned) return res.status(error.status || 403).json({ error: error.message, ...(error.banned ? { banned: true } : {}) });
    if (error instanceof AccountError) return sendError(res, error.status, error.message);
    console.error(error);
    if (error instanceof SyntaxError && 'body' in error) return sendError(res, 400, 'Invalid request.');
    if (error.type === 'entity.too.large') return sendError(res, 413, 'The request is too large.');
    sendError(res, 500, 'Something went wrong. Please try again.');
  });

  setInterval(() => {
    const now = currentTime();
    for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
  }, 60 * 60 * 1000).unref();
  return app;
}

async function start() {
  const store = await connectMongo();
  const app = createApp(store);
  const server = app.listen(PORT, () => console.log(`Pepper TCG running at http://localhost:${PORT}`));
  let sweeping = false;
  const expireGames = async () => {
    if (sweeping) return;
    sweeping = true;
    try { await app.locals.games.expireGames(); }
    catch (error) { console.error('Game expiry failed:', error.message); }
    finally { sweeping = false; }
  };
  const gameTimer = setInterval(expireGames, 15 * 1000).unref();
  server.once('close', () => clearInterval(gameTimer));
  await expireGames();
}
if (require.main === module) start().catch(error => { console.error('Could not start Pepper TCG:', error.message); process.exitCode = 1; });
module.exports = { createApp, connectMongo, CLAIM_INTERVAL_MS, HOURLY_TOKEN_MIN, HOURLY_TOKEN_MAX, PRESENCE_TIMEOUT_MS };
