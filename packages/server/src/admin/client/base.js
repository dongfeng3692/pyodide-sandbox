// admin/client/base.js — runs on every admin page (inlined by shell.mjs after
// `const I18N = …, ICONS = …;`). i18n/theme, auth gate, health pill, api(),
// polling and small motion helpers. Plain browser script, no modules.

let LANG = 'zh';
try {
  LANG = localStorage.getItem('sbx-lang') || ((navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en');
} catch (e) { /* storage blocked: keep default */ }

function T(key, vars) {
  let s = (I18N[LANG] && I18N[LANG][key]) || I18N.en[key] || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, name) => (vars[name] ?? m));
  return s;
}

function applyLang() {
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = T(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = T(el.dataset.i18nPh);
    el.setAttribute('aria-label', el.placeholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = T(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  });
  document.querySelectorAll('.langBtn').forEach((b) => { b.textContent = LANG === 'zh' ? 'EN' : '中'; });
  document.title = T('page.' + document.body.dataset.page) + ' · pyodide-sandbox';
}

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function syncThemeBtn() {
  const icon = document.documentElement.dataset.theme === 'light' ? ICONS.sun : ICONS.moon;
  document.querySelectorAll('.themeBtn').forEach((b) => { b.innerHTML = icon; });
}

function toggleTheme() {
  const root = document.documentElement;
  const apply = () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    try { localStorage.setItem('sbx-theme', next); } catch (e) { /* not persisted */ }
    syncThemeBtn();
  };
  if (!document.startViewTransition || prefersReducedMotion()) { apply(); return; }
  root.classList.add('vt-fade');
  document.startViewTransition(apply).finished.catch(() => { /* transition skipped */ }).finally(() => root.classList.remove('vt-fade'));
}

function toggleLang() {
  try { localStorage.setItem('sbx-lang', LANG === 'zh' ? 'en' : 'zh'); } catch (e) { /* not persisted */ }
  location.reload();
}

// ---------- formatting ----------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]); }
function fmt(n, unit) { return n == null ? '—' : String(n) + (unit ? '<small>' + unit + '</small>' : ''); }
function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return Math.max(1, Math.round(d / 1e3)) + 's';
  if (d < 3600e3) return Math.round(d / 60e3) + 'm';
  if (d < 86400e3) return Math.round(d / 3600e3) + 'h';
  return Math.round(d / 86400e3) + 'd';
}
function ago(ts) { return T('time.ago', { n: relTime(ts) }); }
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}
function fmtMb(mb) { return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'; }
function clockTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

// Replace a value; the first fill fades in, later changes get a brief tint.
function setStat(id, html) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el || (el.dataset.filled && el.innerHTML === html)) return;
  const first = !el.dataset.filled;
  el.innerHTML = html;
  el.dataset.filled = '1';
  const cls = first ? 'fade-in' : 'tick';
  el.classList.remove('fade-in', 'tick');
  void el.offsetWidth; // restart the animation
  el.classList.add(cls);
}

// ---------- data ----------

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts));
  if (res.status === 401) { showAuth('login'); throw new Error('unauthorized'); }
  return res.json();
}

// setTimeout chain (never overlaps a slow call); pauses while the tab is
// hidden and catches up immediately when it becomes visible again.
function every(ms, fn) {
  let timer = null;
  let running = false;
  const run = async () => {
    clearTimeout(timer);
    if (running) return;
    running = true;
    try { if (document.visibilityState === 'visible') await fn(); } catch (e) { /* fn reports its own errors */ }
    running = false;
    timer = setTimeout(run, ms);
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
  timer = setTimeout(run, ms);
}

// Segmented control with a sliding indicator. options: [[value, label]].
function segmented(el, options, value, onChange) {
  el.innerHTML = '<span class="seg-ind" aria-hidden="true"></span>' + options.map(([v, label]) =>
    '<button type="button" data-v="' + esc(v) + '" aria-pressed="' + (v === value) + '">' + esc(label) + '</button>').join('');
  const ind = el.querySelector('.seg-ind');
  const place = () => {
    const on = el.querySelector('[aria-pressed=true]');
    if (!on) return;
    ind.style.width = on.offsetWidth + 'px';
    ind.style.transform = 'translateX(' + on.offsetLeft + 'px)';
  };
  el.classList.add('no-anim');
  place();
  requestAnimationFrame(() => el.classList.remove('no-anim'));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.getAttribute('aria-pressed') === 'true') return;
    el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    place();
    onChange(options.find(([v]) => String(v) === b.dataset.v)[0]);
  });
}

