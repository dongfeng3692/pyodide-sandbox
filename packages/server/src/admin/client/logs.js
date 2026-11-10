// admin/client/logs.js — execution log viewer: 24h summary, filter chips with
// counts, debounced search, URL-persisted state, keyboard-navigable rows and
// a detail drawer. Inlined after base/ui/snippets inside the boot block.

const LOGS_LIMIT = 50;
// blocked ⊃ the legacy 'policy' filter the API still accepts; timeout stays
// as its own chip (orthogonal, pre-existing axis)
const FILTERS = ['all', 'failed', 'blocked', 'model', 'system', 'timeout'];
const SEARCH_DEBOUNCE_MS = 300;
const SLOW_MS = 1000;
const AUTO_KEY = 'sbx-logs-auto';
const SUCCESS_GOOD = 0.9;
const SUCCESS_BAD = 0.6;

const $ = (id) => document.getElementById(id);
const initial = new URLSearchParams(location.search);
const state = {
  filter: FILTERS.includes(initial.get('filter')) ? initial.get('filter') : 'all',
  q: (initial.get('q') || '').slice(0, 200),
  offset: Math.max(0, (parseInt(initial.get('page'), 10) || 1) - 1) * LOGS_LIMIT,
};
let rows = [];
let total = 0;
let timeoutMs = 60000;
let newestId = null;
let openId = null;
let loadSeq = 0;

function tone(el, kind) {
  el.classList.remove('ok', 'warn', 'err');
  if (kind) el.classList.add(kind);
}

function syncUrl() {
  const url = new URL(location.href);
  const set = (k, v, dflt) => (v === dflt ? url.searchParams.delete(k) : url.searchParams.set(k, v));
  set('filter', state.filter, 'all');
  set('q', state.q, '');
  set('page', String(Math.floor(state.offset / LOGS_LIMIT) + 1), '1');
  history.replaceState(null, '', url);
}

function logsQuery(filter, limit, offset) {
  return '/admin/api/logs?limit=' + limit + '&offset=' + offset + '&filter=' + filter + '&q=' + encodeURIComponent(state.q);
}

// ---------- summary + chip counts ----------

async function loadStats() {
  const m = await api('/admin/api/metrics?window=86400');
  if (!m.ok) return;
  setStat('l-calls', m.total.toLocaleString());
  tone($('l-rate'), m.successRate == null ? null : m.successRate >= SUCCESS_GOOD ? 'ok' : m.successRate < SUCCESS_BAD ? 'err' : 'warn');
  setStat('l-rate', m.successRate == null ? '—' : (m.successRate * 100).toFixed(1) + '<small>%</small>');
  tone($('l-fail'), m.failCount ? 'err' : null);
  setStat('l-fail', m.failCount.toLocaleString());
  tone($('l-timeouts'), m.timeouts ? 'warn' : null);
  setStat('l-timeouts', m.timeouts.toLocaleString());
  setStat('l-p95', m.p95Ms == null ? '—' : m.p95Ms >= 1000 ? (m.p95Ms / 1000).toFixed(2) + '<small>s</small>' : m.p95Ms + '<small>ms</small>');
  setStat('l-mcp', m.mcpCalls.toLocaleString());
}

async function loadCounts() {
  const totals = await Promise.all(FILTERS.map((f) => api(logsQuery(f, 1, 0)).then((d) => d.total).catch(() => null)));
  FILTERS.forEach((f, i) => {
    const el = document.querySelector('.chip[data-filter="' + f + '"] .n');
    if (el) el.textContent = totals[i] == null ? '' : totals[i].toLocaleString();
  });
}

// ---------- table ----------

function errorText(r) {
  if (r.timeout) return 'execution_timeout';
  if (r.ok) return '';
  return (r.error_type || '?') + (r.error_code ? ' · ' + r.error_code : '');
}

