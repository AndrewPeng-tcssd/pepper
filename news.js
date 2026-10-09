const { ObjectId } = require('mongodb');
const { ModerationError } = require('./moderation');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (status, message) => { throw new ModerationError(status, message); };
const objectId = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) fail(400, 'Invalid entry.');
  return new ObjectId(value);
};
function decodeCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(value)) fail(400, 'Invalid comment cursor.');
  try {
    const [date, id, ...extra] = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (extra.length || typeof date !== 'string' || !/^[a-f0-9]{24}$/i.test(id) || !Number.isFinite(Date.parse(date))) throw new Error();
    return { createdAt: new Date(date), _id: new ObjectId(id) };
  } catch { fail(400, 'Invalid comment cursor.'); }
}

function registerNews(app, { users, changelog, announcements, newsComments, announcementSeen }, { requireUser, rateLimit, moderation, now = Date.now, publicAnnouncement }) {
  const parents = { announcements, changelog };
  async function publicAuthor(record, comment = false) {
    const accountId = record.authorAccountId;
    const userId = comment ? record.authorUserId : record.authorId;
    const author = accountId ? await users.findOne({ accountId }) : userId ? await users.findOne({ _id: userId }) : null;
    if (author) return moderation.publicPlayer(author);
    return { username: userId || accountId || comment ? 'Deleted player' : 'Unknown author', accountId: null, avatarUrl: '/favicon.svg', role: 'player', banned: false };
  }
  async function publicFields(kind, entry) {
    return { author: await publicAuthor(entry), commentCount: await newsComments.countDocuments({ kind, entryId: entry._id, deleted: { $ne: true } }) };
  }
  async function publicComment(comment) {
    return { id: comment._id.toString(), clientMessageId: comment.clientMessageId, author: await publicAuthor(comment, true),
      text: comment.deleted ? 'Comment deleted.' : comment.text, createdAt: comment.createdAt.toISOString(), deleted: comment.deleted === true };
  }
  async function existingParent(kind, id, session, lock = false) {
    const options = session ? { session } : {};
    const parent = lock ? await parents[kind].findOneAndUpdate({ _id: id }, { $inc: { commentRevision: 1 } }, { ...options, returnDocument: 'after' })
      : await parents[kind].findOne({ _id: id }, options);
    if (!parent) fail(404, 'Entry not found.');
    return parent;
  }
  async function cleanup(kind, entryId, session) {
    await newsComments.deleteMany({ kind, entryId }, { session });
    if (kind === 'announcements') await announcementSeen.deleteMany({ entryId }, { session });
  }
  async function markSeen(entryId, userId, session) {
    await announcementSeen.updateOne({ entryId, userId }, { $setOnInsert: { seenAt: new Date(now()) } }, { upsert: true, ...(session ? { session } : {}) });
  }

  app.get('/api/announcements/unseen', requireUser, async (req, res) => {
    const seen = await announcementSeen.distinct('entryId', { userId: req.user._id });
    const entries = await announcements.find({ _id: { $nin: seen } }).sort({ createdAt: -1, _id: -1 }).toArray();
    res.json({ entries: await Promise.all(entries.map(publicAnnouncement)) });
  });
  app.post('/api/announcements/:entryId/seen', requireUser, rateLimit(300, 60 * 1000), async (req, res) => {
    const entryId = objectId(req.params.entryId);
    await moderation.runAs(req.user._id, async ({ session, actor }) => {
      await existingParent('announcements', entryId, session, true);
      await markSeen(entryId, actor._id, session);
    });
    res.json({ ok: true });
  });

  for (const kind of ['announcements', 'changelog']) {
    app.get(`/api/${kind}/:entryId/comments`, async (req, res) => {
      const entryId = objectId(req.params.entryId);
      const cursor = decodeCursor(req.query.cursor);
      await existingParent(kind, entryId);
      const filter = { kind, entryId, ...(cursor ? { $or: [
        { createdAt: { $gt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $gt: cursor._id } }
      ] } : {}) };
      const comments = await newsComments.find(filter).sort({ createdAt: 1, _id: 1 }).limit(51).toArray();
      const more = comments.length > 50;
      if (more) comments.pop();
      const last = comments.at(-1);
      res.json({ comments: await Promise.all(comments.map(publicComment)), nextCursor: more ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last._id.toString()])).toString('base64url') : null });
    });
    app.post(`/api/${kind}/:entryId/comments`, requireUser, rateLimit(180, 60 * 1000), async (req, res) => {
      const entryId = objectId(req.params.entryId);
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      const clientMessageId = req.body?.clientMessageId;
      if (!text || text.length > 1000) fail(400, 'Comment must be 1–1,000 characters.');
      if (typeof clientMessageId !== 'string' || !UUID.test(clientMessageId)) fail(400, 'Invalid comment request.');
      let comment, created = false;
      await moderation.runAs(req.user._id, async ({ session, actor }) => {
        await existingParent(kind, entryId, session, true);
        const filter = { kind, entryId, authorUserId: actor._id, clientMessageId: clientMessageId.toLowerCase() };
        comment = await newsComments.findOne(filter, { session });
        if (comment) {
          if (!comment.deleted && comment.text !== text) fail(409, 'Comment request already used.');
          return;
        }
        const last = await newsComments.findOne({ authorUserId: actor._id }, { session, sort: { createdAt: -1, _id: -1 } });
        const remaining = last ? last.createdAt.getTime() + 1000 - now() : 0;
        if (remaining > 0) {
          const error = new ModerationError(429, 'Posting too quickly.'); error.retryAfterMs = remaining; throw error;
        }
        comment = { _id: new ObjectId(), ...filter, authorAccountId: actor.accountId, text, createdAt: new Date(now()), deleted: false };
        await newsComments.insertOne(comment, { session });
        created = true;
      });
      res.status(created ? 201 : 200).json({ comment: await publicComment(comment) });
    });
    app.delete(`/api/${kind}/:entryId/comments/:commentId`, requireUser, rateLimit(120, 60 * 1000), async (req, res) => {
      const entryId = objectId(req.params.entryId), commentId = objectId(req.params.commentId);
      const initial = await newsComments.findOne({ _id: commentId, kind, entryId });
      if (!initial) fail(404, 'Comment not found.');
      let comment;
      await moderation.runAs(req.user._id, async ({ session, actor, role, roleOf }) => {
        await existingParent(kind, entryId, session, true);
        comment = await newsComments.findOne({ _id: commentId, kind, entryId }, { session });
        if (!comment) fail(404, 'Comment not found.');
        const author = await users.findOne({ _id: comment.authorUserId }, { session });
        const own = comment.authorUserId.equals(actor._id);
        if (!own && role !== 'admin' && !(role === 'mod' && roleOf(author || { accountId: comment.authorAccountId }) === 'player')) fail(403, 'Action unavailable.');
        if (!comment.deleted) {
          await newsComments.updateOne({ _id: commentId }, { $set: { deleted: true, text: '', deletedAt: new Date(now()), deletedByAccountId: actor.accountId } }, { session });
          comment = { ...comment, deleted: true, text: '' };
        }
      }, initial.authorUserId ? [initial.authorUserId] : []);
      res.json({ comment: await publicComment(comment) });
    });
  }
  return { publicFields, cleanup, markSeen };
}

module.exports = { registerNews };
