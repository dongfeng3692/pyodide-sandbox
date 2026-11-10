// admin/page-styles.mjs — page-level layouts built on the shared tokens and
// components in styles.mjs: hero/KPI blocks (monitoring, logs, MCP), charts,
// event feed, log list + drawer, API doc layout, settings rows, sign-in card.

const HERO = `
  .hero{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr)}
  .hero-status{display:flex;flex-direction:column;gap:var(--s3);padding:var(--s5);border-right:1px solid var(--line);transition:background-color var(--dur-3)}
  .hero[data-state=warn] .hero-status{background:var(--warn-soft)}
  .hero[data-state=err] .hero-status{background:var(--err-soft)}
  .status-line{display:flex;align-items:center;gap:10px;font-size:var(--fs-h1);font-weight:600;line-height:1.3}
  .status-line .dot{width:10px;height:10px}
  .status-meta{font-size:var(--fs-sm);color:var(--text-2);font-variant-numeric:tabular-nums}
  .hero-kpis{padding:var(--s5);display:flex;flex-direction:column}
  .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--s4);margin-top:var(--s3)}
  .kpis.compact{grid-template-columns:repeat(6,minmax(0,1fr));margin-top:0}
  .kpi .k{font-size:var(--fs-xs);color:var(--text-3)}
  .kpi .v{font-size:var(--fs-display);font-weight:600;line-height:1.2;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin-top:var(--s1);white-space:nowrap}
  .kpis.compact .v{font-size:var(--fs-h1)}
  .kpis.compact .hint{display:none}
  .kpi .v small{font-size:var(--fs-sm);font-weight:500;color:var(--text-3);letter-spacing:0;margin-left:2px}
  .kpi .v.ok{color:var(--ok)} .kpi .v.warn{color:var(--warn)} .kpi .v.err{color:var(--err)}
  .kpi .hint{font-size:var(--fs-xs);color:var(--text-3);margin-top:2px;min-height:18px}
`;

