const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { ObjectId } = require('mongodb');
const { connectMongo, CHAT_HISTORY_LIMIT, trimChatHistory, resolveChangelogOwner, createAccountId, ensureAccountId } = require('./mongo');
const { createMailer } = require('./mailer');

const PORT = Number(process.env.PORT || 3000);
const HOURLY_TOKEN_MIN = 10;
const HOURLY_TOKEN_MAX = 20;
const CLAIM_INTERVAL_MS = 60 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';
const SIGNUP_VERIFY_MS = 24 * 60 * 60 * 1000;
const LOGIN_VERIFY_MS = 10 * 60 * 1000;
const EMAIL_ATTEMPT_INTERVAL_MS = 10 * 60 * 1000;
const cookieName = 'pepper_session';
const DEFAULT_BUILD_VERSION = '0.4.0';

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
const publicUser = (user, canManageChangelog = false) => ({
  username: user.username,
  accountId: user.accountId,
  email: user.email ?? null,
  createdAt: user.createdAt ?? null,
  balance: user.balance,
  lastClaimAt: user.lastClaimAt ?? null,
  nextClaimAt: user.lastClaimAt ? user.lastClaimAt + CLAIM_INTERVAL_MS : null,
  hourlyTokenMin: HOURLY_TOKEN_MIN,
  hourlyTokenMax: HOURLY_TOKEN_MAX,
  canManageChangelog
});
const sendError = (res, status, message) => res.status(status).json({ error: message });
const cookieOptions = () => `HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
const cookieToken = (req) => req.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);

function createApp({ users, sessions, messages, verificationTokens, changelog, siteSettings }, options = {}) {
  const app = express();
  const rateBuckets = new Map();
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
  app.use(express.json({ limit: '32kb' }));

  function rateLimit(max, windowMs) {
    return (req, res, next) => {
      const key = `${req.ip}:${req.path}`;
      const now = Date.now();
      const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
      if (now >= bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + windowMs; }
      bucket.count += 1;
      rateBuckets.set(key, bucket);
      if (bucket.count > max) return sendError(res, 429, 'Too many attempts. Please try again later.');
      next();
    };
  }

  async function currentUser(req) {
    const token = cookieToken(req);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const session = await sessions.findOne({ _id: sha256(token), expiresAt: { $gt: new Date() } });
    if (!session) return null;
    const user = await users.findOne({ _id: session.userId });
    if (user) await ensureAccountId(users, user);
    return user;
  }
  async function requireUser(req, res, next) {
    try {
      req.user = await currentUser(req);
      if (!req.user) return sendError(res, 401, 'Please log in first.');
      next();
    } catch (error) { next(error); }
  }
  async function canManageChangelog(user) {
    const ownerAccountId = await resolveChangelogOwner(users, siteSettings);
    return Boolean(ownerAccountId && user.accountId === ownerAccountId);
  }
  async function signedInUser(user) {
    await ensureAccountId(users, user);
    return publicUser(user, await canManageChangelog(user));
  }
  async function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await sessions.insertOne({ _id: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_MS) });
    res.set('Set-Cookie', `${cookieName}=${token}; ${cookieOptions()}`);
  }

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
    await verificationTokens.insertOne({ _id: tokenHash, userId: user._id, purpose, expiresAt });
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
        { _id: req.user._id, passwordHash: req.user.passwordHash },
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
      { _id: req.user._id, passwordHash: req.user.passwordHash },
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

  app.get('/api/profiles/:username', async (req, res) => {
    const username = req.params.username;
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return sendError(res, 404, 'Profile not found.');
    const user = await users.findOne(
      { usernameKey: username.toLowerCase() },
      { projection: { username: 1, accountId: 1, createdAt: 1, balance: 1, lastClaimAt: 1 } }
    );
    if (!user) return sendError(res, 404, 'Profile not found.');
    await ensureAccountId(users, user);
    res.json({ profile: {
      username: user.username,
      accountId: user.accountId,
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
    if (req.user.lastClaimAt && Date.now() < req.user.lastClaimAt + CLAIM_INTERVAL_MS) {
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
    const now = Date.now();
    const awarded = randomInt(HOURLY_TOKEN_MIN, HOURLY_TOKEN_MAX + 1);
    const user = await users.findOneAndUpdate(
      { _id: req.user._id, $or: [{ lastClaimAt: null }, { lastClaimAt: { $lte: now - CLAIM_INTERVAL_MS } }] },
      { $inc: { balance: awarded }, $set: { lastClaimAt: now } },
      { returnDocument: 'after' }
    );
    if (!user) {
      const latest = await users.findOne({ _id: req.user._id });
      if (!latest) return sendError(res, 401, 'Please log in first.');
      return res.status(429).json({ error: 'Your next claim is not ready yet.', user: await signedInUser(latest) });
    }
    res.json({ user: await signedInUser(user), awarded });
  });

  const publicChangelogEntry = (entry) => ({
    id: entry._id.toString(),
    title: entry.title,
    description: entry.description,
    version: entry.version,
    createdAt: entry.createdAt.toISOString()
  });
  async function changelogSnapshot() {
    const entries = await changelog.find().sort({ createdAt: -1, _id: -1 }).toArray();
    return { entries: entries.map(publicChangelogEntry), latestVersion: entries[0]?.version ?? DEFAULT_BUILD_VERSION };
  }
  app.get('/api/changelog', async (req, res) => {
    res.json(await changelogSnapshot());
  });
  app.post('/api/changelog', requireUser, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    if (!await canManageChangelog(req.user)) return sendError(res, 403, 'Only the changelog owner can publish updates.');
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const version = typeof req.body?.version === 'string' ? req.body.version.trim().replace(/^v/i, '') : '';
    if (!title || title.length > 120) return sendError(res, 400, 'Title must be 1–120 characters.');
    if (!description || description.length > 5000) return sendError(res, 400, 'Description must be 1–5,000 characters.');
    if (version.length > 32 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
      return sendError(res, 400, 'Version must use numbers in major.minor.patch format, such as 0.5.0.');
    }
    const entry = { title, description, version, createdAt: new Date(), authorId: req.user._id, authorAccountId: req.user.accountId };
    await changelog.insertOne(entry);
    const latest = await changelog.findOne({}, { sort: { createdAt: -1, _id: -1 }, projection: { version: 1 } });
    res.status(201).json({ entry: publicChangelogEntry(entry), latestVersion: latest?.version ?? DEFAULT_BUILD_VERSION });
  });
  app.delete('/api/changelog/:id', requireUser, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    if (!await canManageChangelog(req.user)) return sendError(res, 403, 'Only the changelog owner can delete updates.');
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return sendError(res, 400, 'This changelog entry ID is invalid.');
    const result = await changelog.deleteOne({ _id: new ObjectId(req.params.id) });
    if (!result.deletedCount) return sendError(res, 404, 'Changelog entry not found.');
    res.json(await changelogSnapshot());
  });

  const publicMessage = (message, username = message.username) => ({
    id: message._id.toString(),
    username,
    text: message.text,
    createdAt: message.createdAt.toISOString()
  });
  app.get('/api/chat', async (req, res) => {
    const latest = await messages.find().sort({ createdAt: -1, _id: -1 }).limit(CHAT_HISTORY_LIMIT).toArray();
    const authorIds = [...new Map(latest.filter(message => message.userId)
      .map(message => [message.userId.toString(), message.userId])).values()];
    const authors = authorIds.length ? await users.find(
      { _id: { $in: authorIds } }, { projection: { username: 1 } }
    ).toArray() : [];
    const authorNames = new Map(authors.map(author => [author._id.toString(), author.username]));
    res.json({ messages: latest.reverse().map(message => publicMessage(
      message, authorNames.get(message.userId?.toString()) ?? message.username
    )) });
  });
  app.post('/api/chat', requireUser, rateLimit(12, 60 * 1000), async (req, res) => {
    const messageText = String(req.body?.text || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    if (!messageText || messageText.length > 400) return sendError(res, 400, 'Message must be 1–400 characters.');
    const last = await messages.findOne({ userId: req.user._id }, { sort: { createdAt: -1, _id: -1 } });
    if (last && Date.now() - last.createdAt.getTime() < 3000) {
      return sendError(res, 429, 'Please wait a few seconds before sending another message.');
    }
    const message = { userId: req.user._id, username: req.user.username, text: messageText, createdAt: new Date() };
    await messages.insertOne(message);
    await trimChatHistory(messages);
    res.status(201).json({ message: publicMessage(message) });
  });

  app.get(['/profile', '/profile/:username', '/settings', '/changelog', '/packs/test'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
  app.get('/packs', (req, res) => res.redirect(302, '/packs/test'));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((error, req, res, next) => {
    console.error(error);
    if (error instanceof SyntaxError && 'body' in error) return sendError(res, 400, 'Invalid request.');
    if (error.type === 'entity.too.large') return sendError(res, 413, 'The request is too large.');
    sendError(res, 500, 'Something went wrong. Please try again.');
  });

  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
  }, 60 * 60 * 1000).unref();
  return app;
}

async function start() {
  const store = await connectMongo();
  createApp(store).listen(PORT, () => console.log(`Pepper TCG running at http://localhost:${PORT}`));
}
if (require.main === module) start().catch(error => { console.error('Could not start Pepper TCG:', error.message); process.exitCode = 1; });
module.exports = { createApp, connectMongo, CLAIM_INTERVAL_MS, HOURLY_TOKEN_MIN, HOURLY_TOKEN_MAX };
