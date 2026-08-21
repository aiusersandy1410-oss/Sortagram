/**
 * Stashboard sync client — no third-party login. A device either starts a
 * fresh sync code (a short shareable phrase like "amber-tide-4821") or joins
 * an existing one typed in from another device. The code IS the credential,
 * so it's shown once prominently and the person is told to save it — there's
 * no email/password recovery path, by design (keeps the backend dead simple).
 *
 * Auth uses a bearer token stored in localStorage, NOT a cookie. The
 * frontend and backend live on different domains (vercel.app / railway.app),
 * and mobile browsers — especially in-app browsers like Instagram's —
 * increasingly block that kind of cross-site cookie by default, which
 * silently breaks cookie-based sessions. A token sent explicitly in an
 * Authorization header sidesteps that entirely.
 *
 * Loaded via <script src="sync.js"> at the end of the main HTML file.
 * Talks to the main app only through three hooks the app exposes on
 * `window`: getStashState(), persistStashState(next), renderStashAll().
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
  const TOKEN_KEY = 'stash_authToken';
  const PERIODIC_MS = 60000;
  const MAX_BACKOFF_MS = 60000;

  let user = null; // { syncCode }
  let authToken = localStorage.getItem(TOKEN_KEY) || null;
  let pushTimer = null;
  let backoffMs = 2000;
  let periodicHandle = null;

  function emit(name, detail){ window.dispatchEvent(new CustomEvent(name, { detail })); }

  function setToken(token){
    authToken = token;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = 'Bearer ' + authToken;
    const res = await fetch(API_BASE + path, { headers, ...opts });
    if (res.status === 401) { user = null; setToken(null); emit('stash-sync-changed'); }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || ('Request failed: ' + res.status));
    }
    return res.json();
  }

  function getPending() {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '{"topics":[],"items":[]}');
  }
  function setPending(p) {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  }

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

  // ---------- panel UI ----------
  // Built entirely in JS (no changes needed to the main HTML's modal markup)
  // so this stays a self-contained, optional add-on.

  function closePanel(){
    const host = document.getElementById('stashSyncHost');
    if (host) host.remove();
  }

  function panelStyles(){
    return 'position:fixed; inset:0; background:rgba(10,10,14,.45); display:flex; align-items:center; justify-content:center; z-index:9999;';
  }
  function cardStyles(){
    return 'background:var(--surface,#fff); color:var(--ink,#14141B); width:min(340px,90vw); border-radius:16px; padding:20px; box-shadow:0 24px 60px rgba(0,0,0,.3); font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;';
  }

  function openStartPanel(){
    closePanel();
    const host = document.createElement('div');
    host.id = 'stashSyncHost';
    host.style.cssText = panelStyles();
    host.innerHTML = `
      <div style="${cardStyles()}">
        <h3 style="margin:0 0 10px;font-size:1.05rem;">Sync across devices</h3>
        <p style="font-size:.85rem;line-height:1.5;color:var(--ink-soft,#6B6B76);margin:0 0 14px;">
          No account or email needed. Start a sync code here, then enter that
          same code on your other device to link it.
        </p>
        <button type="button" id="syncStartBtn" style="width:100%;padding:10px;border:none;border-radius:999px;background:var(--accent,#FF5A4E);color:#fff;font-weight:600;font-size:.9rem;margin-bottom:8px;">Start syncing (new code)</button>
        <button type="button" id="syncJoinToggleBtn" style="width:100%;padding:10px;border:1px solid var(--border,#E6E6EC);border-radius:999px;background:transparent;color:inherit;font-size:.9rem;margin-bottom:8px;">I already have a code</button>
        <div id="syncJoinRow" hidden style="display:flex;gap:6px;margin-bottom:8px;">
          <input id="syncJoinInput" placeholder="e.g. amber-tide-4821" style="flex:1;padding:9px 10px;border:1px solid var(--border,#E6E6EC);border-radius:10px;background:var(--surface-2,#FBFBFC);color:inherit;">
          <button type="button" id="syncJoinBtn" style="padding:9px 14px;border:none;border-radius:10px;background:var(--accent,#FF5A4E);color:#fff;font-weight:600;">Join</button>
        </div>
        <p id="syncPanelError" style="color:#DC2626;font-size:.8rem;margin:4px 0 0;"></p>
        <button type="button" id="syncPanelClose" style="width:100%;padding:8px;border:none;background:none;color:var(--ink-soft,#6B6B76);font-size:.85rem;margin-top:8px;">Cancel</button>
      </div>`;
    document.body.appendChild(host);

    const errEl = host.querySelector('#syncPanelError');
    const showErr = (msg) => { errEl.textContent = msg; };

    host.querySelector('#syncPanelClose').addEventListener('click', closePanel);
    host.addEventListener('click', (e) => { if (e.target === host) closePanel(); });

    host.querySelector('#syncStartBtn').addEventListener('click', async () => {
      try {
        const data = await api('/auth/start', { method: 'POST' });
        setToken(data.token);
        user = { syncCode: data.syncCode };
        emit('stash-sync-changed');
        // Push existing local items immediately — don't wait for the person
        // to tap "Done" on the next screen, since they might dismiss it
        // another way (tap outside, back button) and nothing would sync.
        await fullSync();
        startPeriodicSync();
        showCodePanel(data.syncCode, true);
      } catch (err) { showErr(err.message); }
    });

    host.querySelector('#syncJoinToggleBtn').addEventListener('click', () => {
      host.querySelector('#syncJoinRow').hidden = false;
      host.querySelector('#syncJoinInput').focus();
    });

    host.querySelector('#syncJoinBtn').addEventListener('click', async () => {
      const code = host.querySelector('#syncJoinInput').value.trim();
      if (!code) { showErr('Enter a code first'); return; }
      try {
        const data = await api('/auth/join', { method: 'POST', body: JSON.stringify({ syncCode: code }) });
        setToken(data.token);
        user = { syncCode: data.syncCode };
        emit('stash-sync-changed');
        await fullSync();
        startPeriodicSync();
        closePanel();
      } catch (err) { showErr(err.message); }
    });
  }

  function showCodePanel(code, isNew){
    closePanel();
    const host = document.createElement('div');
    host.id = 'stashSyncHost';
    host.style.cssText = panelStyles();
    host.innerHTML = `
      <div style="${cardStyles()}">
        <h3 style="margin:0 0 10px;font-size:1.05rem;">${isNew ? 'Sync is on' : 'Your sync code'}</h3>
        <p style="font-size:.85rem;line-height:1.5;color:var(--ink-soft,#6B6B76);margin:0 0 12px;">
          ${isNew ? 'Save this code somewhere safe — it\'s the only way to link another device. There\'s no account recovery without it.' : 'Enter this on another device to link it.'}
        </p>
        <div style="display:flex;gap:6px;margin-bottom:12px;">
          <code style="flex:1;padding:10px 12px;background:var(--surface-2,#FBFBFC);border:1px solid var(--border,#E6E6EC);border-radius:10px;font-size:.95rem;text-align:center;letter-spacing:.02em;">${code}</code>
          <button type="button" id="syncCopyBtn" style="padding:0 14px;border:1px solid var(--border,#E6E6EC);border-radius:10px;background:transparent;color:inherit;">Copy</button>
        </div>
        <button type="button" id="syncPanelDone" style="width:100%;padding:10px;border:none;border-radius:999px;background:var(--accent,#FF5A4E);color:#fff;font-weight:600;font-size:.9rem;">Done</button>
      </div>`;
    document.body.appendChild(host);
    host.querySelector('#syncCopyBtn').addEventListener('click', () => {
      navigator.clipboard?.writeText(code).catch(() => {});
    });
    host.querySelector('#syncPanelDone').addEventListener('click', () => {
      closePanel();
    });
  }

  function openPanel(){
    if (user) { showCodePanel(user.syncCode, false); }
    else { openStartPanel(); }
  }

  async function turnOffSync(){
    stopPeriodicSync();
    setToken(null);
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
    backoffMs = 2000;
  }

  async function fullSync() {
    if (!authToken) return;
    await push();
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
    if (!authToken) return;
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
    if (authToken) { attemptPush(); pull().catch(console.warn); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && authToken) pull().catch(console.warn);
  });

  async function init() {
    const state = window.getStashState();
    migrateIfNeeded(state);
    if (!authToken) return; // never synced on this device — stay local-only
    try {
      const data = await api('/auth/me');
      user = data.user;
      emit('stash-sync-changed');
      await fullSync();
      startPeriodicSync();
    } catch {
      // token invalid/expired — user stays null, UI shows "not synced"
    }
  }

  return {
    init, openPanel, signOut: turnOffSync, queueChange, pushSoon,
    get user() { return user; }
  };
})();

window.Sync = Sync;