const MONITORING = `
  .slots{display:flex;flex-wrap:wrap;gap:6px;margin-top:var(--s1)}
  .slot{width:22px;height:22px;border-radius:5px;border:1px solid var(--line-2);background:var(--surface-2);transition:background-color var(--dur-2),border-color var(--dur-2)}
  .slot.idle{background:var(--ok-soft);border-color:color-mix(in srgb,var(--ok) 50%,transparent)}
  .slot.busy{background:var(--acc);border-color:var(--acc)}
  .slot.booting,.slot.stopping{background:repeating-linear-gradient(-45deg,var(--surface-2) 0 4px,var(--line-2) 4px 6px)}
  .slot.empty{background:transparent;border-style:dashed}
  .pool-kv{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:var(--fs-sm);color:var(--text-2)}
  .pool-kv b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums;margin-right:4px}
  .ratio{display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--surface-2);margin-top:auto}
  .ratio i{display:block;height:100%;transition:width var(--dur-3) var(--ease-out)}
  .ratio .r-ok{background:var(--ok)} .ratio .r-blk{background:var(--acc)}
  .ratio .r-mdl{background:var(--warn)} .ratio .r-sys{background:var(--err)}
  .ratio-legend{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:var(--fs-xs);color:var(--text-3);margin-top:var(--s2);font-variant-numeric:tabular-nums}
  .ratio-legend .dot{width:6px;height:6px;margin-right:6px;vertical-align:1px}
  .ratio-wrap{margin-top:var(--s5)}
  .top-errors{margin-top:var(--s4);font-size:var(--fs-xs);color:var(--text-2);display:flex;flex-direction:column;gap:3px}
  .top-errors:empty{display:none}
  .top-errors .cap{margin-bottom:var(--s1)}
  .top-errors .te{display:flex;align-items:center;gap:8px;min-width:0}
  .top-errors .te .dot{flex:none}
  .top-errors .te .mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .top-errors .te .n{margin-left:auto;color:var(--text-3);font-variant-numeric:tabular-nums}

  .metric-now{font-size:var(--fs-h1);font-weight:600;letter-spacing:-.01em;line-height:1.3;font-variant-numeric:tabular-nums;white-space:nowrap}
  .metric-now small{font-size:var(--fs-xs);font-weight:500;color:var(--text-3);margin-left:2px}
  .chart{position:relative;height:180px;margin:var(--s3) var(--s5) var(--s4);color:var(--acc)}
  .chart svg{display:block;overflow:visible}
  .chart .grid{stroke:var(--line);stroke-dasharray:2 4}
  .chart .base{stroke:var(--line-2)}
  .chart .axis{fill:var(--text-3);font:11px var(--sans);font-variant-numeric:tabular-nums}
  .chart .series{fill:none;stroke:currentColor;stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round}
  .chart .series.draw{stroke-dasharray:1;stroke-dashoffset:1;animation:draw .7s var(--ease-out) forwards}
  .chart .area.draw{animation:fade .7s var(--ease-out) both}
  .chart .head{fill:currentColor;stroke:var(--surface);stroke-width:2}
  .chart .xhair{stroke:var(--text-3);stroke-width:1;stroke-dasharray:3 3}
  .chart-empty{display:flex;align-items:center;justify-content:center;height:100%;border:1px dashed var(--line-2);border-radius:var(--r-ctl);color:var(--text-3);font-size:var(--fs-sm)}
  .chart-tip{position:absolute;top:0;left:0;pointer-events:none;padding:6px 10px;background:var(--surface);border:1px solid var(--line-2);border-radius:var(--r-ctl);
    box-shadow:var(--shadow-pop);color:var(--text-2);font-size:var(--fs-xs);white-space:nowrap;font-variant-numeric:tabular-nums;opacity:0;transition:opacity var(--dur-1)}
  .chart-tip.on{opacity:1}
  .chart-tip b{color:var(--text);font-size:var(--fs-sm);font-weight:600;margin-right:6px}
  @keyframes draw{to{stroke-dashoffset:0}}

  .feed{list-style:none;padding:0;max-height:360px;overflow:auto}
  .feed li{display:grid;grid-template-columns:6px minmax(0,1fr);column-gap:var(--s3);padding:10px var(--s5);border-bottom:1px solid var(--line);transition:background-color 1s var(--ease-out)}
  .feed li:last-child{border-bottom:0}
  .feed li.fresh{background:var(--acc-soft);transition:none}
  .feed .sev{width:6px;height:6px;border-radius:50%;margin-top:8px;background:var(--text-3)}
  .feed .sev.warn{background:var(--warn)} .feed .sev.err{background:var(--err)}
  .ev-head{display:flex;justify-content:space-between;align-items:baseline;gap:var(--s3)}
  .ev-kind{font-size:var(--fs-sm);font-weight:500}
  .ev-time{font-size:var(--fs-xs);color:var(--text-3);white-space:nowrap;font-variant-numeric:tabular-nums}
  .ev-detail{font-family:var(--mono);font-size:var(--fs-xs);color:var(--text-2);word-break:break-all;margin-top:2px}

  /* last refresh failed: keep the numbers on screen but mark them stale */
  .kpis,.ratio-wrap,.pool-kv,.slots,.metric-now,.chart,.tbl,.feed{transition:opacity var(--dur-3)}
  .stale :is(.kpis,.ratio-wrap,.pool-kv,.slots,.metric-now,.chart,.tbl,.feed){opacity:.5}
`;

