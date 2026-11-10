// admin/pages.mjs — the five admin pages. Chrome, styles, strings and the
// client runtime live in shell.mjs / styles.mjs / i18n.mjs / client/*.js.
// Monitoring uses the new panel layout; logs/api/mcp/settings still use the
// original flat layout until they are migrated.

import { ICONS } from './icons.mjs';
import { shell, zh, CLIENT } from './shell.mjs';

const i18n = (key, tag = 'span', attrs = '') => `<${tag} data-i18n="${key}"${attrs ? ' ' + attrs : ''}>${zh(key)}</${tag}>`;
const sk = (width) => `<span class="sk"${width ? ` style="width:${width}"` : ''}></span>`;

function kpi(key, id, hintId = '') {
  return `<div class="kpi">${i18n(key, 'div', 'class="k"')}<div class="v" id="${id}">${sk('3em')}</div>` +
    `<div class="hint"${hintId ? ` id="${hintId}"` : ''}></div></div>`;
}

function chartPanel({ title, sub, subId, nowId, chartId }) {
  const subHtml = sub ? i18n(sub, 'p', 'class="panel-sub"') : `<p class="panel-sub" id="${subId}">${sk('10em')}</p>`;
  return `<div class="panel">
      <div class="panel-head"><div>${i18n(title, 'h3', 'class="panel-title"')}${subHtml}</div>
        <div class="metric-now" id="${nowId}">${sk('3em')}</div></div>
      <div class="chart" id="${chartId}"><span class="sk block"></span></div>
    </div>`;
}

export function dashboardPage() {
  const skRows = `<tr><td colspan="5"><span class="sk line"></span></td></tr>`.repeat(2);
  const skFeed = `<li><span></span><div><span class="sk line"></span><span class="sk line" style="width:60%"></span></div></li>`.repeat(3);
  const body = `
    <section class="panel hero" id="hero" data-state="ok">
      <div class="hero-status">
        <div class="status-line"><span class="dot off" id="statusDot"></span><span id="statusTxt">${sk('6em')}</span></div>
        <div class="status-meta" id="statusMeta">${sk('12em')}</div>
        <div>
          <div class="cap">${i18n('mon.workers')}<span class="count num" id="slotsCount"></span></div>
          <div class="slots" id="slots" role="img">${sk('8em')}</div>
        </div>
        <div class="pool-kv">
          <span><b id="kvIdle">—</b>${i18n('mon.idle')}</span>
          <span><b id="kvBusy">—</b>${i18n('mon.inflight')}</span>
          <span><b id="kvQueue">—</b>${i18n('mon.queue')}</span>
        </div>
      </div>
      <div class="hero-kpis">
        ${i18n('mon.last24', 'div', 'class="cap"')}
        <div class="kpis">
          ${kpi('st.calls', 'kCalls')}${kpi('st.rate', 'kRate', 'kRateHint')}${kpi('st.p95', 'kP95')}${kpi('st.fail', 'kFail', 'kFailHint')}
        </div>
        <div class="ratio-wrap">
          <div class="ratio"><i class="r-ok" id="rOk" style="width:0"></i><i class="r-blk" id="rBlk" style="width:0"></i><i class="r-mdl" id="rMdl" style="width:0"></i><i class="r-sys" id="rSys" style="width:0"></i></div>
          <div class="ratio-legend" id="rLegend"></div>
        </div>
        <div class="top-errors" id="topErrors"></div>
      </div>
    </section>

    <section>
      <div class="section-head">${i18n('mon.trends', 'h2', 'class="section-title"')}<div class="seg" id="win" role="group"></div></div>
      <div class="grid-2">
        ${chartPanel({ title: 'mon.cpu', sub: 'mon.cpuSub', nowId: 'cpuNow', chartId: 'cpuChart' })}
        ${chartPanel({ title: 'mon.mem', subId: 'memSub', nowId: 'memNow', chartId: 'memChart' })}
      </div>
    </section>

    <section class="grid-7-5">
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">${i18n('mon.workerList')}<span class="count num" id="wkCount"></span></h3></div>
        <div class="panel-flush" style="overflow-x:auto"><table class="tbl">
          <thead><tr><th>#</th>${i18n('wk.state', 'th')}${i18n('wk.calls', 'th', 'class="r"')}${i18n('mon.heap', 'th', 'class="r"')}${i18n('mon.elu', 'th', 'class="r"')}</tr></thead>
          <tbody id="workerRows">${skRows}</tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head">${i18n('mon.events', 'h3', 'class="panel-title"')}</div>
        <ul class="feed panel-flush" id="events">${skFeed}</ul>
      </div>
    </section>`;
  const actions = `<span class="updated loading" id="updated"><span class="spin" aria-hidden="true"></span><span id="updatedTxt"></span><span class="sr-only" id="updatedAlert" role="alert"></span></span>`;
  return shell({ page: 'monitoring', body, js: CLIENT.charts + CLIENT.monitoring, actions });
}

