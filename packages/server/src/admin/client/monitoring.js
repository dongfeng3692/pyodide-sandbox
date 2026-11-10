// admin/client/monitoring.js — monitoring page. Inlined by shell.mjs after
// base.js + charts.js; runs inside the post-auth async boot block.

const WINDOWS = [[900, '15m'], [3600, '1h'], [86400, '24h']];
const STATS_WINDOW_S = 86400;
const SUCCESS_GOOD = 0.9;
const SUCCESS_BAD = 0.6;
const EVENT_SEVERITY = {
  boot_error: 'err', pool_degraded: 'err', admin_login_lockout: 'err',
  rss_recycle: 'warn', timeout_retire: 'warn',
};
const WORKER_DOT = { idle: 'dot', busy: 'dot busy', booting: 'dot off', stopping: 'dot off' };

const $ = (id) => document.getElementById(id);
const qsWindow = Number(new URLSearchParams(location.search).get('window'));
let win = WINDOWS.some(([v]) => v === qsWindow) ? qsWindow : 3600;
let animateCharts = true;
let lastHost = null;
let lastPoints = [];
let newestEventTs = null;

const cpuChart = createChart($('cpuChart'), { unit: '%', label: T('mon.cpu') });
const memChart = createChart($('memChart'), { unit: ' MB', label: T('mon.mem') });

function tone(el, kind) {
  el.classList.remove('ok', 'warn', 'err');
  if (kind) el.classList.add(kind);
}
function fmtMs(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(2) + '<small>s</small>' : ms + '<small>ms</small>';
}

// ---------- hero: status + pool ----------

function poolState(p) {
  if (p.degraded) return ['err', 'mon.degraded'];
  if (p.live === 0) return ['warn', 'mon.starting'];
  if (p.waiting > 0) return ['warn', 'mon.busy'];
  return ['ok', 'mon.ok'];
}

function renderStatus(kind, label, meta) {
  $('hero').dataset.state = kind;
  $('statusDot').className = 'dot ' + kind + (kind === 'ok' ? ' live' : '');
  setStat('statusTxt', esc(label));
  if (meta != null) $('statusMeta').textContent = meta;
}

function renderSlots(p) {
  const box = $('slots');
  if (box.querySelector('.sk')) box.innerHTML = '';
  const workers = [...p.workers].sort((a, b) => a.id - b.id);
  const n = Math.max(p.pool, workers.length);
  while (box.children.length < n) box.appendChild(document.createElement('span'));
  while (box.children.length > n) box.lastChild.remove();
  [...box.children].forEach((el, i) => {
    const w = workers[i];
    const state = w ? w.state : 'empty';
    el.className = 'slot ' + state;
    el.title = w ? '#' + w.id + ' · ' + T('wk.' + state) + ' · ' + w.calls + ' ' + T('wk.calls') : T('wk.empty');
  });
  box.setAttribute('aria-label', T('mon.slots', { live: p.live, size: p.pool }));
  setStat('slotsCount', p.live + '/' + p.pool);
}

function renderPool(p, h) {
  const [kind, key] = poolState(p);
  renderStatus(kind, T(key), 'pid ' + h.pid + ' · ' + T('mon.upFor', { d: fmtDuration(h.uptimeS) }));
  renderSlots(p);
  setStat('kvIdle', String(p.idle));
  setStat('kvBusy', String(p.pending));
  setStat('kvQueue', String(p.waiting));
  tone($('kvQueue'), p.waiting > 0 ? 'warn' : null);
}

// ---------- hero: last 24h executions ----------