const LOGS = `
  .list-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);flex-wrap:wrap;padding:var(--s3) var(--s4);border-bottom:1px solid var(--line)}
  .rows tbody{transition:opacity var(--dur-2)}
  .rows tbody.busy{opacity:.5}
  .rows tbody tr[data-id]{cursor:pointer;transition:background-color var(--dur-1)}
  .rows tbody tr[data-id]:hover{background:var(--surface-2)}
  .rows tbody tr[aria-current]{background:var(--acc-soft)}
  .rows tbody tr[aria-current] td:first-child{box-shadow:inset 2px 0 0 var(--acc)}
  .rows tbody tr.fresh{background:var(--acc-soft);transition:none}
  .rows tbody tr[data-id]:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}
  .err-text{color:var(--err);font-size:var(--fs-xs)}
  .code-cell{max-width:360px;overflow:hidden;text-overflow:ellipsis;color:var(--text-2)}
  .code-line{font-size:var(--fs-xs)}
  .more{display:inline-block;margin-left:var(--s2);padding:0 5px;border-radius:4px;background:var(--surface-2);color:var(--text-3);font-size:11px}
  .dur{display:inline-flex;align-items:center;justify-content:flex-end;gap:0}
  .dur.warn{color:var(--warn)} .dur.warn .meter i{background:var(--warn)}
  .dur.err{color:var(--err)} .dur.err .meter i{background:var(--err)}
  .list-foot{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);padding:var(--s3) var(--s5);border-top:1px solid var(--line);font-size:var(--fs-xs)}
  .pager{display:flex;gap:var(--s1)}

  .drawer .dlg-body{display:flex;flex-direction:column;gap:var(--s3)}
  .drawer.loading .dlg-body{opacity:.55;transition:opacity var(--dur-2) .15s}
  .err-box{display:flex;align-items:center;gap:var(--s2);padding:10px var(--s3);border-radius:var(--r-ctl);background:var(--err-soft);color:var(--err);font-size:var(--fs-sm)}
`;

const API = `
  .doc{display:grid;grid-template-columns:168px minmax(0,1fr);gap:var(--s6);align-items:start}
  .toc{position:sticky;top:88px;display:flex;flex-direction:column;font-size:var(--fs-sm)}
  .toc a{color:var(--text-2);padding:6px 12px;border-left:2px solid var(--line);transition:color var(--dur-1),border-color var(--dur-2)}
  .toc a:hover{color:var(--text);text-decoration:none}
  .toc a.on{color:var(--text);border-left-color:var(--acc);font-weight:500}
  .doc-main>section{scroll-margin-top:80px}
  .endpoints{list-style:none;padding:0}
  .endpoints li{display:grid;grid-template-columns:56px 96px minmax(0,1fr) auto;align-items:center;gap:var(--s3);padding:12px var(--s5);border-bottom:1px solid var(--line)}
  .endpoints li:last-child{border-bottom:0}
  .path{font-family:var(--mono);font-size:var(--fs-sm);font-weight:600}
  .ep-desc{color:var(--text-2);font-size:var(--fs-sm)}
  .method{display:inline-block;font:600 11px/1 var(--mono);padding:5px 0;border-radius:4px;text-align:center}
  .method.post{color:var(--acc);background:var(--acc-soft)} .method.get{color:var(--ok);background:var(--ok-soft)}
  .prose p+p,.prose ul+p{margin-top:var(--s3)}
  .prose code{font-family:var(--mono);font-size:var(--fs-xs)}
  .auth-list{list-style:none;padding:0;margin-top:var(--s3);display:flex;flex-direction:column;gap:var(--s2)}
  .auth-list li{display:flex;align-items:center;gap:var(--s3)}
  .auth-list code{padding:4px 8px;border-radius:var(--r-ctl);background:var(--surface-2);border:1px solid var(--line)}
  .sub-title{font-size:var(--fs-sm);font-weight:600;margin:var(--s5) 0 var(--s3)}
`;

const MCP = `
  .switch.lg{width:44px;height:24px}
  .switch.lg::after{width:20px;height:20px}
  .switch.lg[aria-checked=true]::after{transform:translateX(20px)}
  .copy-field{display:flex;align-items:center;gap:var(--s2);margin:var(--s2) 0;padding:6px 6px 6px 12px;border:1px solid var(--line-2);border-radius:var(--r-ctl);background:var(--surface-2)}
  .copy-field code{flex:1;font-family:var(--mono);font-size:var(--fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tool-name{font-size:var(--fs-sm);font-weight:600;color:var(--text);margin-bottom:var(--s1)}
  .client-name{font-weight:500}
  .dimmable{transition:opacity var(--dur-3)}
  .is-off .dimmable{opacity:.55}
`;

