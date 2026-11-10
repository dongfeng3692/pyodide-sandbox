// admin/client/settings.js — API tokens (create / enable switch / delete with
// confirm, one-time reveal dialog), the injectable dependency manifest
// (install / remove / reset — applies on restart) and the admin account
// (password change).

const $ = (id) => document.getElementById(id);
const NAME_MAX = 64;
const PW_MIN = 8;
let tokens = [];

function fmtTime(ts) { return ts == null ? '' : new Date(ts).toLocaleString(); }

// ---------- tokens ----------

function tokenRow(t) {
  return '<tr data-id="' + esc(t.id) + '">' +
    '<td><span class="tok-name">' + esc(t.name) + '</span></td>' +
    '<td class="mono faint">' + esc(t.prefix) + '…</td>' +
    '<td><button type="button" class="switch" role="switch" aria-checked="' + Boolean(t.enabled) + '" data-toggle aria-label="' +
      esc(T(t.enabled ? 'tok.disable' : 'tok.enable')) + '"></button></td>' +
    '<td class="dim num" title="' + esc(fmtTime(t.created_ts)) + '">' + esc(ago(t.created_ts)) + '</td>' +
    '<td class="dim num"' + (t.last_used_ts ? ' title="' + esc(fmtTime(t.last_used_ts)) + '">' + esc(ago(t.last_used_ts)) : '><span class="faint">' + esc(T('tok.never')) + '</span>') + '</td>' +
    '<td class="r"><button type="button" class="ghost danger icon-btn" data-del title="' + esc(T('tok.delete')) + '" aria-label="' +
      esc(T('tok.delete')) + '">' + ICONS.trash + '</button></td></tr>';
}

function renderTokens() {
  const active = document.activeElement;
  const focusRow = active?.closest?.('#tokRows tr[data-id]')?.dataset.id;
  const focusSel = active?.matches?.('[data-toggle]') ? '[data-toggle]' : '[data-del]';
  setStat('tokCount', String(tokens.length));
  $('tokRows').innerHTML = tokens.length
    ? tokens.map(tokenRow).join('')
    : '<tr><td colspan="6"><div class="empty-state">' + ICONS.key + '<p class="empty-title">' + esc(T('tok.emptyTitle')) + '</p><p>' + esc(T('tok.empty')) + '</p></div></td></tr>';
  if (focusRow) $('tokRows').querySelector('tr[data-id="' + CSS.escape(focusRow) + '"] ' + focusSel)?.focus();
}

async function loadTokens() {
  try {
    const d = await api('/admin/api/tokens');
    if (!d.ok) throw new Error(d.error?.type || 'tokens_failed');
    tokens = d.tokens;
    renderTokens();
  } catch (e) {
    if (e.message !== 'unauthorized') toast(T('ui.loadFailed'), 'err');
  }
}

$('tokRows').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const tok = tokens.find((t) => String(t.id) === tr.dataset.id);
  if (!tok) return;
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    // aria-busy (not disabled) guards double clicks: disabling the focused
    // switch would drop keyboard focus before the table re-renders
    if (toggle.getAttribute('aria-busy') === 'true') return;
    const next = !tok.enabled;
    toggle.setAttribute('aria-checked', String(next)); // optimistic
    toggle.setAttribute('aria-busy', 'true');
    try {
      await mutate('/admin/api/tokens/' + tok.id, 'PATCH', { enabled: next });
      toast(T(next ? 'tok.enabledToast' : 'tok.disabledToast', { name: tok.name }));
    } catch (err) {
      toggle.setAttribute('aria-checked', String(!next)); // roll back
      if (err.message !== 'unauthorized') toast(err.message, 'err');
    } finally {
      loadTokens();
    }
    return;
  }
  if (e.target.closest('[data-del]')) {
    const sure = await confirmDialog({
      title: T('tok.confirmDelTitle'),
      body: T('tok.confirmDelBody', { name: tok.name }),
      ok: T('tok.delete'),
      danger: true,
    });
    if (!sure) return;
    try {
      await mutate('/admin/api/tokens/' + tok.id, 'DELETE');
      toast(T('tok.deletedToast', { name: tok.name }));
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, 'err');
    } finally {
      loadTokens();
    }
  }
});

// create + one-time reveal
const newDlg = $('newDlg');
const newSnips = codeBlock($('newSnip'), execSnippetTabs());
bindCopy($('newCopy'), () => $('newTok').textContent);
$('newDone').addEventListener('click', () => newDlg.close());

$('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('tokName');
  const msg = $('tokMsg');
  const name = input.value.trim();
  msg.textContent = '';
  if (!name || name.length > NAME_MAX) {
    msg.textContent = T('tok.invalidName');
    input.focus();
    return;
  }
  const btn = $('createBtn');
  setBusy(btn, true);
  try {
    const d = await mutate('/admin/api/tokens', 'POST', { name });
    input.value = '';
    $('newTok').textContent = d.token;
    newSnips.set(execSnippetTabs(d.token));
    newDlg.showModal();
    loadTokens();
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'err');
  } finally {
    setBusy(btn, false);
  }
});

// ---------- injectable dependency manifest (packages) ----------

const SOURCE_LABEL = { pyodide: 'pkg.src.pyodide', pypi: 'pkg.src.pypi', wheel: 'pkg.src.wheel', stdlib: 'pkg.src.stdlib' };
let pkgData = null;
let pkgTimer = null;