// ---------- logs ----------

// blocked ⊃ the legacy `policy` filter (which the API still accepts); the
// timeout chip stays because timeout is an orthogonal, pre-existing axis.
const LOG_FILTERS = [['all', 'logs.filterAll'], ['failed', 'logs.filterFailed'],
  ['blocked', 'logs.filterBlocked'], ['model', 'logs.filterModel'], ['system', 'logs.filterSystem'],
  ['timeout', 'logs.filterTimeout']];

function switchLabel(id, key) {
  return `<label class="switch-label"><button type="button" class="switch" role="switch" id="${id}" aria-checked="false"></button>${i18n(key)}</label>`;
}

export function logsPage() {
  const skRows = `<tr><td colspan="6"><span class="sk line"></span></td></tr>`.repeat(6);
  const chips = LOG_FILTERS.map(([f, key]) =>
    `<button type="button" class="chip" data-filter="${f}" aria-pressed="${f === 'all'}">${i18n(key)}<span class="n num"></span></button>`).join('');
  const body = `
    <section class="panel">
      <div class="kpis compact panel-body">
        ${kpi('st.calls', 'l-calls')}${kpi('st.rate', 'l-rate')}${kpi('st.fail', 'l-fail')}
        ${kpi('st.timeouts', 'l-timeouts')}${kpi('st.p95', 'l-p95')}${kpi('logs.mcp', 'l-mcp')}
      </div>
    </section>

    <section class="panel">
      <div class="list-head">
        <div class="chips" role="group" aria-label="filter">${chips}</div>
        <div class="search">${ICONS.search}
          <input id="q" type="search" autocomplete="off" data-i18n-ph="logs.search" placeholder="${zh('logs.search')}" aria-label="${zh('logs.search')}">
          <button type="button" class="ghost icon-btn" id="qClear" hidden data-i18n-title="ui.clear">${ICONS.x}</button>
        </div>
      </div>
      <div class="tbl-wrap"><table class="tbl rows">
        <thead><tr>${i18n('logs.time', 'th')}${i18n('logs.source', 'th')}${i18n('logs.result', 'th')}${i18n('logs.error', 'th')}${i18n('logs.dur', 'th', 'class="r"')}${i18n('logs.code', 'th')}</tr></thead>
        <tbody id="rows">${skRows}</tbody></table></div>
      <div class="list-foot">
        <span class="faint num" id="pageInfo"></span>
        <div class="pager">
          <button type="button" class="icon-btn" id="prev" data-i18n-title="ui.prevPage" disabled>${ICONS.chevronLeft}</button>
          <button type="button" class="icon-btn" id="next" data-i18n-title="ui.nextPage" disabled>${ICONS.chevronRight}</button>
        </div>
      </div>
    </section>

    <dialog class="drawer" id="drawer" aria-labelledby="dTitle">
      <div class="dlg-head">
        <h2 class="dlg-title" id="dTitle"></h2><span id="dStatus"></span><span class="grow"></span>
        <button type="button" class="ghost icon-btn" id="dPrev" data-i18n-title="logs.prevRec">${ICONS.chevronUp}</button>
        <button type="button" class="ghost icon-btn" id="dNext" data-i18n-title="logs.nextRec">${ICONS.chevronDown}</button>
        <button type="button" class="ghost icon-btn" id="dClose" data-i18n-title="ui.close">${ICONS.x}</button>
      </div>
      <div class="dlg-body" tabindex="-1" autofocus>
        <dl class="kv-grid" id="dMeta"></dl>
        <div class="err-box" id="dError" hidden>${ICONS.alert}<span class="mono" id="dErrorText"></span></div>
        ${i18n('logs.code', 'h3', 'class="cap block-cap"')}<div id="dCode"></div>
        ${i18n('logs.stdout', 'h3', 'class="cap block-cap"')}<div id="dOut"></div>${i18n('logs.noStdout', 'p', 'class="faint" id="dOutEmpty" hidden')}
      </div>
    </dialog>`;
  return shell({ page: 'logs', body, js: CLIENT.logs, actions: switchLabel('auto', 'logs.auto') });
}