// status by failure class (timeout stays most specific — it says why the
// model-side failure happened): blocked = by design, model = the code ran
// and failed, system = infrastructure. Falls back to the generic label for
// rows recorded before classification existed.
function statusOf(r) {
  if (r.timeout) return ['dot warn', T('logs.timeout')];
  if (r.ok) return ['dot', T('logs.ok')];
  if (r.fail_class === 'blocked') return ['dot busy', T('cls.blocked')];
  if (r.fail_class === 'model') return ['dot warn', T('cls.model')];
  if (r.fail_class === 'system') return ['dot err', T('cls.system')];
  return ['dot err', T('logs.fail')];
}

function durationCell(ms) {
  if (ms == null) return '—';
  const pct = Math.min(100, (Math.log1p(ms) / Math.log1p(timeoutMs)) * 100);
  const cls = ms >= timeoutMs / 2 ? ' err' : ms >= SLOW_MS ? ' warn' : '';
  const label = ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms';
  return '<span class="dur' + cls + '"><span class="meter"><i style="width:' + pct.toFixed(1) + '%"></i></span>' + esc(label) + '</span>';
}

function codeCell(preview) {
  const text = String(preview ?? '');
  const lines = text.split('\n');
  const first = lines[0] + (lines.length === 1 && text.length >= 120 ? '…' : '');
  const more = lines.length > 1 ? '<span class="more">↵ ' + (lines.length - 1) + '</span>' : '';
  return '<span class="code-line">' + esc(first) + '</span>' + more;
}

function rowHtml(r) {
  const src = (r.source ?? 'http').toLowerCase();
  const fresh = newestId != null && r.id > newestId;
  const status = statusOf(r);
  return '<tr data-id="' + esc(r.id) + '" tabindex="0"' + (fresh ? ' class="fresh"' : '') + (String(r.id) === String(openId) ? ' aria-current="true"' : '') + '>' +
    '<td class="faint num" title="' + esc(new Date(r.ts).toLocaleString()) + '">' + esc(ago(r.ts)) + '</td>' +
    '<td><span class="tag' + (src === 'mcp' ? ' acc' : '') + '">' + esc(src.toUpperCase()) + '</span></td>' +
    '<td><span class="state"><span class="' + status[0] + '"></span>' + esc(status[1]) + '</span></td>' +
    '<td class="mono err-text">' + esc(errorText(r)) + '</td>' +
    '<td class="r num">' + durationCell(r.duration_ms) + '</td>' +
    '<td class="mono code-cell">' + codeCell(r.code_preview) + '</td></tr>';
}

function emptyHtml() {
  const filtered = state.filter !== 'all' || state.q;
  return '<tr><td colspan="6"><div class="empty-state">' + ICONS.inbox +
    '<p class="empty-title">' + esc(T(filtered ? 'logs.noMatch' : 'logs.empty')) + '</p>' +
    (filtered
      ? '<button type="button" id="clearFilters">' + esc(T('logs.clearFilters')) + '</button>'
      : '<p>' + esc(T('logs.emptyHint')) + ' <a href="/admin/api-doc">' + esc(T('logs.emptyLink')) + ' →</a></p>') +
    '</div></td></tr>';
}

function renderRows() {
  const tbody = $('rows');
  const focusedId = document.activeElement?.closest?.('#rows tr[data-id]')?.dataset.id;
  tbody.innerHTML = rows.length ? rows.map(rowHtml).join('') : emptyHtml();
  if (focusedId) tbody.querySelector('tr[data-id="' + CSS.escape(focusedId) + '"]')?.focus();
  if (openId != null) navButtons();
  $('clearFilters')?.addEventListener('click', () => { state.filter = 'all'; state.q = ''; $('q').value = ''; applyQuery(); });
  if (rows.length) newestId = Math.max(newestId ?? 0, ...rows.map((r) => r.id));
  requestAnimationFrame(() => requestAnimationFrame(() => tbody.querySelectorAll('tr.fresh').forEach((tr) => tr.classList.remove('fresh'))));

  const from = total ? state.offset + 1 : 0;
  const to = Math.min(state.offset + LOGS_LIMIT, total);
  $('pageInfo').hidden = total === 0;
  $('pageInfo').textContent = T('logs.range', { from: from.toLocaleString(), to: to.toLocaleString(), total: total.toLocaleString() });
  $('prev').disabled = state.offset === 0;
  $('next').disabled = state.offset + LOGS_LIMIT >= total;
}