function pkgRow(e, isPending) {
  const aliases = Object.keys(e.aliases || {});
  const src = T(SOURCE_LABEL[e.source] || e.source || 'pyodide');
  return '<tr data-name="' + esc(e.name) + '">' +
    '<td><span class="tok-name mono">' + esc(e.name) + '</span>' + (isPending ? ' <span class="badge acc">' + esc(T('pkg.pendingBadge')) + '</span>' : '') + '</td>' +
    '<td><span class="tag">' + esc(src) + '</span></td>' +
    '<td class="dim num">' + esc(e.version || '') + '</td>' +
    '<td class="mono faint">' + esc(aliases.join(', ') || '—') + '</td>' +
    '<td class="dim small wrap" title="' + esc(e.hint || '') + '">' + esc(e.hint || '') + '</td>' +
    '<td class="r"><button type="button" class="ghost danger icon-btn" data-pkg-del title="' + esc(T('pkg.remove')) + '" aria-label="' +
      esc(T('pkg.remove')) + '">' + ICONS.trash + '</button></td></tr>';
}

function renderPackages() {
  if (!pkgData) return;
  const pend = pkgData.pending || [];
  const isPending = pkgData.restartRequired;
  setStat('pkgCount', String((isPending ? pend : pkgData.active || []).length));
  const rows = isPending ? pend : (pkgData.active || []);
  $('pkgRows').innerHTML = rows.length
    ? rows.map(function (e) { return pkgRow(e, isPending); }).join('')
    : '<tr><td colspan="6"><div class="empty-state">' + ICONS.api + '<p class="empty-title">' + esc(T('pkg.emptyTitle')) + '</p><p>' + esc(T('pkg.empty')) + '</p></div></td></tr>';
  const pendingEl = $('pkgPending');
  pendingEl.hidden = !isPending;
  if (isPending) $('pkgPendingTxt').textContent = T('pkg.pendingNote');
}

async function loadPackages() {
  try {
    const d = await api('/admin/api/packages');
    if (!d.ok) throw new Error(d.error?.type || 'packages_failed');
    pkgData = d;
    renderPackages();
    const job = d.install || {};
    if (job.phase === 'resolving' || job.phase === 'downloading' || job.phase === 'verifying' || job.phase === 'committing') {
      $('pkgJob').hidden = false;
      $('pkgJob').textContent = T('pkg.jobRunning', { spec: job.spec || '', phase: T('pkg.phase.' + job.phase) });
      if (!pkgTimer) pkgTimer = setInterval(loadPackages, 2000);
    } else {
      $('pkgJob').hidden = true;
      if (pkgTimer) { clearInterval(pkgTimer); pkgTimer = null; }
    }
  } catch (e) {
    if (e.message !== 'unauthorized') toast(T('ui.loadFailed'), 'err');
  }
}

$('pkgRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-pkg-del]');
  if (!btn) return;
  const tr = btn.closest('tr[data-name]');
  const name = tr?.dataset.name;
  if (!name || !pkgData) return;
  const sure = await confirmDialog({
    title: T('pkg.confirmDelTitle'),
    body: T('pkg.confirmDelBody', { name }),
    ok: T('pkg.remove'),
    danger: true,
  });
  if (!sure) return;
  const next = (pkgData.restartRequired ? pkgData.pending : pkgData.active)
    .filter(function (x) { return x && x.name !== name; });
  try {
    await mutate('/admin/api/packages', 'POST', { packages: next });
    toast(T('pkg.removedToast', { name }));
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'err');
  } finally {
    loadPackages();
  }
});

$('pkgInstallForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('pkgSpec');
  const msg = $('pkgMsg');
  const spec = input.value.trim();
  msg.textContent = '';
  msg.className = 'field-msg';
  if (!spec) { input.focus(); return; }
  const btn = $('pkgInstallBtn');
  setBusy(btn, true);
  try {
    await mutate('/admin/api/packages/install', 'POST', { spec });
    toast(T('pkg.installStarted', { spec }));
    input.value = '';
    if (!pkgTimer) pkgTimer = setInterval(loadPackages, 2000);
    loadPackages();
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'err');
  } finally {
    setBusy(btn, false);
  }
});

$('pkgReset').addEventListener('click', async () => {
  const sure = await confirmDialog({
    title: T('pkg.resetTitle'),
    body: T('pkg.resetBody'),
    ok: T('pkg.reset'),
    danger: true,
  });
  if (!sure) return;
  try {
    await mutate('/admin/api/packages/reset', 'POST');
    toast(T('pkg.resetToast'));
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'err');
  } finally {
    loadPackages();
  }
});

// ---------- account ----------

$('acctUser').textContent = ADMIN_USER || '';
$('pinnedNote').hidden = ADMIN_SOURCE !== 'config';
$('pwForm').hidden = ADMIN_SOURCE === 'config';
$('logoutHere').addEventListener('click', () => $('logoutBtn').click());

$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('pwMsg');
  const say = (text, ok) => { msg.textContent = text; msg.className = 'field-msg ' + (ok ? 'ok' : 'err'); };
  if (f.next.value.length < PW_MIN) { say(T('pw.short'), false); f.next.focus(); return; }
  if (f.next.value !== f.confirm.value) { say(T('pw.mismatch'), false); f.confirm.focus(); return; }
  const btn = f.querySelector('button[type=submit]');
  setBusy(btn, true);
  try {
    const res = await fetch('/admin/api/password', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current: f.cur.value, next: f.next.value }),
    });
    if (res.ok) { say(T('pw.ok'), true); f.reset(); return; }
    const body = await res.json().catch(() => ({}));
    const type = body?.error?.type;
    say(type === 'unauthorized' ? T('pw.wrong') : type === 'config_pinned' ? T('pw.pinned') : (body?.error?.message || T('ui.failed')), false);
  } catch (err) {
    say(T('boot.failed'), false);
  } finally {
    setBusy(btn, false);
  }
});

loadTokens();
loadPackages();