// ---------- API reference ----------

// [type, http status, retryable, description key]
const ERROR_ROWS = [
  ['PolicyError', 200, true, 'err.policy'],
  ['ValueError, …', 200, true, 'err.runtime'],
  ['unauthorized', 401, false, 'err.unauthorized'],
  ['no_tokens_configured', 401, false, 'err.no_tokens_configured'],
  ['invalid_json', 422, false, 'err.invalid_json'],
  ['invalid_code', 422, false, 'err.invalid_code'],
  ['invalid_files', 422, false, 'err.invalid_files'],
  ['too_many_files', 422, false, 'err.too_many_files'],
  ['file_too_large', 422, false, 'err.file_too_large'],
  ['execution_timeout', 408, false, 'err.execution_timeout'],
  ['queue_full', 429, true, 'err.queue_full'],
  ['execution_unavailable', 500, true, 'err.execution_unavailable'],
  ['pool_degraded', 503, false, 'err.pool_degraded'],
  ['shutting_down', 503, false, 'err.shutting_down'],
];
const POLICY_CODES = ['forbidden_syntax', 'forbidden_name', 'forbidden_attribute', 'forbidden_store', 'syntax_error', 'code_too_large'];
const API_TOC = [['quick', 'api.quick'], ['endpoints', 'api.title'], ['auth', 'api.auth'], ['reqres', 'api.reqres'], ['limits', 'api.limits'], ['errors', 'api.errors']]
  .map(([id, key]) => [`doc-${id}`, key]);

function endpointRow(method, path, descKey, authKey) {
  return `<li><span class="method ${method.toLowerCase()}">${method}</span><code class="path">${path}</code>` +
    `${i18n(descKey, 'span', 'class="ep-desc"')}${i18n(authKey, 'span', `class="tag${authKey === 'api.public' ? '' : ' acc'}"`)}</li>`;
}

function sectionHead(key, aux = '') {
  return `<div class="section-head">${i18n(key, 'h2', 'class="section-title"')}${aux}</div>`;
}

function fieldRow(name, type, reqKey, descKey) {
  const badge = reqKey === 'api.required' ? 'acc' : 'off';
  return `<tr><td class="mono">${name}</td><td class="mono faint">${type}</td>` +
    `<td>${i18n(reqKey, 'span', `class="badge ${badge}"`)}</td>${i18n(descKey, 'td', 'class="dim wrap"')}</tr>`;
}

function fieldTable() {
  return `<table class="tbl">
    <thead><tr>${i18n('api.field', 'th')}${i18n('api.type', 'th')}<th></th>${i18n('api.desc', 'th')}</tr></thead>
    <tbody>${fieldRow('code', 'string', 'api.required', 'api.codeDesc')}${fieldRow('files', 'array', 'api.optional', 'api.filesDesc')}</tbody></table>`;
}

