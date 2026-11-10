// admin/client/mcp.js — MCP gateway page: on/off switch (confirm before
// disabling), endpoint with copy, client-config snippets, connected sessions.

const $ = (id) => document.getElementById(id);
let mcpOn = null;
let sessions = [];

const endpoint = location.origin + '/mcp';
$('mcpUrl').textContent = endpoint;
bindCopy($('mcpUrlCopy'), () => endpoint);

codeBlock($('mcpSnips'), [
  { label: T('mcp.tabConfig'), code: mcpConfigSnippet() },
  { label: 'Claude Code', code: claudeCodeSnippet() },
  { label: 'curl', code: mcpCurlSnippet() },
]);

function renderState() {
  $('mcpHero').dataset.state = mcpOn ? 'on' : 'off';
  $('mcpPage').classList.toggle('is-off', !mcpOn);
  setMcpSwitch(mcpOn);
  $('mcpStateTxt').textContent = mcpOn ? T('mcp.on') : T('mcp.off');
  $('mcpStateDot').className = 'dot ' + (mcpOn ? 'live' : 'off');
  $('mcpStateHint').textContent = mcpOn ? T('mcp.onHint') : T('mcp.offHint');
}

function renderSessions() {
  setStat('sessCount', String(sessions.length));
  const tb = $('sessRows');
  if (!sessions.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">' + esc(T(mcpOn ? 'mcp.noClients' : 'mcp.noClientsOff')) + '</td></tr>';
    return;
  }
  tb.innerHTML = sessions.map((s) =>
    '<tr data-id="' + esc(s.id) + '"><td><span class="client-name">' + esc(s.client) + '</span>' +
      (s.version ? ' <span class="faint mono">' + esc(s.version) + '</span>' : '') + '</td>' +
    '<td class="mono dim">' + esc(s.protocol || '—') + '</td>' +
    '<td class="dim num" title="' + esc(new Date(s.created).toLocaleString()) + '">' + esc(ago(s.created)) + '</td>' +
    '<td class="dim num">' + esc(ago(s.lastSeen)) + '</td>' +
    '<td class="r num">' + esc(s.calls) + '</td>' +
    '<td class="r"><button type="button" class="ghost danger" data-drop>' + esc(T('mcp.drop')) + '</button></td></tr>').join('');
}

async function load() {
  try {
    const d = await api('/admin/api/mcp');
    if (!d.ok) throw new Error(d.error?.type || 'mcp_failed');
    mcpOn = d.enabled;
    sessions = d.sessions;
    renderState();
    renderSessions();
  } catch (e) {
    if (e.message !== 'unauthorized') toast(T('ui.loadFailed'), 'err');
  }
}

const setMcpSwitch = bindSwitch($('mcpSwitch'), async (next) => {
  if (!next) {
    const sure = await confirmDialog({
      title: T('mcp.confirmOffTitle'),
      body: sessions.length ? T('mcp.confirmOffBodyN', { n: sessions.length }) : T('mcp.confirmOffBody'),
      ok: T('mcp.disable'),
      danger: true,
    });
    if (!sure) return;
  }
  const sw = $('mcpSwitch');
  sw.disabled = true;
  try {
    await mutate('/admin/api/mcp', 'POST', { enabled: next });
    toast(next ? T('mcp.enabledToast') : T('mcp.disabledToast'));
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message, 'err');
  } finally {
    sw.disabled = false;
    load();
  }
});

$('sessRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-drop]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  setBusy(btn, true);
  try {
    // ok:false only means the session had already ended — the outcome is the same
    await api('/admin/api/mcp/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
    toast(T('mcp.dropped'));
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'err');
  } finally {
    load();
  }
});

load();
every(5000, load);