// ---------- auth gate ----------

let ADMIN_USER = null;
let ADMIN_SOURCE = null; // 'config' when credentials are pinned via env vars
async function boot() {
  const st = await (await fetch('/admin/api/status', { credentials: 'same-origin' })).json();
  if (st.admin === 'setup') { showAuth('setup'); return false; }
  ADMIN_USER = st.user;
  ADMIN_SOURCE = st.source;
  const probe = await fetch('/admin/api/metrics?window=60', { credentials: 'same-origin' });
  if (probe.status === 401) { showAuth('login'); return false; }
  hideAuth();
  return true;
}
function showBootError() {
  const main = document.getElementById('appmain');
  if (document.getElementById('bootErr')) return;
  main.insertAdjacentHTML('afterbegin', '<div class="boot-error" id="bootErr" role="alert"><span class="dot err"></span><span>' +
    esc(T('boot.failed')) + '</span><span style="flex:1"></span><button type="button" onclick="location.reload()">' + esc(T('boot.retry')) + '</button></div>');
}
function showAuth(mode) {
  const el = document.getElementById('auth');
  const wasHidden = el.style.display === 'none';
  document.querySelectorAll('dialog[open]').forEach((d) => d.close()); // modals would make the card inert
  el.style.display = 'flex';
  el.dataset.mode = mode;
  document.getElementById('appbar').style.display = 'none';
  document.getElementById('appmain').style.display = 'none';
  const setup = mode === 'setup';
  document.getElementById('authTitle').textContent = T(setup ? 'auth.setupTitle' : 'auth.loginTitle');
  document.getElementById('authSub').textContent = T(setup ? 'auth.setupSub' : 'auth.loginSub');
  document.getElementById('authSubmitTxt').textContent = T(setup ? 'auth.create' : 'auth.signIn');
  document.getElementById('authHint').textContent = setup ? T('auth.setupHint') : '';
  document.getElementById('authConfirmField').hidden = !setup;
  const form = document.getElementById('authForm');
  form.password.autocomplete = setup ? 'new-password' : 'current-password';
  form.confirm.required = setup;
  if (wasHidden) form.user.focus(); // don't steal focus on every 401 poll
}
function hideAuth() {
  document.getElementById('auth').style.display = 'none';
  document.getElementById('appbar').style.display = '';
  document.getElementById('appmain').style.display = '';
}
const AUTH_ERRORS = {
  unauthorized: 'auth.errWrong', login_locked: 'auth.errLocked', setup_locked: 'auth.errLocked',
  invalid_credentials: 'auth.setupHint', already_initialized: 'auth.errInitialized',
  not_initialized: 'auth.errNotInitialized', store_unavailable: 'auth.errStore',
};
function authFail(text) {
  document.getElementById('authMsg').textContent = text;
  const card = document.querySelector('.auth-card');
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
}
document.getElementById('authForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const setup = document.getElementById('auth').dataset.mode === 'setup';
  document.getElementById('authMsg').textContent = '';
  if (setup && f.password.value !== f.confirm.value) { authFail(T('auth.mismatch')); f.confirm.focus(); return; }
  const btn = document.getElementById('authSubmit');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(setup ? '/admin/api/setup' : '/admin/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: f.user.value.trim(), password: f.password.value }),
    });
    if (res.ok) { location.reload(); return; }
    const body = await res.json().catch(() => ({}));
    const key = AUTH_ERRORS[body?.error?.type];
    authFail(key ? T(key) : (body?.error?.message || body?.error?.type || T('ui.failed')));
    f.password.select();
  } catch (err) {
    authFail(T('boot.failed'));
  } finally {
    btn.disabled = false;
    btn.setAttribute('aria-busy', 'false');
  }
});

// ---------- health pill in the top bar ----------

async function pollHealth() {
  const dot = document.getElementById('liveDot');
  const txt = document.getElementById('liveTxt');
  const pill = document.getElementById('health');
  try {
    const h = await (await fetch('/health', { credentials: 'same-origin' })).json();
    dot.className = 'dot' + (h.degraded ? ' err' : ' live');
    txt.textContent = h.degraded ? T('live.degraded') : T('live.ok');
    pill.title = T('live.detail', { idle: h.idle, live: h.live });
  } catch (e) {
    dot.className = 'dot off';
    txt.textContent = T('live.offline');
    pill.title = '';
  }
}