async function loadRows() {
  const seq = ++loadSeq;
  const tbody = $('rows');
  const busyTimer = setTimeout(() => tbody.classList.add('busy'), 150);
  try {
    const d = await api(logsQuery(state.filter, LOGS_LIMIT, state.offset));
    if (seq !== loadSeq) return; // a newer query superseded this one
    if (!d.ok) throw new Error(d.error?.type || 'logs_failed');
    total = d.total;
    if (state.offset >= total && total > 0) { // page vanished (retention sweep / new filter)
      state.offset = Math.floor((total - 1) / LOGS_LIMIT) * LOGS_LIMIT;
      syncUrl();
      loadRows();
      return;
    }
    rows = d.rows;
    renderRows();
  } catch (e) {
    if (e.message !== 'unauthorized' && seq === loadSeq) toast(T('logs.loadFailed'), 'err');
  } finally {
    clearTimeout(busyTimer);
    if (seq === loadSeq) tbody.classList.remove('busy');
  }
}

function applyQuery() {
  state.offset = 0;
  newestId = null;
  document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.filter === state.filter)));
  $('qClear').hidden = !state.q;
  syncUrl();
  loadRows();
  loadCounts();
}

// ---------- detail drawer ----------

const drawer = $('drawer');
closeOnBackdrop(drawer);
const codeView = codeBlock($('dCode'), [{ label: '', code: '' }]);
const outView = codeBlock($('dOut'), [{ label: '', code: '' }], { wrap: true });

function kv(label, value, wide) {
  return '<div' + (wide ? ' class="wide"' : '') + '><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';
}

function bytes(n) {
  if (n == null) return '—';
  return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
}

function renderDetail(r) {
  const status = r.timeout ? ['badge warn', T('logs.timeout')] : r.ok ? ['badge ok', T('logs.ok')]
    : r.fail_class === 'blocked' ? ['badge acc', T('cls.blocked')]
    : r.fail_class === 'model' ? ['badge warn', T('cls.model')]
    : r.fail_class === 'system' ? ['badge err', T('cls.system')]
    : ['badge err', T('logs.fail')];
  $('dTitle').textContent = T('logs.execN', { id: r.id });
  $('dStatus').className = status[0];
  $('dStatus').textContent = status[1];
  $('dMeta').innerHTML =
    kv(T('logs.time'), esc(new Date(r.ts).toLocaleString()) + ' <span class="faint">· ' + esc(ago(r.ts)) + '</span>', true) +
    kv(T('logs.source'), '<span class="tag' + (r.source === 'mcp' ? ' acc' : '') + '">' + esc(String(r.source ?? 'http').toUpperCase()) + '</span>') +
    kv(T('logs.dur'), r.duration_ms == null ? '—' : esc(r.duration_ms + ' ms')) +
    kv(T('api.preset'), esc(r.preset || '—')) +
    kv(T('logs.class'), r.fail_class ? esc(T('cls.' + r.fail_class)) : '—') +
    kv(T('logs.codeSize'), esc(bytes(r.code_bytes))) +
    kv(T('logs.files'), esc(r.files_count ?? '—')) +
    kv(T('logs.resultSize'), esc(bytes(r.result_bytes)));
  const err = errorText(r);
  $('dError').hidden = !err;
  $('dErrorText').textContent = err;
  codeView.set([{ label: '', code: r.code || T('logs.notStored') }]);
  const out = r.stdout_preview || '';
  $('dOut').hidden = !out;
  $('dOutEmpty').hidden = Boolean(out);
  outView.set([{ label: '', code: out }]);
}

function navButtons() {
  const i = rows.findIndex((r) => String(r.id) === String(openId));
  $('dPrev').disabled = i <= 0;
  $('dNext').disabled = i < 0 || i >= rows.length - 1;
}

