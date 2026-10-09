const crypto = require('node:crypto');
const sharp = require('sharp');

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const DEFAULT_AVATAR_URL = '/favicon.svg';
const ACCOUNT_ID = /^PPR-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const avatarUrl = user => user?.avatarVersion && user?.accountId
  ? `/api/avatars/${encodeURIComponent(user.accountId)}?v=${encodeURIComponent(user.avatarVersion)}` : DEFAULT_AVATAR_URL;
const transactionsUnavailable = error => [20, 303].includes(error.code) || [20, 303].includes(error.originalError?.code);

class AccountError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function atomic(client, callback) {
  return client.withSession(session => session.withTransaction(() => callback(session), {
    readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary'
  }));
}

// New records must conflict with deletion's user write, including requests made
// by another player. Standalone databases cannot delete accounts atomically.
async function withAccountActivity({ client, users }, ids, callback) {
  const unique = [...new Map(ids.map(id => [id.toString(), id])).values()];
  const work = async session => {
    const options = session ? { session } : {};
    for (const id of unique.sort((a, b) => a.toString().localeCompare(b.toString()))) {
      const result = await users.updateOne({ _id: id, banned: { $ne: true } }, { $inc: { activityRevision: 1 } }, options);
      if (!result.matchedCount) {
        const user = await users.findOne({ _id: id }, options);
        const actorBanned = user?.banned === true && id.toString() === ids[0]?.toString();
        const error = new AccountError(actorBanned ? 403 : 409, actorBanned ? 'Account banned.' : 'Player unavailable.');
        error.banned = actorBanned;
        throw error;
      }
    }
    return callback(session);
  };
  try { return await atomic(client, work); }
  catch (error) {
    if (transactionsUnavailable(error)) return work(null);
    throw error;
  }
}

async function sanitizeAvatar(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 40) {
    throw new AccountError(400, 'Choose an image under 2MB.');
  }
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new AccountError(400, 'Use PNG, JPG, or WebP.');
  const input = Buffer.from(match[2], 'base64');
  if (!input.length || input.length > MAX_AVATAR_BYTES || input.toString('base64') !== match[2]) {
    throw new AccountError(400, 'Choose an image under 2MB.');
  }
  const signatures = {
    png: input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    jpeg: input.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
    webp: input.subarray(0, 4).toString() === 'RIFF' && input.subarray(8, 12).toString() === 'WEBP'
  };
  if (!signatures[match[1]]) throw new AccountError(400, 'Choose a valid image.');
  try {
    const image = sharp(input, { failOn: 'warning', limitInputPixels: 16_000_000 });
    const metadata = await image.metadata();
    if (metadata.format !== match[1] || !metadata.width || !metadata.height || (metadata.pages || 1) !== 1) {
      throw new Error('Unsupported image');
    }
    // Re-encoding removes uploaded metadata and any trailing payload.
    return await image.rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
  } catch { throw new AccountError(400, 'Choose a valid image.'); }
}

function registerAccountFeatures(app, store, { requireUser, rateLimit, signedInUser, passwordMatches, cookieName, now = Date.now }) {
  const { client, users, sessions, verificationTokens, messages, trades, tradeMessages, cardInstances } = store;
  const route = handler => async (req, res, next) => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof AccountError) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };

  app.get('/api/avatars/:accountId', route(async (req, res) => {
    if (!ACCOUNT_ID.test(req.params.accountId)) throw new AccountError(404, 'Picture not found.');
    const user = await users.findOne({ accountId: req.params.accountId.toUpperCase() }, { projection: { avatarData: 1 } });
    if (!user?.avatarData) throw new AccountError(404, 'Picture not found.');
    const data = Buffer.isBuffer(user.avatarData) ? user.avatarData : Buffer.from(user.avatarData.buffer);
    res.set('Content-Type', 'image/webp');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(data);
  }));

  app.put('/api/account/avatar', requireUser, rateLimit(20, 15 * 60 * 1000), route(async (req, res) => {
    const avatarData = await sanitizeAvatar(req.body?.imageDataUrl);
    const user = await users.findOneAndUpdate({ _id: req.user._id, banned: { $ne: true } }, {
      $set: { avatarData, avatarVersion: crypto.randomUUID() }
    }, { returnDocument: 'after' });
    if (!user) throw new AccountError(401, 'Sign in required.');
    res.json({ user: await signedInUser(user) });
  }));

  app.delete('/api/account/avatar', requireUser, rateLimit(20, 15 * 60 * 1000), route(async (req, res) => {
    const user = await users.findOneAndUpdate({ _id: req.user._id, banned: { $ne: true } }, {
      $unset: { avatarData: '', avatarVersion: '' }
    }, { returnDocument: 'after' });
    if (!user) throw new AccountError(401, 'Sign in required.');
    res.json({ user: await signedInUser(user) });
  }));

  app.delete('/api/account', requireUser, rateLimit(5, 15 * 60 * 1000), route(async (req, res) => {
    if (req.body?.confirmation !== 'DELETE') throw new AccountError(400, 'Confirm account deletion.');
    const password = req.body?.currentPassword;
    if (typeof password !== 'string' || password.length > 128 || !passwordMatches(password, req.user.passwordHash)) {
      throw new AccountError(403, 'Incorrect current password.');
    }
    try {
      await atomic(client, async session => {
        await require('./games').cancelGamesForAccount(store, req.user._id, session, new Date(now()));
        const deleted = await users.deleteOne({ _id: req.user._id, passwordHash: req.user.passwordHash, banned: { $ne: true } }, { session });
        if (!deleted.deletedCount) throw new AccountError(409, 'Account changed. Try again.');
        const participant = { $or: [{ senderUserId: req.user._id }, { recipientUserId: req.user._id }] };
        await trades.updateMany({ ...participant, status: { $in: ['pending', 'negotiating'] } }, {
          $set: { status: 'cancelled', senderConfirmed: false, recipientConfirmed: false, updatedAt: new Date() }, $inc: { version: 1 }
        }, { session });
        await trades.updateMany({ senderUserId: req.user._id }, { $set: { senderUsername: 'Deleted player' } }, { session });
        await trades.updateMany({ recipientUserId: req.user._id }, { $set: { recipientUsername: 'Deleted player' } }, { session });
        await cardInstances.deleteMany({ ownerUserId: req.user._id }, { session });
        await sessions.deleteMany({ userId: req.user._id }, { session });
        await verificationTokens.deleteMany({ userId: req.user._id }, { session });
        await messages.deleteMany({ userId: req.user._id }, { session });
        await messages.updateMany({ 'replyTo.userId': req.user._id }, {
          $set: { 'replyTo.username': 'Deleted player', 'replyTo.text': 'Message deleted.' }
        }, { session });
        // Keep the partner's transaction history and chat receipts without the
        // deleted player's authored content or former display name.
        await tradeMessages.updateMany({ senderUserId: req.user._id }, {
          $set: { senderUsername: 'Deleted player', body: 'Message deleted.' }
        }, { session });
      });
    } catch (error) {
      if (transactionsUnavailable(error)) throw new AccountError(503, 'Account deletion unavailable. Try later.');
      throw error;
    }
    res.set('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.json({ ok: true });
  }));
}

module.exports = { avatarUrl, DEFAULT_AVATAR_URL, MAX_AVATAR_BYTES, AccountError, withAccountActivity, registerAccountFeatures, sanitizeAvatar };