export function apiPage() {
  const toc = API_TOC.map(([id, key], i) => `<a href="#${id}"${i === 0 ? ' class="on"' : ''}>${i18n(key)}</a>`).join('');
  const errRows = ERROR_ROWS.map(([type, status, retry, key]) =>
    `<tr><td class="mono">${type}</td><td class="num">${status}</td>` +
    `<td>${retry ? `<span class="badge ok">${i18n('api.yes')}</span>` : `<span class="faint">${i18n('api.no')}</span>`}</td>` +
    `${i18n(key, 'td', 'class="dim wrap"')}</tr>`).join('');
  const policyRows = POLICY_CODES.map((c) => `<tr><td class="mono">${c}</td>${i18n(`pol.${c}`, 'td', 'class="dim wrap"')}</tr>`).join('');
  const body = `
    <div class="doc">
      <nav class="toc" aria-label="contents">${toc}</nav>
      <div class="doc-main">
        <section id="doc-quick">
          ${sectionHead('api.quick', `<span class="faint small">${i18n('api.quickHint')} · <a href="/admin/settings">${i18n('api.tokensNote')}</a></span>`)}
          <div id="quickstart"></div>
        </section>
        <section id="doc-endpoints">
          ${sectionHead('api.title')}
          <ul class="panel endpoints">
            ${endpointRow('POST', '/exec', 'api.execDesc', 'api.needsToken')}
            ${endpointRow('GET', '/health', 'api.healthDesc', 'api.public')}
            ${endpointRow('POST', '/mcp', 'api.mcpDesc', 'api.needsToken')}
          </ul>
        </section>
        <section id="doc-auth">
          ${sectionHead('api.auth')}
          <div class="panel panel-body prose">
            ${i18n('api.authDesc', 'p')}
            <ul class="auth-list">
              <li><span class="tag">HTTP</span><code>x-sbx-token: &lt;token&gt;</code></li>
              <li><span class="tag acc">MCP</span><code>Authorization: Bearer &lt;token&gt;</code></li>
            </ul>
            <p class="faint small">${i18n('api.authNote')} <a href="/admin/settings">${i18n('api.tokensNote')} →</a></p>
          </div>
        </section>
        <section id="doc-reqres">
          ${sectionHead('api.reqres')}
          <div class="grid-2">
            <div class="panel">
              <div class="panel-head"><div>${i18n('api.reqBody', 'h3', 'class="panel-title"')}<p class="panel-sub mono">POST /exec · application/json</p></div></div>
              <div class="tbl-wrap panel-flush">${fieldTable()}</div>
            </div>
            <div class="panel">
              <div class="panel-head"><div>${i18n('api.response', 'h3', 'class="panel-title"')}${i18n('api.responseSub', 'p', 'class="panel-sub"')}</div></div>
              <div class="panel-body"><div id="responses"></div></div>
            </div>
          </div>
        </section>
        <section id="doc-limits">
          ${sectionHead('api.limits', '<span class="tag" id="presetTag"></span>')}
          <div class="panel panel-body"><dl class="kv-grid" id="limitsGrid">${`<div><dt>${sk('5em')}</dt><dd>${sk('3em')}</dd></div>`.repeat(8)}</dl></div>
        </section>
        <section id="doc-errors">
          ${sectionHead('api.errors')}
          <div class="panel tbl-wrap"><table class="tbl">
            <thead><tr>${i18n('api.errType', 'th')}${i18n('api.http', 'th')}${i18n('api.retryable', 'th')}${i18n('api.desc', 'th')}</tr></thead>
            <tbody>${errRows}</tbody></table></div>
          ${i18n('api.policyCodes', 'h3', 'class="sub-title"')}
          <div class="panel tbl-wrap"><table class="tbl">
            <thead><tr><th>error.code</th>${i18n('api.desc', 'th')}</tr></thead>
            <tbody>${policyRows}</tbody></table></div>
        </section>
      </div>
    </div>`;
  return shell({ page: 'api', body, js: CLIENT.api });
}