async function openDetail(id) {
  openId = id;
  document.querySelectorAll('#rows tr[aria-current]').forEach((tr) => tr.removeAttribute('aria-current'));
  document.querySelector('#rows tr[data-id="' + CSS.escape(String(id)) + '"]')?.setAttribute('aria-current', 'true');
  navButtons();
  drawer.classList.add('loading');
  if (!drawer.open) drawer.showModal();
  try {
    const r = await api('/admin/api/logs/' + encodeURIComponent(id));
    if (String(openId) !== String(id)) return;
    // the payload spreads the DB row, whose own `ok` column (0 for failed
    // runs) shadows the envelope flag — an id is the success signal here
    if (r.id == null) throw new Error(r.error?.type || 'not_found');
    renderDetail(r);
  } catch (e) {
    if (e.message !== 'unauthorized') toast(T('logs.loadFailed'), 'err');
  } finally {
    drawer.classList.remove('loading');
  }
}

function step(delta) {
  const i = rows.findIndex((r) => String(r.id) === String(openId));
  const next = rows[i + delta];
  if (next) openDetail(next.id);
}

drawer.addEventListener('close', () => {
  const tr = document.querySelector('#rows tr[data-id="' + CSS.escape(String(openId)) + '"]');
  tr?.removeAttribute('aria-current');
  tr?.focus();
  openId = null;
});
drawer.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea')) return;
  const arrowsFree = !e.target.closest('pre'); // arrows scroll a focused code block
  if (e.key === 'j' || (e.key === 'ArrowDown' && arrowsFree)) { e.preventDefault(); step(1); }
  if (e.key === 'k' || (e.key === 'ArrowUp' && arrowsFree)) { e.preventDefault(); step(-1); }
});
$('dPrev').addEventListener('click', () => step(-1));
$('dNext').addEventListener('click', () => step(1));
$('dClose').addEventListener('click', () => drawer.close());

// ---------- wiring ----------

$('rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDetail(tr.dataset.id);
});
$('rows').addEventListener('keydown', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(tr.dataset.id); }
  if (e.key === 'ArrowDown') { e.preventDefault(); tr.nextElementSibling?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); tr.previousElementSibling?.focus(); }
});

document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
  if (state.filter === chip.dataset.filter) return;
  state.filter = chip.dataset.filter;
  applyQuery();
}));

let searchTimer = null;
$('q').value = state.q;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = $('q').value.trim().slice(0, 200); applyQuery(); }, SEARCH_DEBOUNCE_MS);
});
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); state.q = $('q').value.trim().slice(0, 200); applyQuery(); }
  if (e.key === 'Escape' && $('q').value) { e.preventDefault(); $('q').value = ''; state.q = ''; applyQuery(); }
});
$('qClear').addEventListener('click', () => { $('q').value = ''; state.q = ''; applyQuery(); $('q').focus(); });

$('prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - LOGS_LIMIT); syncUrl(); loadRows(); });
$('next').addEventListener('click', () => { state.offset += LOGS_LIMIT; syncUrl(); loadRows(); });

let autoOn = false;
try { autoOn = localStorage.getItem(AUTO_KEY) === '1'; } catch (e) { /* default off */ }
const setAuto = bindSwitch($('auto'), (on) => {
  autoOn = on;
  setAuto(on);
  try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (e) { /* not persisted */ }
  if (on) { loadRows(); loadStats(); loadCounts(); }
});
setAuto(autoOn);

every(5000, async () => {
  if (!autoOn || drawer.open) return;
  await Promise.all([loadRows(), loadStats().catch(() => {}), loadCounts()]);
});

api('/admin/api/config').then((c) => { if (c.ok && c.pool?.execTimeoutMs) timeoutMs = c.pool.execTimeoutMs; }).catch(() => {})
  .finally(() => {
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.filter === state.filter)));
    $('qClear').hidden = !state.q;
    loadRows();
  });
loadStats().catch(() => {});
loadCounts();
