/**
 * Stashboard sync client.
 *
 * Loaded via <script src="sync.js"> at the end of the main HTML file.
 * Talks to the main app only through three hooks the app exposes on
 * `window`: getStashState(), persistStashState(next), renderStashAll().
 * That keeps this file decoupled from the app's internal closures.
 *
 * Fires two DOM events the app listens for:
 *   'stash-sync-changed'        - sign-in state changed (update UI)
 *   'stash-sync-remote-update'  - new data pulled from server (re-render)
 */

const Sync = (function () {
  const API_BASE = window.STASHBOARD_API_BASE;
  const PENDING_KEY = 'stash_pending';
  const LAST_SYNC_KEY = 'stash_lastSync';
  const MIGRATED_KEY = 'stash_migratedTimestamps';
  const PERIODIC_MS = 60000;      // background pull every 60s while tab is open
  const MAX_BACKOFF_MS = 60000;

  let user = null;
  let pushTimer = null;
  let backoffMs = 2000;
  let periodicHandle = null;
  let googleReady = false;

  function emit(name, detail){ window.dispatchEvent(new CustomEvent(name, { detail })); }

  async function api(path, opts = {}) {
    const res = await fetch(API_BASE + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    if (res.status === 401) { user = null; emit('stash-sync-changed'); }
    if (!res.ok) throw new Error('Sync request failed: ' + res.status);
    return res.json();
  }

  function getPending() {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '{"topics":[],"items":[]}');
  }
  function setPending(p) {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  }

  // One-time migration for anyone who already had local data before sync
  // existed: their topics/items won't have updatedAt, which the server
  // needs for last-write-wins comparisons. Stamp them once, and queue
  // everything for an initial push so it lands on the server.
  function migrateIfNeeded(state) {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    const now = Date.now();
    const pending = getPending();
    state.topics.forEach(t => { if (!t.updatedAt) t.updatedAt = now; pending.topics.push(t); });
    state.items.forEach(i => { if (!i.updatedAt) i.updatedAt = now; pending.items.push(i); });
    setPending(pending);
    window.persistStashState(state);
    localStorage.setItem(MIGRATED_KEY, '1');
  }

  // ---------- Google sign-in ----------

  function ensureGoogleInit() {
    if (googleReady || !window.google || !window.google.accounts) return;
    window.google.accounts.id.initialize({
      client_id: window.STASHBOARD_GOOGLE_CLIENT_ID,
      callback: (resp) => signIn(resp.credential).catch(console.error)
    });
    googleReady = true;
  }

  // Called from the app's "Sign in to sync" button. Renders Google's
  // official button into a temp container and clicks it programmatically
  // isn't allowed by Google's terms, so instead we show a small popover
  // with their real button — simplest reliable approach across browsers.
  function promptSignIn() {
    ensureGoogleInit();
    if (!googleReady) {
      console.warn('Google Identity Services not loaded yet — try again in a moment.');
      return;
    }
    let host = document.getElementById('googleSignInHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'googleSignInHost';
      host.style.cssText = 'position:fixed; bottom:16px; right:16px; z-index:9999; background:var(--surface,#fff); padding:10px; border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,.2);';
      document.body.appendChild(host);
    }
    host.innerHTML = '';
    window.google.accounts.id.renderButton(host, { theme: 'outline', size: 'medium' });
    window.google.accounts.id.prompt();
  }

  async function signIn(credential) {
    const data = await api('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential })
    });
    user = data.user;
    const host = document.getElementById('googleSignInHost');
    if (host) host.remove();
    emit('stash-sync-changed');
    await fullSync();
    startPeriodicSync();
    return user;
  }

  async function signOut() {
    stopPeriodicSync();
    await api('/auth/logout', { method: 'POST' });
    user = null;
    emit('stash-sync-changed');
  }

  // ---------- sync core ----------

  function mergeIncoming(state, { topics, items }) {
    const byId = (arr) => Object.fromEntries(arr.map(x => [x.id, x]));
    const localTopics = byId(state.topics);
    const localItems = byId(state.items);

    topics.forEach(t => {
      const local = localTopics[t.id];
      if (!local || new Date(t.updatedAt) > new Date(local.updatedAt || 0)) localTopics[t.id] = t;
    });
    items.forEach(i => {
      const local = localItems[i.id];
      if (!local || new Date(i.updatedAt) > new Date(local.updatedAt || 0)) localItems[i.id] = i;
    });

    state.topics = Object.values(localTopics).filter(t => !t.deletedAt);
    state.items = Object.values(localItems).filter(i => !i.deletedAt);
    return state;
  }

  async function pull() {
    const since = localStorage.getItem(LAST_SYNC_KEY) || '1970-01-01T00:00:00Z';
    const data = await api('/api/sync?since=' + encodeURIComponent(since));
    if (data.topics.length || data.items.length) {
      const state = mergeIncoming(window.getStashState(), data);
      window.persistStashState(state);
      emit('stash-sync-remote-update');
    }
    localStorage.setItem(LAST_SYNC_KEY, data.syncedAt);
  }

  async function push() {
    const pending = getPending();
    if (pending.topics.length === 0 && pending.items.length === 0) return;
    const data = await api('/api/sync', { method: 'POST', body: JSON.stringify(pending) });
    if (data.rejected.topics.length || data.rejected.items.length) {
      console.warn('Some records were stale on push; will re-pull', data.rejected);
    }
    setPending({ topics: [], items: [] });
    backoffMs = 2000; // reset backoff on success
  }

  async function fullSync() {
    if (!user) return;
    await push();   // send local changes first so pull doesn't clobber them
    await pull();
  }

  function queueChange(kind, record) {
    const pending = getPending();
    const arr = pending[kind];
    const idx = arr.findIndex(r => r.id === record.id);
    if (idx >= 0) arr[idx] = record; else arr.push(record);
    setPending(pending);
    pushSoon();
  }

  function pushSoon() {
    if (!user) return; // stays queued locally until sign-in; nothing lost
    clearTimeout(pushTimer);
    pushTimer = setTimeout(attemptPush, 1500);
  }

  async function attemptPush() {
    try {
      await push();
    } catch (err) {
      console.warn('Push failed, retrying in', backoffMs, 'ms', err);
      clearTimeout(pushTimer);
      pushTimer = setTimeout(attemptPush, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  function startPeriodicSync() {
    stopPeriodicSync();
    periodicHandle = setInterval(() => { pull().catch(console.warn); }, PERIODIC_MS);
  }
  function stopPeriodicSync() {
    if (periodicHandle) clearInterval(periodicHandle);
    periodicHandle = null;
  }

  window.addEventListener('online', () => {
    if (user) { attemptPush(); pull().catch(console.warn); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && user) pull().catch(console.warn);
  });

  async function init() {
    const state = window.getStashState();
    migrateIfNeeded(state);
    ensureGoogleInit();
    // Resume an existing session if the cookie is still valid.
    try {
      const data = await api('/auth/me');
      user = data.user;
      emit('stash-sync-changed');
      await fullSync();
      startPeriodicSync();
    } catch {
      // not signed in — normal for first visit or after cookie expiry
    }
  }

  return {
    init, signIn, signOut, promptSignIn, queueChange, pushSoon,
    get user() { return user; }
  };
})();

// `const` at script top-level does NOT create a window property (unlike
// `var`), and the main app looks up window.Sync — so export explicitly.
window.Sync = Sync;