const SETTINGS = `
  .setting{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2.2fr);gap:var(--s6);padding:var(--s6) 0;border-top:1px solid var(--line);margin:0}
  .setting:first-of-type{border-top:0;padding-top:var(--s2)}
  .setting-info h2{font-size:var(--fs-h2);font-weight:600}
  .setting-info p{font-size:var(--fs-sm);color:var(--text-2);margin-top:var(--s2)}
  .setting-body{display:flex;flex-direction:column;gap:var(--s3);min-width:0}
  .inline-form{display:flex;gap:var(--s2)}
  .inline-form input{flex:1;max-width:320px}
  .tok-name{font-weight:500}
  .form-stack{display:flex;flex-direction:column;gap:var(--s4);max-width:420px}
  .token-box{display:flex;align-items:center;gap:var(--s2);padding:10px 10px 10px 14px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface-2)}
  .token-box code{flex:1;font-family:var(--mono);font-size:var(--fs-body);letter-spacing:.02em;word-break:break-all;color:var(--text)}
`;

const AUTH = `
  .auth{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:var(--s4);
    background:radial-gradient(ellipse 80% 50% at 50% 0%,var(--acc-soft),transparent 70%),radial-gradient(var(--line) 1px,transparent 1px) 0 0/22px 22px,var(--bg)}
  .auth-tools{position:fixed;top:14px;right:16px;display:flex;gap:4px}
  .auth-tools button.ghost{padding:6px;display:inline-flex}
  .auth-card{width:min(380px,100%);padding:var(--s6);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-pop);box-shadow:var(--shadow-pop);
    animation:rise var(--dur-3) var(--ease-out) both}
  .auth-card.shake{animation:shake .4s var(--ease-out)}
  .auth-brand{display:flex;align-items:center;gap:var(--s2);font-family:var(--mono);font-size:var(--fs-sm);font-weight:600;color:var(--text-2)}
  .auth-brand b{color:var(--acc);font-weight:600}
  .auth-title{font-size:var(--fs-h1);font-weight:600;margin-top:var(--s5)}
  .auth-sub{font-size:var(--fs-sm);color:var(--text-2);margin:var(--s1) 0 var(--s5)}
  #authForm{display:flex;flex-direction:column;gap:var(--s4)}
  .auth-msg{color:var(--err);font-size:var(--fs-sm);min-height:0}
  .auth-msg:empty{display:none}
  .auth-hint{color:var(--text-3);font-size:var(--fs-xs)}
  .auth-hint:empty{display:none}
  @keyframes shake{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
`;

const PAGE_RESPONSIVE = `
  @media (max-width:1100px){
    .doc{grid-template-columns:minmax(0,1fr)}
    .toc{display:none}
  }
  @media (max-width:860px){
    .hero{grid-template-columns:minmax(0,1fr)}
    .hero-status{border-right:0;border-bottom:1px solid var(--line)}
    .kpis.compact{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:var(--s4)}
    .setting{grid-template-columns:minmax(0,1fr);gap:var(--s4)}
    .endpoints li{grid-template-columns:56px minmax(0,1fr) auto}
    .endpoints .ep-desc{grid-column:2 / -1;grid-row:2}
  }
  @media (max-width:760px){
    .kpis{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:var(--s5)}
    .hero-status,.hero-kpis{padding:var(--s4)}
    .chart{margin:var(--s3) var(--s4) var(--s4)}
    .feed li{padding:10px var(--s4)}
    .list-head{padding:var(--s3)}
    .search,.search input{width:100%}
    .list-foot{padding:var(--s3) var(--s4)}
  }
`;

export const PAGE_CSS = HERO + MONITORING + LOGS + API + MCP + SETTINGS + AUTH + PAGE_RESPONSIVE;
