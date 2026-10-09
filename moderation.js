const { ObjectId } = require('mongodb');
const { resolveChangelogOwner } = require('./mongo');
const { avatarUrl } = require('./accounts');
const { cancelGamesForPlayer } = require('./games');

const ACCOUNT_ID = /^PPR-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
class ModerationError extends Error {
  constructor(status, message, banned = false) { super(message); this.status = status; this.banned = banned; }
}

function createModeration(store, { now = Date.now } = {}) {
  const { client, users, siteSettings, sessions, verificationTokens, messages, trades } = store;
  let ownerAccountId = null;
  async function owner() {
    if (!ownerAccountId) ownerAccountId = await resolveChangelogOwner(users, siteSettings);
    return ownerAccountId;
  }
  const protectedAdmin = (user, ownerId) => Boolean(user?.accountId && user.accountId === ownerId);
  const role = (user, ownerId) => protectedAdmin(user, ownerId) ? 'admin' : ['mod', 'senior_mod', 'admin'].includes(user?.role) ? user.role : 'player';
  async function publicFields(user) {
    const ownerId = await owner();
    return { role: role(user, ownerId), banned: user?.banned === true, protectedAdmin: protectedAdmin(user, ownerId) };
  }
  async function publicPlayer(user) {
    return { username: user.username, accountId: user.accountId, avatarUrl: avatarUrl(user), ...await publicFields(user) };
  }
  async function lockUsers(ids, session) {
    const unique = [...new Map(ids.filter(Boolean).map(id => [id.toString(), id])).values()];
    for (const id of unique.sort((a, b) => a.toString().localeCompare(b.toString()))) {
      await users.updateOne({ _id: id }, { $inc: { activityRevision: 1 } }, { session });
    }
  }
  async function runAs(actorId, callback, targetIds = []) {
    const ownerId = await owner();
    try {
      return await client.withSession(session => session.withTransaction(async () => {
        await lockUsers([actorId, ...targetIds], session);
        const actor = await users.findOne({ _id: actorId }, { session });
        if (!actor) throw new ModerationError(401, 'Sign in required.');
        if (actor.banned) throw new ModerationError(403, 'Account banned.', true);
        return callback({ session, actor, role: role(actor, ownerId), roleOf: user => role(user, ownerId), protectedOf: user => protectedAdmin(user, ownerId) });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' }));
    } catch (error) {
      if ([20, 303].includes(error.code) || [20, 303].includes(error.originalError?.code)) throw new ModerationError(503, 'Moderation unavailable. Try later.');
      throw error;
    }
  }
  function register(app, { requireUser, rateLimit }) {
    app.get('/api/moderation/players', requireUser, async (req, res) => {
      if (!['admin', 'senior_mod', 'mod'].includes((await publicFields(req.user)).role)) throw new ModerationError(403, 'Moderation access required.');
      const query = typeof req.query.username === 'string' ? req.query.username.trim() : '';
      if (query && !/^[a-zA-Z0-9_]{1,24}$/.test(query)) throw new ModerationError(400, 'Enter a valid username.');
      const people = await users.find(query ? { usernameKey: { $regex: `^${query.toLowerCase()}` } } : {}, {
        projection: { username: 1, accountId: 1, avatarVersion: 1, role: 1, banned: 1 }
      }).sort({ usernameKey: 1, _id: 1 }).limit(25).toArray();
      res.json({ players: await Promise.all(people.map(publicPlayer)) });
    });
    app.patch('/api/moderation/players/:accountId', requireUser, rateLimit(60, 60 * 1000), async (req, res) => {
      if (!ACCOUNT_ID.test(req.params.accountId)) throw new ModerationError(400, 'Invalid account.');
      const payload = req.body || {};
      const keys = Object.keys(payload);
      const changingRole = keys.length === 1 && keys[0] === 'role' && ['player', 'mod', 'senior_mod', 'admin'].includes(payload.role);
      const changingBan = keys.length === 1 && keys[0] === 'banned' && typeof payload.banned === 'boolean';
      if (!changingRole && !changingBan) throw new ModerationError(400, 'Choose one valid action.');
      const target = await users.findOne({ accountId: req.params.accountId.toUpperCase() });
      if (!target) throw new ModerationError(404, 'Player not found.');
      const player = await runAs(req.user._id, async ({ session, actor, role: actorRole, roleOf, protectedOf }) => {
        const current = await users.findOne({ _id: target._id }, { session });
        if (!current) throw new ModerationError(404, 'Player not found.');
        const targetRole = roleOf(current);
        if (protectedOf(current) || current._id.equals(actor._id)) throw new ModerationError(403, 'Action unavailable.');
        if (changingRole) {
          if (actorRole !== 'admin' && !(actorRole === 'senior_mod' && targetRole === 'mod' && payload.role === 'player')) throw new ModerationError(403, 'Action unavailable.');
          await users.updateOne({ _id: current._id }, { $set: { role: payload.role } }, { session });
          current.role = payload.role;
        } else {
          if (actorRole !== 'admin' && !(actorRole === 'senior_mod' && ['player', 'mod'].includes(targetRole)) && !(actorRole === 'mod' && targetRole === 'player')) throw new ModerationError(403, 'Action unavailable.');
          if (payload.banned) {
            await cancelGamesForPlayer(store, current._id, session, new Date(now()), 'account-banned');
            await trades.updateMany({ $or: [{ senderUserId: current._id }, { recipientUserId: current._id }], status: { $in: ['pending', 'negotiating'] } }, {
              $set: { status: 'cancelled', senderConfirmed: false, recipientConfirmed: false, updatedAt: new Date(now()) }, $inc: { version: 1 }
            }, { session });
            await sessions.updateMany({ userId: current._id }, { $set: { banned: true } }, { session });
            await verificationTokens.deleteMany({ userId: current._id }, { session });
          }
          await users.updateOne({ _id: current._id }, {
            $set: { banned: payload.banned, bannedAt: payload.banned ? new Date(now()) : null, bannedByAccountId: payload.banned ? actor.accountId : null }
          }, { session });
          current.banned = payload.banned;
        }
        return current;
      }, [target._id]);
      res.json({ player: await publicPlayer(player) });
    });
    app.delete('/api/chat/:id', requireUser, rateLimit(60, 60 * 1000), async (req, res) => {
      if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw new ModerationError(400, 'Invalid message.');
      const saved = await messages.findOne({ _id: new ObjectId(req.params.id) });
      if (!saved) throw new ModerationError(404, 'Message not found.');
      await runAs(req.user._id, async ({ session, actor, role: actorRole, roleOf }) => {
        const current = await messages.findOne({ _id: saved._id }, { session });
        if (!current) throw new ModerationError(404, 'Message not found.');
        const author = current.userId ? await users.findOne({ _id: current.userId }, { session }) : null;
        const own = current.userId?.equals(actor._id) === true;
        const authorRole = roleOf(author || { accountId: current.accountId });
        if (actorRole !== 'admin' && !(actorRole === 'senior_mod' && (own || ['player', 'mod'].includes(authorRole))) && !(actorRole === 'mod' && (own || authorRole === 'player'))) throw new ModerationError(403, 'Action unavailable.');
        await messages.updateOne({ _id: current._id }, {
          $set: { text: 'Message deleted.', deleted: true, deletedAt: new Date(now()), deletedByAccountId: actor.accountId, replyTo: null }
        }, { session });
        await messages.updateMany({ 'replyTo.id': current._id }, { $set: { 'replyTo.text': 'Message deleted.', 'replyTo.deleted': true } }, { session });
      }, saved.userId ? [saved.userId] : []);
      res.json({ ok: true });
    });
  }
  return { publicFields, publicPlayer, runAs, lockUsers, register };
}

module.exports = { createModeration, ModerationError };