function renderKpis(m) {
  const hasCalls = m.total > 0;
  setStat('kCalls', m.total.toLocaleString());
  const rate = m.successRate;
  tone($('kRate'), rate == null ? null : rate >= SUCCESS_GOOD ? 'ok' : rate < SUCCESS_BAD ? 'err' : 'warn');
  setStat('kRate', rate == null ? '—' : (rate * 100).toFixed(1) + '<small>%</small>');
  // headline keeps the historical ok/total semantics; the hint tells the
  // story once by-design blocks are excluded (only shown when they exist)
  const fc = m.failClasses ?? { blocked: 0, model: 0, system: 0 };
  $('kRateHint').textContent = rate != null && fc.blocked > 0 && m.successRateExBlocked != null
    ? T('mon.rateExBlocked', { pct: (m.successRateExBlocked * 100).toFixed(1) }) : '';
  setStat('kP95', m.p95Ms == null ? '—' : fmtMs(m.p95Ms));
  // failures only alarm when something actually needs attention: system
  // errors are red, model-side failures amber, pure blocks stay neutral
  tone($('kFail'), fc.system > 0 ? 'err' : fc.model > 0 ? 'warn' : null);
  setStat('kFail', m.failCount.toLocaleString());
  const parts = [];
  if (fc.blocked) parts.push(T('cls.blocked') + ' ' + fc.blocked.toLocaleString());
  if (fc.model) parts.push(T('cls.model') + ' ' + fc.model.toLocaleString()
    + (m.timeouts ? '（' + T('mon.timeoutsN', { n: m.timeouts }) + '）' : ''));
  if (fc.system) parts.push(T('cls.system') + ' ' + fc.system.toLocaleString());
  $('kFailHint').textContent = parts.join(' · ');

  const pct = (n) => (hasCalls ? (n / m.total) * 100 : 0);
  $('rOk').style.width = pct(m.okCount) + '%';
  $('rBlk').style.width = pct(fc.blocked) + '%';
  $('rMdl').style.width = pct(fc.model) + '%';
  $('rSys').style.width = pct(fc.system) + '%';
  // legend dots reuse the global .dot color variants: (ok) / .busy / .warn / .err
  const legendItem = (dotCls, label) =>
    '<span><span class="dot' + (dotCls ? ' ' + dotCls : '') + '"></span>' + esc(label) + '</span>';
  $('rLegend').innerHTML = hasCalls
    ? legendItem('', T('mon.okN', { n: m.okCount }))
      + (fc.blocked ? legendItem('busy', T('cls.blocked') + ' ' + fc.blocked) : '')
      + (fc.model ? legendItem('warn', T('cls.model') + ' ' + fc.model) : '')
      + (fc.system ? legendItem('err', T('cls.system') + ' ' + fc.system) : '')
    : '<span>' + esc(T('mon.noCalls')) + ' <a href="/admin/api-doc">' + esc(T('mon.noCallsLink')) + ' →</a></span>';
}

// failure-class dots/badges reuse the global variants: acc = blocked (by
// design, not alarming), warn = model-side, err = system
const DOT_BY_CLS = { blocked: 'busy', model: 'warn', system: 'err' };

function renderTopErrors(errors) {
  const box = $('topErrors');
  if (!box) return;
  const rows = (errors ?? []).filter((e) => e.n > 0).slice(0, 5);
  box.innerHTML = rows.length
    ? '<div class="cap">' + esc(T('mon.topErrors')) + '</div>' + rows.map((e) =>
      '<div class="te"><span class="dot ' + (DOT_BY_CLS[e.cls] || 'err') + '"></span>' +
      '<span class="mono">' + esc(e.type + (e.code ? ' · ' + e.code : '')) + '</span>' +
      '<span class="n">' + esc(e.n.toLocaleString()) + '</span></div>').join('')
    : '';
}

// ---------- workers + events ----------

