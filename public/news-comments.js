(() => {
  'use strict';
  const threads = new Map();
  const viewer = { identity: state.user?.accountId || null, revision: 0, navigation: routeRevision };
  let nextFormId = 0;
  const validKind = kind => ['announcements', 'changelog'].includes(kind);
  const signedIn = () => !!state.user && state.user.accountId === viewer.identity && !accountBanned && !state.user.banned;
  const retained = thread => threads.get(thread.key) === thread && !thread.disposed;
  const active = thread => retained(thread) && pageKind === thread.kind && thread.details.open && thread.details.isConnected !== false;
  const sessionCurrent = (identity, revision, identityRevision) => viewer.identity === identity && viewer.revision === revision && userIdentityRevision === identityRevision;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  function element(tag, className, text) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  }
  function control(label, handler, className = 'button') {
    const button = element('button', className, label); button.type = 'button'; button.addEventListener('click', handler); return button;
  }
  function authorLink(author) {
    const link = element(author?.username && author.accountId ? 'a' : 'span', 'news-comment-author player-identity');
    if (author?.username && author.accountId) link.href = profileHref(author.username);
    link.append(profileAvatar(author || {}, 'player-avatar', true), element('span', '', author?.username || 'Deleted player'), playerRoleBadges(author)); return link;
  }
  function canDelete(thread, comment) {
    if (!signedIn() || !active(thread) || comment.deleted || comment.status || !comment.id) return false;
    if (comment.author?.accountId === viewer.identity) return true;
    if (!window.PepperModeration?.enabled()) return false;
    const role = accountRole(state.user);
    const targetRole = accountRole(comment.author);
    return role === 'admin' || role === 'senior_mod' && ['player', 'mod'].includes(targetRole) || role === 'mod' && targetRole === 'player';
  }
  function invalidateRead(thread) {
    thread.readRevision++; thread.readRequest = null; thread.loading = false;
  }
  function setCount(thread, value) {
    thread.count = count(value); thread.summary.textContent = `Comments (${thread.count.toLocaleString()})`;
  }
  function refreshParent(thread) {
    thread.entry.commentCount = thread.count;
    if (thread.kind === 'announcements') {
      announcementRevision++; void loadAnnouncements(true);
    } else { changelogRevision++; void loadChangelog(true); }
  }
  function updateComments(thread, comments) {
    const saved = new Map(thread.comments.map(comment => [comment.id, comment]));
    for (const comment of comments) {
      const previous = saved.get(comment.id);
      saved.set(comment.id, previous?.deleted && !comment.deleted ? { ...comment, deleted: true, text: previous.text } : comment);
    }
    thread.comments = [...saved.values()].sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt) || left.id.localeCompare(right.id));
    const receipts = new Set(thread.comments.filter(comment => comment.author?.accountId === viewer.identity).map(comment => comment.clientMessageId).filter(Boolean));
    thread.outbox = thread.outbox.filter(comment => !receipts.has(comment.clientMessageId));
  }
  function render(thread) {
    if (!retained(thread)) return;
    thread.body.hidden = !thread.details.open;
    thread.form.hidden = !signedIn(); thread.signIn.hidden = signedIn();
    thread.input.disabled = !active(thread) || !signedIn() || state.accountSubmitting;
    thread.send.disabled = thread.input.disabled;
    thread.refresh.disabled = !active(thread) || thread.loading;
    thread.refresh.textContent = thread.loading ? 'Loading…' : 'Refresh';
    thread.more.hidden = !thread.nextCursor; thread.more.disabled = !active(thread) || thread.loading;
    const entries = [...thread.comments, ...thread.outbox].sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
    const signature = JSON.stringify([entries, viewer.identity, accountRole(state.user), window.PepperModeration?.enabled() === true, state.accountSubmitting, thread.deleteBusy, thread.confirmDeleteId, active(thread)]);
    if (signature === thread.signature) return;
    thread.signature = signature;
    const focused = document.activeElement;
    const focusedId = focused?.dataset.commentId, focusedAction = focused?.dataset.commentAction;
    if (!entries.length) thread.list.replaceChildren(element('p', 'news-comments-empty', thread.loading ? 'Loading comments…' : 'No comments yet.'));
    else thread.list.replaceChildren(...entries.map(comment => {
      const row = element('article', 'news-comment-row'); row.dataset.commentId = comment.id; row.setAttribute('role', 'listitem');
      const date = element('time', 'news-comment-time'); date.dateTime = comment.createdAt;
      date.textContent = new Date(comment.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      row.append(authorLink(comment.author), element('p', 'news-comment-text', comment.deleted ? 'Comment deleted.' : comment.text), date);
      const actions = element('div', 'news-comment-actions');
      if (comment.status) {
        row.append(element('span', 'news-comment-status', comment.status === 'pending' ? 'Sending…' : comment.error || 'Not sent.'));
        if (comment.status === 'failed') {
          const retry = control('Retry', () => retryComment(thread, comment));
          retry.dataset.commentId = comment.clientMessageId; retry.dataset.commentAction = 'retry';
          retry.disabled = !active(thread) || !signedIn() || state.accountSubmitting; actions.append(retry);
        }
      } else if (canDelete(thread, comment)) {
        const deleting = thread.deleteBusy === comment.id;
        const remove = control(deleting ? 'Deleting…' : thread.confirmDeleteId === comment.id ? 'Confirm delete' : 'Delete', () => void deleteComment(thread, comment));
        remove.dataset.commentId = comment.id; remove.dataset.commentAction = 'delete'; remove.disabled = !!thread.deleteBusy || state.accountSubmitting;
        actions.append(remove);
        if (thread.confirmDeleteId === comment.id && !deleting) {
          const cancel = control('Cancel', () => { thread.confirmDeleteId = null; render(thread); });
          cancel.dataset.commentId = comment.id; cancel.dataset.commentAction = 'cancel'; actions.append(cancel);
        }
      }
      if (actions.children.length) row.append(actions); return row;
    }));
    if (focusedId && thread.list.contains(focused) === false) {
      const replacement = [...thread.list.querySelectorAll('[data-comment-action]')].find(button => button.dataset.commentId === focusedId && button.dataset.commentAction === focusedAction && !button.disabled);
      replacement?.focus({ preventScroll: true });
    }
  }
  async function load(thread, more = false) {
    if (!active(thread) || thread.loading || more && !thread.nextCursor) return;
    const identity = viewer.identity, revision = viewer.revision, identityRevision = userIdentityRevision, navigation = routeRevision, readRevision = thread.readRevision, request = {};
    const cursors = more ? [thread.nextCursor] : [...thread.pageCursors];
    thread.readRequest = request; thread.loading = true; message(thread.status, ''); render(thread);
    const live = () => retained(thread) && active(thread) && sessionCurrent(identity, revision, identityRevision) && navigation === routeRevision && thread.readRevision === readRevision && thread.readRequest === request;
    try {
      let last;
      for (const cursor of cursors) {
        const data = await api(`${thread.key}/comments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!live()) return;
        updateComments(thread, data.comments); last = data;
      }
      if (!live()) return;
      if (more && !thread.pageCursors.includes(cursors[0])) thread.pageCursors.push(cursors[0]);
      thread.nextCursor = last?.nextCursor || null; thread.loaded = true;
    } catch (error) {
      if (!live()) return;
      if (error.status === 404) { dispose(thread); return; }
      message(thread.status, 'Comments unavailable. Try again.');
    } finally {
      if (retained(thread) && thread.readRequest === request) { thread.readRequest = null; thread.loading = false; thread.signature = null; render(thread); }
    }
  }
  function scheduleSend(thread, delay = 0) {
    window.clearTimeout(thread.retryTimer); thread.retryTimer = undefined;
    if (!active(thread) || !signedIn()) return;
    thread.retryTimer = window.setTimeout(() => { thread.retryTimer = undefined; void sendNext(thread); }, delay);
  }
  async function sendNext(thread) {
    if (!active(thread) || !signedIn() || thread.sending || state.accountSubmitting) return;
    const entry = thread.outbox.find(comment => comment.status === 'pending'); if (!entry) return;
    if (entry.retryAt > Date.now()) { scheduleSend(thread, entry.retryAt - Date.now()); return; }
    const identity = viewer.identity, revision = viewer.revision, identityRevision = userIdentityRevision, navigation = routeRevision;
    thread.sending = entry; render(thread);
    const sameSession = () => retained(thread) && sessionCurrent(identity, revision, identityRevision) && signedIn();
    const live = () => sameSession() && navigation === routeRevision && pageKind === thread.kind;
    try {
      const data = await api(`${thread.key}/comments`, { method: 'POST', body: JSON.stringify({ text: entry.text, clientMessageId: entry.clientMessageId }) });
      if (!live()) {
        if (sameSession() && thread.outbox.includes(entry)) { entry.status = 'failed'; entry.error = 'Result unknown. Retry safely.'; }
        return;
      }
      const saved = thread.comments.some(comment => comment.id === data.comment.id);
      invalidateRead(thread); updateComments(thread, [data.comment]);
      thread.outbox = thread.outbox.filter(comment => comment !== entry);
      if (!saved && !data.comment.deleted) setCount(thread, thread.count + 1);
      message(thread.status, ''); refreshParent(thread);
    } catch (error) {
      if (!sameSession() || !thread.outbox.includes(entry)) return;
      if (!live()) { entry.status = 'failed'; entry.error = 'Result unknown. Retry safely.'; return; }
      if (error.status === 401) { setUser(null); return; }
      if (error.status === 404) { dispose(thread); return; }
      if (error.status === 429) {
        const delay = Number(error.retryAfterMs);
        entry.retryAt = Date.now() + Math.max(100, Number.isFinite(delay) && delay > 0 ? delay : 3000) + 100;
      } else { entry.status = 'failed'; entry.error = error.message || 'Not sent.'; }
    } finally {
      if (sameSession() && thread.sending === entry) { thread.sending = null; render(thread); scheduleSend(thread); }
    }
  }
  function submitComment(thread, event) {
    event.preventDefault();
    if (!active(thread) || !signedIn() || state.accountSubmitting) return;
    const text = thread.input.value.trim();
    if (!text || text.length > 1000) { message(thread.status, 'Use 1–1,000 characters.'); return; }
    const clientMessageId = crypto.randomUUID();
    thread.outbox.push({ id: `pending:${clientMessageId}`, clientMessageId, author: { ...state.user }, text, createdAt: new Date().toISOString(), status: 'pending', retryAt: 0 });
    thread.input.value = ''; message(thread.status, ''); render(thread); void sendNext(thread);
  }
  function retryComment(thread, comment) {
    if (!active(thread) || !signedIn() || state.accountSubmitting || comment.status !== 'failed' || !thread.outbox.includes(comment)) return;
    comment.status = 'pending'; comment.error = null; comment.retryAt = 0; render(thread); void sendNext(thread);
  }
  async function deleteComment(thread, comment) {
    comment = thread.comments.find(item => item.id === comment.id);
    if (!comment) return;
    if (!canDelete(thread, comment) || thread.deleteBusy || state.accountSubmitting) return;
    if (thread.confirmDeleteId !== comment.id) { thread.confirmDeleteId = comment.id; render(thread); return; }
    const identity = viewer.identity, revision = viewer.revision, identityRevision = userIdentityRevision, navigation = routeRevision;
    thread.deleteBusy = comment.id; render(thread); message(thread.status, 'Deleting…');
    const live = () => retained(thread) && sessionCurrent(identity, revision, identityRevision) && navigation === routeRevision && active(thread);
    try {
      const data = await api(`${thread.key}/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE' });
      if (!live()) return;
      const previous = thread.comments.find(item => item.id === comment.id);
      invalidateRead(thread); updateComments(thread, [data.comment]); thread.confirmDeleteId = null;
      if (previous && !previous.deleted && data.comment.deleted) setCount(thread, Math.max(0, thread.count - 1));
      message(thread.status, 'Comment deleted.', true); refreshParent(thread);
    } catch (error) {
      if (!live()) return;
      if (error.status === 401) { setUser(null); return; }
      if (error.status === 404) { dispose(thread); return; }
      message(thread.status, error.message || 'Delete failed.');
    } finally {
      if (retained(thread) && sessionCurrent(identity, revision, identityRevision) && thread.deleteBusy === comment.id) { thread.deleteBusy = null; render(thread); }
    }
  }
  function createThread(kind, entry) {
    const details = element('details', 'news-comments'), summary = element('summary', 'news-comments-summary');
    const body = element('div', 'news-comments-body'), list = element('div', 'news-comments-list'); body.hidden = true; list.setAttribute('role', 'list');
    const status = element('p', 'news-comments-message form-message'); status.setAttribute('role', 'status');
    const form = element('form', 'news-comments-form'), input = element('textarea', 'news-comments-input');
    input.id = `news-comment-input-${++nextFormId}`; input.maxLength = 1000; input.rows = 2; input.required = true; input.placeholder = 'Write a comment';
    const label = element('label', 'sr-only', 'Comment'); label.htmlFor = input.id;
    const send = element('button', 'button', 'Post comment'); send.type = 'submit'; form.append(label, input, send);
    const thread = { key: `${kind}/${entry.id}`, kind, entry, details, summary, body, list, status, form, input, send, count: 0, comments: [], outbox: [], loaded: false, loading: false, readRequest: null, readRevision: 0, pageCursors: [null], nextCursor: null, sending: null, retryTimer: undefined, deleteBusy: null, confirmDeleteId: null, signature: null, disposed: false };
    thread.refresh = control('Refresh', () => void load(thread), 'button news-comments-refresh');
    thread.more = control('Load more', () => void load(thread, true), 'button news-comments-more'); thread.more.hidden = true;
    thread.signIn = control('Sign in', () => document.getElementById('accountButton').click(), 'button news-comments-sign-in');
    const actions = element('div', 'news-comments-actions'); actions.append(thread.refresh, thread.more);
    body.append(list, actions, status, form, thread.signIn); details.append(summary, body);
    form.addEventListener('submit', event => submitComment(thread, event));
    details.addEventListener('toggle', () => {
      if (!retained(thread)) return;
      if (!details.open) { invalidateRead(thread); window.clearTimeout(thread.retryTimer); thread.retryTimer = undefined; }
      render(thread);
      if (active(thread)) { void load(thread); void sendNext(thread); }
    });
    setCount(thread, entry.commentCount); return thread;
  }
  function mount(article, kind, entry) {
    if (!article || !validKind(kind) || !entry?.id) return;
    const key = `${kind}/${entry.id}`;
    let thread = threads.get(key);
    if (!thread) { thread = createThread(kind, entry); threads.set(key, thread); }
    const changed = thread.count !== count(entry.commentCount);
    thread.entry = entry; setCount(thread, entry.commentCount);
    const focused = document.activeElement, restoreFocus = focused && thread.details.contains(focused);
    if (thread.details.parentElement !== article) article.append(thread.details);
    render(thread);
    Promise.resolve().then(() => {
      if (!retained(thread)) return;
      if (restoreFocus && thread.details.contains(focused) && thread.details.isConnected !== false) focused.focus({ preventScroll: true });
      render(thread);
      if (active(thread) && (!thread.loaded || changed)) void load(thread);
    });
  }
  function dispose(thread) {
    thread.disposed = true; invalidateRead(thread); window.clearTimeout(thread.retryTimer);
    thread.outbox = []; thread.input.value = ''; thread.details.remove(); threads.delete(thread.key);
  }
  function reconcile(kind, entries) {
    if (!validKind(kind) || !Array.isArray(entries)) return;
    const ids = new Set(entries.map(entry => entry.id));
    for (const thread of threads.values()) if (thread.kind === kind && !ids.has(thread.entry.id)) dispose(thread);
  }
  function mountExisting() {
    for (const [kind, id, entries] of [['announcements', 'announcementEntries', state.announcementEntries], ['changelog', 'changelogEntries', state.changelogEntries]]) {
      if (!Array.isArray(entries)) continue;
      const byId = new Map(entries.map(entry => [entry.id, entry]));
      document.getElementById(id)?.querySelectorAll('.changelog-entry').forEach(article => { const entry = byId.get(article.dataset.entryId); if (entry) mount(article, kind, entry); });
    }
  }
  function syncUser() {
    const identity = state.user?.accountId || null;
    if (identity !== viewer.identity || !signedIn() && accountBanned) {
      viewer.identity = identity; viewer.revision++;
      for (const thread of threads.values()) {
        invalidateRead(thread); window.clearTimeout(thread.retryTimer); thread.retryTimer = undefined;
        thread.outbox = []; thread.sending = null; thread.deleteBusy = null; thread.confirmDeleteId = null; thread.input.value = ''; message(thread.status, '');
      }
    }
    mountExisting();
    for (const thread of threads.values()) {
      render(thread); if (active(thread) && !thread.loaded) void load(thread);
      if (active(thread) && signedIn()) void sendNext(thread);
    }
  }
  function onRoute() {
    if (viewer.navigation !== routeRevision) {
      viewer.navigation = routeRevision;
      for (const thread of threads.values()) { invalidateRead(thread); window.clearTimeout(thread.retryTimer); thread.retryTimer = undefined; thread.confirmDeleteId = null; }
    }
    mountExisting();
    for (const thread of threads.values()) { render(thread); if (active(thread)) { void load(thread); void sendNext(thread); } }
  }
  window.PepperNewsComments = { mount, reconcile, syncUser, onRoute };
  syncUser();
})();