// ---------- MCP ----------

export function mcpPage() {
  const body = `
    <div id="mcpPage">
    <section class="panel hero" id="mcpHero" data-state="off">
      <div class="hero-status">
        <div class="status-line"><span class="dot off" id="mcpStateDot"></span><span id="mcpStateTxt">${sk('5em')}</span>
          <span class="grow"></span><button type="button" class="switch lg" role="switch" id="mcpSwitch" aria-checked="false" data-i18n-title="mcp.toggle"></button></div>
        <p class="status-meta" id="mcpStateHint"></p>
      </div>
      <div class="hero-kpis">
        ${i18n('mcp.endpoint', 'div', 'class="cap"')}
        <div class="copy-field"><code id="mcpUrl"></code><button type="button" class="ghost icon-btn" id="mcpUrlCopy" data-i18n-title="ui.copy">${ICONS.copy}</button></div>
        <p class="faint small">${i18n('mcp.authLine')} · <a href="/admin/settings">${i18n('api.tokensNote')} →</a></p>
      </div>
    </section>

    <section class="grid-7-5 dimmable">
      <div class="panel">
        <div class="panel-head"><div>${i18n('mcp.snippet', 'h3', 'class="panel-title"')}${i18n('mcp.snippetSub', 'p', 'class="panel-sub"')}</div></div>
        <div class="panel-body"><div id="mcpSnips"></div></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div>${i18n('mcp.tool', 'h3', 'class="panel-title"')}${i18n('mcp.toolSub', 'p', 'class="panel-sub"')}</div></div>
        <div class="panel-body"><div class="tool-name mono">execute_code</div>${i18n('mcp.toolDesc', 'p', 'class="dim small"')}</div>
        <div class="tbl-wrap">${fieldTable()}</div>
      </div>
    </section>

    <section class="dimmable">
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">${i18n('mcp.clients')}<span class="count num" id="sessCount"></span></h3></div>
        <div class="tbl-wrap panel-flush"><table class="tbl">
          <thead><tr>${i18n('mcp.client', 'th')}${i18n('mcp.protocol', 'th')}${i18n('mcp.connected', 'th')}${i18n('mcp.lastSeen', 'th')}${i18n('mcp.callsN', 'th', 'class="r"')}<th></th></tr></thead>
          <tbody id="sessRows"><tr><td colspan="6"><span class="sk line"></span></td></tr></tbody></table></div>
      </div>
    </section>
    </div>`;
  return shell({ page: 'mcp', body, js: CLIENT.mcp });
}

// ---------- settings ----------

function pwField(name, key, autocomplete) {
  return `<div class="field"><label for="pw-${name}" data-i18n="${key}">${zh(key)}</label>` +
    `<input id="pw-${name}" name="${name}" type="password" autocomplete="${autocomplete}" required></div>`;
}