function renderWorkers(p) {
  const workers = [...p.workers].sort((a, b) => a.id - b.id);
  setStat('wkCount', String(workers.length));
  $('workerRows').innerHTML = workers.map((w) => {
    const elu = w.eluPct == null ? '—'
      : '<span class="meter"><i style="width:' + esc(Math.min(100, w.eluPct)) + '%"></i></span>' + esc(w.eluPct) + '%';
    return '<tr><td class="mono faint">#' + esc(w.id) + '</td>' +
      '<td><span class="state"><span class="' + (WORKER_DOT[w.state] || 'dot off') + '"></span>' + esc(T('wk.' + w.state)) + '</span></td>' +
      '<td class="r num">' + esc(w.calls) + '</td>' +
      '<td class="r num">' + (w.heapMb == null ? '—' : esc(w.heapMb) + ' MB') + '</td>' +
      '<td class="r num">' + elu + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="empty">' + esc(T('mon.noWorkers')) + '</td></tr>';
}

function eventLabel(kind) {
  return I18N.en['ev.' + kind] ? T('ev.' + kind) : kind;
}
// pool events report raw byte counts ("rss=561405952") — show them in MB/GB
function eventDetail(detail) {
  return String(detail).replace(/\brss=(\d{6,})\b/g, (m, bytes) => 'rss=' + fmtMb(Number(bytes) / 1048576));
}

function renderEvents(events) {
  const list = $('events');
  if (!events.length) {
    list.innerHTML = '<li class="empty" style="display:block">' + esc(T('events.none')) + '</li>';
    return;
  }
  const prev = newestEventTs;
  list.innerHTML = events.map((e) => {
    const fresh = prev != null && e.ts > prev;
    return '<li' + (fresh ? ' class="fresh"' : '') + '><span class="sev ' + (EVENT_SEVERITY[e.kind] || '') + '"></span><div>' +
      '<div class="ev-head"><span class="ev-kind">' + esc(eventLabel(e.kind)) + '</span>' +
      '<time class="ev-time" title="' + esc(new Date(e.ts).toLocaleString()) + '">' + esc(ago(e.ts)) + '</time></div>' +
      (e.detail ? '<div class="ev-detail">' + esc(eventDetail(e.detail)) + '</div>' : '') + '</div></li>';
  }).join('');
  newestEventTs = events[0].ts;
  // let the highlight paint once, then fade it out via the li transition
  requestAnimationFrame(() => requestAnimationFrame(() => {
    list.querySelectorAll('li.fresh').forEach((li) => li.classList.remove('fresh'));
  }));
}

// ---------- charts + current values ----------

function renderNow() {
  const last = lastPoints[lastPoints.length - 1];
  const cpu = last ? last.cpu : lastHost?.cpuPct;
  setStat('cpuNow', cpu == null ? '—' : cpu + '<small>%</small>');
  if (!lastHost) return;
  setStat('memNow', Math.round(lastHost.rssMb) + '<small>MB</small>');
  $('memSub').textContent = T('mon.memSub', { free: fmtMb(lastHost.sysFreeMb) });
}

async function loadSamples(animate) {
  const reqWin = win;
  const s = await api('/admin/api/samples?window=' + reqWin);
  if (reqWin !== win) return; // range changed while in flight
  lastPoints = s.points ?? [];
  const now = Date.now();
  const domain = [now - reqWin * 1000, now];
  cpuChart.update(lastPoints.map((p) => ({ ts: p.ts, v: p.cpu })), domain, animate);
  memChart.update(lastPoints.map((p) => ({ ts: p.ts, v: p.rssMb })), domain, animate);
  if (lastPoints.length) animateCharts = false;
  renderNow();
}

async function loadMetrics() {
  const m = await api('/admin/api/metrics?window=' + STATS_WINDOW_S);
  if (!m.ok) throw new Error(m.error?.type || 'metrics_failed');
  lastHost = m.host;
  renderPool(m.pool, m.host);
  renderKpis(m);
  renderWorkers(m.pool);
  renderEvents(m.events);
  renderTopErrors(m.errors);
  renderNow();
}

async function refresh() {
  const upd = $('updated');
  upd.classList.add('loading');
  try {
    await Promise.all([loadMetrics(), loadSamples(animateCharts)]);
    upd.classList.remove('err');
    $('appmain').classList.remove('stale');
    $('updatedAlert').textContent = '';
    $('updatedTxt').textContent = T('mon.updated', { t: clockTime(Date.now()) });
  } catch (e) {
    if (e.message === 'unauthorized') return; // auth overlay is already up
    upd.classList.add('err');
    $('appmain').classList.add('stale'); // keep the last values, but dimmed
    $('updatedTxt').textContent = T('mon.updateFailed');
    $('updatedAlert').textContent = T('mon.updateFailed');
    renderStatus('err', T('mon.offline'), null);
  } finally {
    upd.classList.remove('loading');
  }
}

segmented($('win'), WINDOWS, win, (v) => {
  win = v;
  const url = new URL(location.href);
  url.searchParams.set('window', String(v));
  history.replaceState(null, '', url);
  loadSamples(true).catch(() => { $('updated').classList.add('err'); $('updatedTxt').textContent = T('mon.updateFailed'); });
});

refresh();
every(5000, refresh);
