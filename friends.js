const { ObjectId } = require('mongodb');
const { ModerationError } = require('./moderation');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACCOUNT_ID = /^PPR-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sameId = (a, b) => a?.toString() === b?.toString();
const participants = id => ({ $or: [{ senderUserId: id }, { recipientUserId: id }] });
const fail = (status, message) => { throw new ModerationError(status, message); };
const objectId = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) fail(400, 'Invalid friend request.');
  return new ObjectId(value);
};

function registerFriends(app, { users, friendships, friendMessages }, { requireUser, rateLimit, moderation, now = Date.now }) {
  const peerId = (friendship, userId) => sameId(friendship.senderUserId, userId) ? friendship.recipientUserId : friendship.senderUserId;
  async function playersFor(friendship, session) {
    const options = session ? { session } : {};
    const sender = await users.findOne({ _id: friendship.senderUserId }, options);
    const recipient = await users.findOne({ _id: friendship.recipientUserId }, options);
    if (!sender || !recipient) fail(404, 'Player unavailable.');
    return { sender, recipient };
  }
  async function publicRequest(friendship) {
    const players = await playersFor(friendship);
    return { id: friendship._id.toString(), sender: await moderation.publicPlayer(players.sender),
      recipient: await moderation.publicPlayer(players.recipient), status: friendship.status };
  }
  async function privateFriendship(id, userId, session) {
    const friendship = await friendships.findOne({ _id: id, ...participants(userId) }, session ? { session } : {});
    if (!friendship) fail(404, 'Friend request not found.');
    return friendship;
  }
  async function acceptedFriendship(id, userId, session) {
    const friendship = await privateFriendship(id, userId, session);
    if (friendship.status !== 'accepted') fail(403, 'Accept the friend request first.');
    const players = await playersFor(friendship, session);
    return { friendship, players };
  }
  async function publicMessage(message) {
    const sender = await users.findOne({ _id: message.senderUserId });
    if (!sender) fail(404, 'Player unavailable.');
    return { id: message._id.toString(), clientMessageId: message.clientMessageId,
      sender: await moderation.publicPlayer(sender), text: message.text, createdAt: message.createdAt.toISOString() };
  }

  app.get('/api/friends', requireUser, async (req, res) => {
    const entries = await friendships.find({ ...participants(req.user._id), status: { $in: ['pending', 'accepted'] } }).toArray();
    const friends = [], incoming = [], outgoing = [];
    for (const entry of entries) {
      const peer = await users.findOne({ _id: peerId(entry, req.user._id) });
      if (!peer) continue;
      if (entry.status === 'accepted') friends.push({ id: entry._id.toString(), player: await moderation.publicPlayer(peer) });
      else {
        const request = await publicRequest(entry);
        (sameId(entry.recipientUserId, req.user._id) ? incoming : outgoing).push(request);
      }
    }
    friends.sort((a, b) => a.player.username.toLowerCase().localeCompare(b.player.username.toLowerCase()) || a.id.localeCompare(b.id));
    const requestSort = (a, b) => {
      const aPeer = a.sender.accountId === req.user.accountId ? a.recipient : a.sender;
      const bPeer = b.sender.accountId === req.user.accountId ? b.recipient : b.sender;
      return aPeer.username.toLowerCase().localeCompare(bPeer.username.toLowerCase()) || a.id.localeCompare(b.id);
    };
    incoming.sort(requestSort); outgoing.sort(requestSort);
    res.json({ friends, incoming, outgoing });
  });

  app.post('/api/friends/requests', requireUser, rateLimit(60, 60 * 60 * 1000), async (req, res) => {
    const { recipientAccountId, clientRequestId } = req.body || {};
    if (typeof recipientAccountId !== 'string' || !ACCOUNT_ID.test(recipientAccountId)) fail(400, 'Choose a player first.');
    if (typeof clientRequestId !== 'string' || !UUID.test(clientRequestId)) fail(400, 'Invalid friend request.');
    const recipient = await users.findOne({ accountId: recipientAccountId.toUpperCase() });
    if (!recipient) fail(404, 'Player unavailable.');
    if (sameId(recipient._id, req.user._id)) fail(400, 'Choose another player.');
    const requestId = clientRequestId.toLowerCase();
    const requestKey = `${req.user._id}:${requestId}`;
    const pairKey = [req.user._id.toString(), recipient._id.toString()].sort().join(':');
    let friendship;
    let created = false;
    await moderation.runAs(req.user._id, async ({ session }) => {
      const peer = await users.findOne({ _id: recipient._id }, { session });
      if (!peer || peer.banned) fail(409, 'Player unavailable.');
      const replay = await friendships.findOne({ requestKeys: requestKey }, { session });
      if (replay) {
        if (replay.pairKey !== pairKey || replay.clientRequestId !== requestId || !sameId(replay.senderUserId, req.user._id)) fail(409, 'Friend request already used.');
        friendship = replay;
        return;
      }
      friendship = await friendships.findOne({ pairKey }, { session });
      if (friendship?.status === 'accepted') fail(409, 'Already friends.');
      if (friendship?.status === 'pending') fail(409, 'Friend request already pending.');
      const at = new Date(now());
      const fields = { senderUserId: req.user._id, recipientUserId: peer._id, clientRequestId: requestId,
        status: 'pending', createdAt: at, updatedAt: at };
      const requestKeys = [...(friendship?.requestKeys || []), requestKey];
      if (friendship) {
        await friendMessages.deleteMany({ friendshipId: friendship._id }, { session });
        await friendships.deleteOne({ _id: friendship._id }, { session });
      }
      friendship = { _id: new ObjectId(), pairKey, requestKeys, ...fields };
      await friendships.insertOne(friendship, { session });
      created = true;
    }, [recipient._id]);
    res.status(created ? 201 : 200).json({ request: await publicRequest(friendship) });
  });

  for (const [action, status] of [['accept', 'accepted'], ['deny', 'denied'], ['cancel', 'cancelled']]) {
    app.post(`/api/friends/requests/:id/${action}`, requireUser, rateLimit(120, 60 * 60 * 1000), async (req, res) => {
      const id = objectId(req.params.id);
      const initial = await privateFriendship(id, req.user._id);
      let friendship;
      await moderation.runAs(req.user._id, async ({ session }) => {
        friendship = await privateFriendship(id, req.user._id, session);
        if ((action === 'cancel') !== sameId(friendship.senderUserId, req.user._id)) fail(403, 'Action unavailable.');
        if (friendship.status === status) return;
        if (friendship.status !== 'pending') fail(409, 'Friend request already answered.');
        if (action === 'accept') {
          const { sender, recipient } = await playersFor(friendship, session);
          if (sender.banned || recipient.banned) fail(409, 'Player unavailable.');
        }
        await friendships.updateOne({ _id: id, status: 'pending' }, { $set: { status, updatedAt: new Date(now()) } }, { session });
        friendship.status = status;
      }, [peerId(initial, req.user._id)]);
      res.json({ request: await publicRequest(friendship) });
    });
  }

  app.get('/api/friends/:id/messages', requireUser, async (req, res) => {
    const { friendship, players } = await acceptedFriendship(objectId(req.params.id), req.user._id);
    const messages = await friendMessages.find({ friendshipId: friendship._id }).sort({ createdAt: -1, _id: -1 }).limit(100).toArray();
    const peer = sameId(players.sender._id, req.user._id) ? players.recipient : players.sender;
    res.json({ messages: await Promise.all(messages.reverse().map(publicMessage)), friend: {
      id: friendship._id.toString(), player: await moderation.publicPlayer(peer)
    } });
  });

  app.post('/api/friends/:id/messages', requireUser, rateLimit(180, 60 * 1000), async (req, res) => {
    const id = objectId(req.params.id);
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const clientMessageId = req.body?.clientMessageId;
    if (!text || text.length > 1000) fail(400, 'Message must be 1–1,000 characters.');
    if (typeof clientMessageId !== 'string' || !UUID.test(clientMessageId)) fail(400, 'Invalid message request.');
    const initial = await privateFriendship(id, req.user._id);
    let message;
    let created = false;
    await moderation.runAs(req.user._id, async ({ session, actor }) => {
      const { players } = await acceptedFriendship(id, actor._id, session);
      if (players.sender.banned || players.recipient.banned) fail(409, 'Player unavailable.');
      const filter = { friendshipId: id, senderUserId: actor._id, clientMessageId: clientMessageId.toLowerCase() };
      message = await friendMessages.findOne(filter, { session });
      if (message) {
        if (message.text !== text) fail(409, 'Message request already used.');
        return;
      }
      const last = await friendMessages.findOne({ senderUserId: actor._id }, { session, sort: { createdAt: -1, _id: -1 } });
      const remaining = last ? last.createdAt.getTime() + 1000 - now() : 0;
      if (remaining > 0) {
        const error = new ModerationError(429, 'Sending too quickly.');
        error.retryAfterMs = remaining;
        throw error;
      }
      message = { _id: new ObjectId(), ...filter, text, createdAt: new Date(now()) };
      await friendMessages.insertOne(message, { session });
      created = true;
    }, [peerId(initial, req.user._id)]);
    res.status(created ? 201 : 200).json({ message: await publicMessage(message) });
  });
}

module.exports = { registerFriends };