export function settingsPage() {
  const body = `
    <section class="setting">
      <div class="setting-info">
        <h2>${i18n('tok.title')}<span class="count num" id="tokCount"></span></h2>
        ${i18n('tok.desc', 'p')}
        <p><a href="/admin/api-doc">${i18n('tok.usageLink')} →</a></p>
      </div>
      <div class="setting-body">
        <form class="inline-form" id="createForm" novalidate>
          <input id="tokName" maxlength="64" autocomplete="off" data-i18n-ph="tok.name" placeholder="${zh('tok.name')}" aria-label="${zh('tok.name')}">
          <button type="submit" class="primary" id="createBtn">${ICONS.plus}${i18n('tok.create')}</button>
        </form>
        <p class="field-msg err" id="tokMsg" role="alert"></p>
        <div class="panel tbl-wrap"><table class="tbl">
          <thead><tr>${i18n('tok.colName', 'th')}${i18n('tok.colPrefix', 'th')}${i18n('tok.colStatus', 'th')}${i18n('tok.colCreated', 'th')}${i18n('tok.colUsed', 'th')}<th></th></tr></thead>
          <tbody id="tokRows"><tr><td colspan="6"><span class="sk line"></span></td></tr></tbody></table></div>
      </div>
    </section>

    <section class="setting">
      <div class="setting-info">
        <h2>${i18n('pkg.title')}<span class="count num" id="pkgCount"></span></h2>
        ${i18n('pkg.desc', 'p')}
        <p class="faint small">${i18n('pkg.note')}</p>
      </div>
      <div class="setting-body">
        <div class="note warn" id="pkgPending" hidden>${ICONS.alert}<span id="pkgPendingTxt"></span></div>
        <form class="inline-form" id="pkgInstallForm" novalidate>
          <input id="pkgSpec" maxlength="200" autocomplete="off" spellcheck="false"
            data-i18n-ph="pkg.spec" placeholder="${zh('pkg.spec')}" aria-label="${zh('pkg.spec')}">
          <button type="submit" class="primary" id="pkgInstallBtn">${ICONS.plus}${i18n('pkg.install')}</button>
        </form>
        <p class="field-msg" id="pkgMsg" role="alert"></p>
        <p class="small dim" id="pkgJob" hidden></p>
        <div class="panel tbl-wrap"><table class="tbl">
          <thead><tr>${i18n('pkg.colName', 'th')}${i18n('pkg.colSource', 'th')}${i18n('pkg.colVersion', 'th')}${i18n('pkg.colAliases', 'th')}${i18n('pkg.colHint', 'th')}<th></th></tr></thead>
          <tbody id="pkgRows"><tr><td colspan="6"><span class="sk line"></span></td></tr></tbody></table></div>
        <p><button type="button" class="ghost" id="pkgReset">${i18n('pkg.reset')}</button></p>
      </div>
    </section>

    <section class="setting">
      <div class="setting-info">
        <h2>${i18n('acct.title')}</h2>
        <p>${i18n('sess.as')} <b class="mono" id="acctUser"></b> · ${i18n('sess.note')}</p>
        <p><button type="button" id="logoutHere">${ICONS.logout}${i18n('auth.logout')}</button></p>
      </div>
      <div class="setting-body">
        <div class="note" id="pinnedNote" hidden>${ICONS.alert}${i18n('pw.pinned')}</div>
        <form class="panel panel-body form-stack" id="pwForm" novalidate>
          ${i18n('pw.title', 'h3', 'class="panel-title"')}
          ${pwField('cur', 'pw.current', 'current-password')}
          ${pwField('next', 'pw.new', 'new-password')}
          ${pwField('confirm', 'pw.confirm', 'new-password')}
          <p class="field-msg" id="pwMsg" role="alert"></p>
          <div><button type="submit" class="primary">${i18n('pw.change')}</button></div>
        </form>
      </div>
    </section>

    <dialog class="modal wide" id="newDlg" aria-labelledby="newTitle">
      <div class="dlg-head">${i18n('tok.createdTitle', 'h2', 'class="dlg-title" id="newTitle"')}</div>
      <div class="dlg-body">
        <div class="note warn">${ICONS.alert}${i18n('tok.onceWarn')}</div>
        <div class="token-box"><code id="newTok"></code><button type="button" class="ghost icon-btn" id="newCopy" data-i18n-title="ui.copy">${ICONS.copy}</button></div>
        ${i18n('tok.usage', 'h3', 'class="cap block-cap"')}
        <div id="newSnip"></div>
      </div>
      <div class="dlg-foot"><button type="button" class="primary" id="newDone">${i18n('tok.done')}</button></div>
    </dialog>`;
  return shell({ page: 'settings', body, js: CLIENT.settings });
}
