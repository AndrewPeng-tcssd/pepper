(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const friends = {
    identity: null, revision: 0, navigation: -1, entries: [], incoming: [], outgoing: [], loaded: false,
    listRevision: 0, loadRequest: null, action: null, requestDraft: null, selectedId: null,
    chatRevision: 0, chatLoadRequest: null, messages: [], outbox: [], sending: null,
    listSignature: null, chatSignature: null, readRequest: null, readSnapshots: {}, drafts: {}, requestedId: null
  };
  let retryTimer;
  const signedIn = () => !!state.user && friends.identity === state.user.accountId && !accountBanned && !state.user.banned;
  const active = () => signedIn() && pageKind === 'friends';
  const busy = () => !!friends.action || state.accountSubmitting;
  const current = (identity, revision, identityRevision) => signedIn() && friends.identity === identity && friends.revision === revision && userIdentityRevision === identityRevision;
  const selectedFriend = () => friends.entries.find(friend => friend.id === friends.selectedId);
  const picker = window.PepperPlayerPicker?.attach({
    input: el('friendUsername'),
    isEnabled: () => active() && !busy(),
    renderAvatar: player => profileAvatar(player),
    search: async prefix => {
      const identity = friends.identity, revision = friends.revision, identityRevision = userIdentityRevision, navigation = routeRevision;
      const data = await api(`players?username=${encodeURIComponent(prefix)}`);
      return current(identity, revision, identityRevision) && navigation === routeRevision && active() ? data.players : [];
    },
    onSelect: () => { friends.requestDraft = null; message(el('friendRequestMessage'), ''); }
  });
  function playerLink(player, className = 'player-identity') {
    const link = document.createElement('a'); link.className = className; link.href = profileHref(player.username);
    const name = document.createElement('span'); name.textContent = player.username;
    link.append(profileAvatar(player, 'player-avatar', true), name, playerRoleBadges(player)); return link;
  }
  function button(label, action, id, disabled = busy()) {
    const control = document.createElement('button'); control.type = 'button'; control.className = 'button'; control.textContent = label;
    control.dataset.friendAction = action; control.dataset.friendId = id; control.disabled = disabled; return control;
  }
  function sortFriends(entries) {
    return entries.slice().sort((a, b) => (Number(b.unreadCount > 0) - Number(a.unreadCount > 0)) ||
      ((Date.parse(b.lastMessage?.createdAt) || 0) - (Date.parse(a.lastMessage?.createdAt) || 0)) ||
      a.player.username.localeCompare(b.player.username, undefined, { sensitivity: 'base' }));
  }
  const messageOrder = (a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id.localeCompare(b.id);
  function friendRow(friend, conversation = false) {
    const row = button('', 'open', friend.id, state.accountSubmitting);
    row.className = `friends-list-row${conversation ? ' friend-conversation-row' : ''}`;
    row.setAttribute('aria-pressed', String(friend.id === friends.selectedId));
    row.setAttribute('aria-current', String(friend.id === friends.selectedId));
    const label = [`Message ${friend.player.username}`];
    const identity = document.createElement('span'); identity.className = 'friend-row-identity';
    const details = document.createElement('span'); details.className = 'friend-row-details';
    const name = document.createElement('span'); name.className = 'friend-row-name';
    const username = document.createElement('span'); username.textContent = friend.player.username;
    name.append(username, playerRoleBadges(friend.player)); details.append(name);
    if (conversation) {
      const preview = document.createElement('span'); preview.className = 'friend-last-message';
      preview.textContent = friend.lastMessage ? `${friend.lastMessage.sender?.accountId === friends.identity ? 'You: ' : ''}${friend.lastMessage.text}` : 'No messages yet.';
      details.append(preview); label.push(preview.textContent);
    }
    identity.append(profileAvatar(friend.player, 'player-avatar', true), details); row.append(identity);
    const meta = document.createElement('span'); meta.className = 'friend-row-meta';
    if (conversation && friend.lastMessage) {
      const date = document.createElement('time'); date.className = 'friend-last-message-date';
      date.dateTime = friend.lastMessage.createdAt;
      const timestamp = new Date(friend.lastMessage.createdAt);
      date.textContent = timestamp.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      date.title = timestamp.toLocaleString(); meta.append(date); label.push(date.textContent);
    }
    if (friend.unreadCount > 0) {
      const count = document.createElement('span'); count.className = 'friend-unread'; count.textContent = String(friend.unreadCount);
      count.setAttribute('aria-label', `${friend.unreadCount} unread messages`); meta.append(count); label.push(`${friend.unreadCount} unread messages`);
    }
    row.setAttribute('aria-label', label.join(', '));
    row.append(meta); return row;
  }
  function renderLists() {
    const signature = JSON.stringify([friends.entries, friends.incoming, friends.outgoing, friends.selectedId, busy()]);
    if (signature === friends.listSignature) return;
    friends.listSignature = signature;
    const focused = document.activeElement?.closest('[data-friend-action]'), renderedControls = [];
    el('friendsEmpty').hidden = friends.entries.length > 0;
    const entries = sortFriends(friends.entries);
    el('friendConversationsEmpty').hidden = entries.length > 0;
    for (const [id, list, conversation] of [['friendConversations', entries, true], ['friendsList', entries, false]]) {
      const rows = list.map(friend => friendRow(friend, conversation)); renderedControls.push(...rows); el(id).replaceChildren(...rows);
    }
    for (const [id, emptyId, entries, incoming] of [
      ['friendIncoming', 'friendRequestsEmpty', friends.incoming, true],
      ['friendOutgoing', 'friendOutgoingEmpty', friends.outgoing, false]
    ]) {
      el(emptyId).hidden = entries.length > 0;
      el(id).replaceChildren(...entries.map(request => {
        const row = document.createElement('article'); row.className = 'friend-request-row';
        const actions = document.createElement('div'); actions.className = 'friend-row-actions';
        const controls = incoming ? [button('Accept', 'accept', request.id), button('Deny', 'deny', request.id)] : [button('Cancel', 'cancel', request.id)];
        renderedControls.push(...controls); actions.append(...controls);
        row.append(playerLink(incoming ? request.sender : request.recipient), actions); return row;
      }));
    }
    if (focused) {
      const next = renderedControls.find(control => control.dataset.friendAction === focused.dataset.friendAction && control.dataset.friendId === focused.dataset.friendId &&
        (control.className.includes('friend-conversation-row') === focused.className.includes('friend-conversation-row')));
      if (next && !next.disabled) next.focus({ preventScroll: true });
    }
  }
  function renderChat() {
    const friend = selectedFriend();
    el('friendInbox').hidden = !!friend; el('friendChatContent').hidden = !friend;
    el('friendChatBack').hidden = !friend; el('friendChatBack').disabled = !active() || state.accountSubmitting;
    el('friendChatInput').disabled = !active() || !friend || friend.player.banned || state.accountSubmitting;
    el('friendChatSend').disabled = !active() || !friend || friend.player.banned || state.accountSubmitting;
    if (!friend) { el('friendChatPlayer').replaceChildren(); el('friendChatMessages').replaceChildren(); return; }
    if (friend.player.banned) message(el('friendChatMessage'), 'Player unavailable.');
    else if (el('friendChatMessage').textContent === 'Player unavailable.') message(el('friendChatMessage'), '');
    const ownPending = friends.outbox.filter(entry => entry.friendId === friend.id);
    const entries = [...friends.messages, ...ownPending];
    const signature = JSON.stringify([friend, entries, !entries.length && !!friends.chatLoadRequest, state.accountSubmitting]);
    if (signature === friends.chatSignature) return;
    const container = el('friendChatMessages');
    const followLatest = friends.chatSignature === null || container.scrollHeight - container.scrollTop - container.clientHeight < 48;
    const previousScroll = container.scrollTop;
    friends.chatSignature = signature;
    el('friendChatPlayer').replaceChildren(playerLink(friend.player));
    if (!entries.length) {
      const empty = document.createElement('p'); empty.className = 'chat-empty';
      empty.textContent = friends.chatLoadRequest ? 'Loading messages…' : 'No messages yet.'; container.replaceChildren(empty);
    } else container.replaceChildren(...entries.map(item => {
      const row = document.createElement('article'); row.className = 'friend-chat-row'; row.dataset.messageId = item.id;
      if (item.sender.accountId === friends.identity) row.classList.add('friend-chat-own');
      if (item.status === 'pending') row.classList.add('friend-chat-pending');
      const text = document.createElement('p'); text.className = 'friend-chat-text'; text.textContent = item.text;
      const date = document.createElement('time'); date.className = 'friend-chat-time'; date.dateTime = item.createdAt;
      date.textContent = new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      row.append(playerLink(item.sender, 'friend-chat-author player-identity'), text, date);
      if (item.status) {
        const status = document.createElement('span'); status.className = 'chat-message-status'; status.setAttribute('role', 'status');
        status.textContent = item.status === 'pending' ? 'Sending…' : item.error || 'Not sent.'; row.append(status);
        if (item.status === 'failed') row.append(button('Retry', 'retry-message', item.clientMessageId, !active() || state.accountSubmitting));
      }
      return row;
    }));
    if (followLatest) container.scrollTop = container.scrollHeight;
    else container.scrollTop = previousScroll;
  }
  function render() {
    const checking = document.body.classList.contains('auth-loading');
    el('friendsLoading').hidden = !checking && (!signedIn() || friends.loaded);
    el('friendsGuest').hidden = checking || signedIn(); el('friendsAccount').hidden = checking || !signedIn();
    el('friendsRefresh').disabled = !active() || !!friends.loadRequest || busy();
    el('friendUsername').disabled = !active() || busy(); el('friendRequestSend').disabled = !active() || busy();
    el('friendRequestSend').textContent = friends.action?.action === 'request' ? 'Sending…' : friends.requestDraft?.uncertain ? 'Retry request' : 'Send request';
    if (!active() || busy()) picker?.close();
    renderLists(); renderChat();
  }
  function clearConversation() {
    if (friends.selectedId) friends.drafts[friends.selectedId] = el('friendChatInput').value;
    friends.selectedId = null; friends.messages = []; friends.chatRevision++;
    friends.chatLoadRequest = null; friends.chatSignature = null; friends.readRequest = null;
    el('friendChatInput').value = ''; message(el('friendChatMessage'), '');
  }
  function syncUser() {
    const identity = state.user?.accountId || null;
    if (identity !== friends.identity || !signedIn()) {
      window.clearTimeout(retryTimer); retryTimer = undefined; picker?.reset();
      Object.assign(friends, {
        identity, revision: friends.revision + 1, entries: [], incoming: [], outgoing: [], loaded: false,
        listRevision: friends.listRevision + 1, loadRequest: null, action: null, requestDraft: null,
        chatRevision: friends.chatRevision + 1, chatLoadRequest: null, messages: [], outbox: [], sending: null,
        selectedId: null, listSignature: null, chatSignature: null, readRequest: null, readSnapshots: {}, drafts: {},
        requestedId: requestedConversation()
      });
      el('friendUsername').value = ''; el('friendChatInput').value = '';
      for (const id of ['friendsMessage', 'friendRequestMessage', 'friendChatMessage']) message(el(id), '');
    }
    render();
    if (active()) { void load(); void sendNext(); }
  }
  async function load() {
    if (!active() || friends.loadRequest || friends.action || state.accountSubmitting) return;
    const identity = friends.identity, revision = friends.revision, identityRevision = userIdentityRevision;
    const navigation = routeRevision, listRevision = friends.listRevision, request = {};
    friends.loadRequest = request; render();
    const live = () => current(identity, revision, identityRevision) && navigation === routeRevision && active() && friends.loadRequest === request && listRevision === friends.listRevision;
    try {
      const data = await api('friends');
      if (!live()) return;
      friends.entries = sortFriends(data.friends); friends.incoming = data.incoming; friends.outgoing = data.outgoing; friends.loaded = true;
      if (friends.selectedId && !selectedFriend()) clearConversation();
      message(el('friendsMessage'), '');
      if (friends.requestedId) {
        const id = friends.requestedId; friends.requestedId = null; openConversation(id);
      }
    } catch (error) {
      if (!live()) return;
      if (error.status === 401) { setUser(null); return; }
      friends.loaded = true; message(el('friendsMessage'), 'Friends unavailable. Try again.');
    } finally {
      if (friends.loadRequest === request) { friends.loadRequest = null; render(); }
    }
  }
  async function perform(operation) {
    if (!active() || busy()) return;
    const identity = friends.identity, revision = friends.revision, identityRevision = userIdentityRevision, navigation = routeRevision;
    friends.action = operation; friends.listRevision++; friends.loadRequest = null; picker?.close(); render();
    const target = el(operation.action === 'request' ? 'friendRequestMessage' : 'friendsMessage');
    message(target, operation.action === 'request' ? 'Sending request…' : 'Saving…');
    try {
      await api(operation.action === 'request' ? 'friends/requests' : `friends/requests/${encodeURIComponent(operation.id)}/${operation.action}`, { method: 'POST', body: JSON.stringify(operation.payload || {}) });
      if (!current(identity, revision, identityRevision)) return;
      friends.listRevision++;
      if (operation.action === 'request') friends.requestDraft = null;
      if (navigation === routeRevision && active()) {
        if (operation.action === 'request') el('friendUsername').value = '';
        message(target, operation.action === 'request' ? 'Request sent.' : operation.action === 'accept' ? 'Friend added.' : operation.action === 'deny' ? 'Request denied.' : 'Request cancelled.', true);
      }
    } catch (error) {
      if (!current(identity, revision, identityRevision)) return;
      if (error.status === 401) { setUser(null); return; }
      if (operation.action === 'request') {
        if (!error.status || error.status >= 500) friends.requestDraft.uncertain = true;
        else friends.requestDraft = null;
      }
      if (navigation === routeRevision && active()) message(target, !error.status || error.status >= 500 ? 'Connection lost. Try again.' : error.message);
    } finally {
      if (current(identity, revision, identityRevision) && friends.action === operation) { friends.action = null; render(); void load(); }
    }
  }
  async function requestFriend(event) {
    event.preventDefault(); picker?.close();
    if (!active() || busy()) return;
    const username = el('friendUsername').value.trim();
    if (!/^[a-zA-Z0-9_]{1,24}$/.test(username)) { message(el('friendRequestMessage'), 'Enter a username.'); return; }
    if (friends.requestDraft?.uncertain && friends.requestDraft.username.toLowerCase() === username.toLowerCase()) {
      await perform({ action: 'request', payload: friends.requestDraft.payload }); return;
    }
    const identity = friends.identity, revision = friends.revision, identityRevision = userIdentityRevision, navigation = routeRevision, lookup = { action: 'request' };
    friends.action = lookup; message(el('friendRequestMessage'), 'Finding player…'); render();
    try {
      const data = await api(`profiles/${encodeURIComponent(username)}`);
      if (!current(identity, revision, identityRevision) || navigation !== routeRevision || !active()) return;
      if (data.profile.accountId === identity) { message(el('friendRequestMessage'), 'Choose another player.'); return; }
      if (data.profile.banned) { message(el('friendRequestMessage'), 'Player unavailable.'); return; }
      const payload = { recipientAccountId: data.profile.accountId, clientRequestId: crypto.randomUUID() };
      friends.requestDraft = { username, payload, uncertain: false }; friends.action = null;
      await perform({ action: 'request', payload });
    } catch (error) {
      if (!current(identity, revision, identityRevision) || navigation !== routeRevision || !active()) return;
      if (error.status === 401) setUser(null); else message(el('friendRequestMessage'), error.message);
    } finally {
      if (current(identity, revision, identityRevision) && friends.action === lookup) { friends.action = null; render(); }
    }
  }
  function openConversation(id) {
    if (!active() || state.accountSubmitting || !friends.entries.some(friend => friend.id === id)) return;
    if (friends.selectedId !== id) { clearConversation(); friends.selectedId = id; el('friendChatInput').value = friends.drafts[id] || ''; }
    render(); void loadMessages();
    el('friendChatInput').focus({ preventScroll: true });
  }
  function closeConversation() {
    if (!active() || state.accountSubmitting) return;
    const id = friends.selectedId;
    friends.requestedId = null; clearConversation(); render();
    if (new URLSearchParams(window.location.search).has('conversation')) navigateTo('/friends', { replace: true, focus: false, scroll: false });
    const row = Array.from(el('friendConversations').children).find(control => control.dataset.friendId === id);
    (row || el('friendChatTitle')).focus({ preventScroll: true });
  }
  function reconcileMessages(messages) {
    friends.messages = messages.slice().sort(messageOrder).slice(-100);
    const receipts = new Set(messages.filter(item => item.sender.accountId === friends.identity).map(item => item.clientMessageId).filter(Boolean));
    friends.outbox = friends.outbox.filter(entry => entry.friendId !== friends.selectedId || !receipts.has(entry.clientMessageId));
  }
  async function markRead() {
    if (!active() || document.hidden || !selectedFriend() || friends.readRequest) return;
    const last = friends.messages.at(-1), id = friends.selectedId;
    if (!last || friends.readSnapshots[id] === last.id) return;
    const identity = friends.identity, revision = friends.revision, identityRevision = userIdentityRevision;
    const navigation = routeRevision, chatRevision = friends.chatRevision, request = {};
    friends.readRequest = request;
    const live = () => current(identity, revision, identityRevision) && navigation === routeRevision && active() &&
      id === friends.selectedId && chatRevision === friends.chatRevision && friends.readRequest === request;
    let acknowledged = false;
    try {
      const data = await api(`friends/${encodeURIComponent(id)}/read`, { method: 'POST', body: JSON.stringify({ messageId: last.id }) });
      if (!live() || data.friend?.id !== id) return;
      friends.readSnapshots[id] = last.id; acknowledged = true;
      friends.listRevision++; friends.loadRequest = null;
      friends.entries = sortFriends(friends.entries.map(friend => friend.id === id ? data.friend : friend));
      renderLists(); window.PepperNotifications?.load();
    } catch (error) {
      if (live() && error.status === 401) setUser(null);
    } finally {
      const retry = acknowledged && live() && friends.messages.at(-1)?.id !== last.id;
      if (friends.readRequest === request) { friends.readRequest = null; if (retry) void markRead(); }
    }
  }
  async function loadMessages() {
    if (!active() || !selectedFriend() || selectedFriend().player.banned || friends.chatLoadRequest) return;
    const identity = friends.identity, revision = friends.revision, identityRevision = userIdentityRevision, navigation = routeRevision;
    const id = friends.selectedId, chatRevision = friends.chatRevision, request = {};
    friends.chatLoadRequest = request; renderChat();
    const live = () => current(identity, revision, identityRevision) && navigation === routeRevision && active() && id === friends.selectedId && chatRevision === friends.chatRevision && friends.chatLoadRequest === request;
    try {
      const data = await api(`friends/${encodeURIComponent(id)}/messages`);
      if (!live() || data.friend?.id !== id) return;
      reconcileMessages(data.messages); message(el('friendChatMessage'), ''); renderChat(); void markRead();
    } catch (error) {
      if (!live()) return;
      if (error.status === 401) { setUser(null); return; }
      message(el('friendChatMessage'), 'Messages unavailable. Try again.');
    } finally {
      if (friends.chatLoadRequest === request) { friends.chatLoadRequest = null; renderChat(); }
    }
  }
  function queueNext(delay = 0) {
    window.clearTimeout(retryTimer); retryTimer = undefined;
    if (!active()) return;
    retryTimer = window.setTimeout(() => { retryTimer = undefined; void sendNext(); }, delay);
  }
  async function sendNext() {
    if (!active() || friends.sending || state.accountSubmitting) return;
    const entry = friends.outbox.find(item => item.status === 'pending');
    if (!entry) return;
    if (friends.entries.find(friend => friend.id === entry.friendId)?.player.banned) {
      entry.status = 'failed'; entry.error = 'Player unavailable.'; renderChat(); queueNext(); return;
    }
    if (entry.retryAt > Date.now()) { queueNext(entry.retryAt - Date.now()); return; }
    const identity = friends.identity, revision = friends.revision, identityRevision = userIdentityRevision;
    friends.sending = entry; renderChat();
    try {
      const data = await api(`friends/${encodeURIComponent(entry.friendId)}/messages`, { method: 'POST', body: JSON.stringify({ text: entry.text, clientMessageId: entry.clientMessageId }) });
      if (!current(identity, revision, identityRevision)) return;
      friends.outbox = friends.outbox.filter(item => item !== entry);
      friends.listRevision++; friends.loadRequest = null;
      friends.entries = sortFriends(friends.entries.map(friend => friend.id === entry.friendId ? {
        ...friend, lastMessage: !friend.lastMessage || messageOrder(friend.lastMessage, data.message) <= 0 ? data.message : friend.lastMessage
      } : friend));
      renderLists();
      if (friends.selectedId === entry.friendId) {
        friends.chatRevision++; friends.chatLoadRequest = null;
        reconcileMessages([...friends.messages.filter(item => item.id !== data.message.id && !(item.sender.accountId === identity && item.clientMessageId === data.message.clientMessageId)), data.message]);
        message(el('friendChatMessage'), '');
      }
    } catch (error) {
      if (!current(identity, revision, identityRevision) || !friends.outbox.includes(entry)) return;
      if (error.status === 401) { setUser(null); return; }
      if (error.status === 429) {
        const delay = Number(error.retryAfterMs);
        entry.retryAt = Date.now() + Math.max(100, Number.isFinite(delay) && delay > 0 ? delay : 3000) + 100;
      } else { entry.status = 'failed'; entry.error = error.message || 'Not sent.'; }
    } finally {
      if (current(identity, revision, identityRevision) && friends.sending === entry) { friends.sending = null; renderChat(); void markRead(); queueNext(); }
    }
  }
  function sendMessage(event) {
    event.preventDefault();
    if (!active() || !selectedFriend() || selectedFriend().player.banned || state.accountSubmitting) return;
    const text = el('friendChatInput').value.trim();
    if (!text || text.length > 1000) { message(el('friendChatMessage'), 'Use 1–1,000 characters.'); return; }
    const clientMessageId = crypto.randomUUID();
    friends.outbox.push({ id: `pending:${clientMessageId}`, clientMessageId, friendId: friends.selectedId, sender: { ...state.user }, text, createdAt: new Date().toISOString(), status: 'pending', retryAt: 0 });
    el('friendChatInput').value = ''; friends.drafts[friends.selectedId] = ''; message(el('friendChatMessage'), ''); renderChat(); void sendNext();
  }
  function act(action, id) {
    if (!active() || state.accountSubmitting) return;
    if (action === 'open') { openConversation(id); return; }
    if (action === 'retry-message') {
      const entry = friends.outbox.find(item => item.clientMessageId === id && item.friendId === friends.selectedId && item.status === 'failed');
      if (entry) { entry.status = 'pending'; entry.error = null; entry.retryAt = 0; renderChat(); void sendNext(); } return;
    }
    if (busy()) return;
    if (['accept', 'deny'].includes(action) && friends.incoming.some(request => request.id === id)) void perform({ id, action });
    if (action === 'cancel' && friends.outgoing.some(request => request.id === id)) void perform({ id, action });
  }
  function onRoute() {
    if (friends.navigation !== routeRevision) {
      friends.navigation = routeRevision; picker?.reset();
      friends.loadRequest = null; friends.chatLoadRequest = null; friends.chatRevision++;
      friends.readRequest = null; friends.requestedId = requestedConversation();
      window.clearTimeout(retryTimer); retryTimer = undefined;
    }
    render();
    if (active()) { void load(); void loadMessages(); void sendNext(); }
  }
  function requestedConversation() {
    return pageKind === 'friends' ? new URLSearchParams(window.location.search).get('conversation') : null;
  }
  el('friendRequestForm').addEventListener('submit', event => void requestFriend(event));
  el('friendUsername').addEventListener('input', () => { friends.requestDraft = null; message(el('friendRequestMessage'), ''); });
  el('friendChatForm').addEventListener('submit', sendMessage);
  el('friendChatBack').addEventListener('click', closeConversation);
  el('friendsRefresh').addEventListener('click', () => { void load(); void loadMessages(); });
  el('friendsJoin').addEventListener('click', () => el('accountButton').click());
  el('friendsPage').addEventListener('click', event => {
    const control = event.target.closest('[data-friend-action]'); if (control && !control.disabled) act(control.dataset.friendAction, control.dataset.friendId);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) { void load(); void loadMessages(); void markRead(); void sendNext(); } });
  setInterval(() => { if (!document.hidden && active()) void load(); }, 5000);
  setInterval(() => { if (!document.hidden && active()) void loadMessages(); }, 3000);
  window.PepperFriends = { syncUser, onRoute, load, openConversation };
  syncUser(); onRoute();
})();
