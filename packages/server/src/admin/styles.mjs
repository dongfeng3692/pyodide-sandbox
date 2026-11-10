// admin/styles.mjs — design tokens + shell + shared components.
import { PAGE_CSS } from './page-styles.mjs';

// Direction: "quiet console" — one accent, surfaces for primary content,
// hairlines inside them, tabular numerals, motion only for loading, state
// change and spatial movement (all of it disabled under reduced motion).

const TOKENS = `
  @view-transition{navigation:auto}
  :root{
    color-scheme:dark;
    --bg:#0b0d12; --surface:#11151c; --surface-2:#171c25; --line:#1f2632; --line-2:#2a3242;
    --text:#e6e9ef; --text-2:#a3acbd; --text-3:#7d8698;
    --acc:#5b9dff; --acc-fg:#0b0d12; --acc-soft:rgba(91,157,255,.14);
    --ok:#3fb972; --ok-soft:rgba(63,185,114,.14);
    --warn:#d6a02a; --warn-soft:rgba(214,160,42,.14);
    --err:#ec5f57; --err-soft:rgba(236,95,87,.13);
    --bar-bg:rgba(11,13,18,.82); --backdrop:rgba(4,6,9,.6);
    --shadow-panel:none; --shadow-pop:0 12px 32px rgba(0,0,0,.45); --shadow-knob:0 1px 2px rgba(0,0,0,.35);
    --sk-a:rgba(255,255,255,.035); --sk-b:rgba(255,255,255,.085);

    --sans:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    --mono:ui-monospace,"Cascadia Code","SF Mono",Consolas,Menlo,monospace;
    --fs-display:28px; --fs-h1:20px; --fs-h2:15px; --fs-body:14px; --fs-sm:13px; --fs-xs:12px;
    --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px;
    --r-ctl:6px; --r-panel:10px; --r-pop:12px;
    --dur-1:120ms; --dur-2:200ms; --dur-3:280ms;
    --ease-out:cubic-bezier(.2,.8,.2,1); --ease-in:cubic-bezier(.4,0,1,1);

  }
  :root[data-theme=light]{
    color-scheme:light;
    --bg:#f5f6f8; --surface:#ffffff; --surface-2:#f0f2f5; --line:#e4e7ec; --line-2:#d3d8e0;
    --text:#161b26; --text-2:#4b5565; --text-3:#646d7e;
    --acc:#2b66d0; --acc-fg:#ffffff; --acc-soft:rgba(43,102,208,.10);
    --ok:#16834d; --ok-soft:rgba(22,131,77,.10);
    --warn:#9a6b0f; --warn-soft:rgba(176,124,20,.12);
    --err:#c4372d; --err-soft:rgba(196,55,45,.09);
    --bar-bg:rgba(245,246,248,.85); --backdrop:rgba(22,27,38,.32);
    --shadow-panel:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.05);
    --shadow-pop:0 16px 40px rgba(16,24,40,.16); --shadow-knob:0 1px 2px rgba(16,24,40,.12);
    --sk-a:rgba(16,24,40,.045); --sk-b:rgba(16,24,40,.09);
  }
`;

const BASE = `
  *{box-sizing:border-box;margin:0}
  [hidden]{display:none !important}
  html{scroll-behavior:smooth}
  html{background:var(--bg)}
  body{background:var(--bg);color:var(--text);font:var(--fs-body)/1.55 var(--sans);-webkit-font-smoothing:antialiased}
  a{color:var(--acc);text-decoration:none;transition:color var(--dur-1)}
  a:hover{text-decoration:underline;text-underline-offset:3px}
  button{cursor:pointer}
  button,input,select{background:var(--surface-2);border:1px solid var(--line-2);color:var(--text);border-radius:var(--r-ctl);padding:7px 12px;font:inherit;
    transition:border-color var(--dur-1),background-color var(--dur-1),color var(--dur-1),transform var(--dur-1)}
  button:hover{border-color:var(--acc)}
  button:active:not(:disabled){transform:translateY(1px)}
  button:disabled{opacity:.45;cursor:not-allowed}
  input:focus,select:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-soft)}
  :focus-visible{outline:2px solid var(--acc);outline-offset:2px}
  input:focus-visible,select:focus-visible{outline:none}
  button.primary{background:var(--acc);border-color:var(--acc);color:var(--acc-fg);font-weight:600}
  button.primary:hover{filter:brightness(1.1)}
  button.ghost{background:transparent;border-color:transparent;color:var(--text-2);padding:5px 8px}
  button.ghost:hover{color:var(--text);background:var(--surface-2)}
  button.danger{color:var(--err)}
  button.danger:hover{border-color:var(--err)}
  button.ghost.danger:hover{border-color:transparent;background:var(--err-soft)}
  button.danger-solid{background:var(--err);border-color:var(--err);color:#fff;font-weight:600}
  button.danger-solid:hover{filter:brightness(1.08)}
  button{display:inline-flex;align-items:center;gap:6px}
  button.block{width:100%;justify-content:center}
  button.icon-btn{padding:6px;justify-content:center}
  button.copied{color:var(--ok)}
  code{font-family:var(--mono)}
  .small{font-size:var(--fs-xs)}
  .grow{flex:1}
  .icon{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;vertical-align:-3px;flex:none}
  .num{font-variant-numeric:tabular-nums}
  .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
  .mono{font-family:var(--mono);font-size:12.5px}
  .dim{color:var(--text-2)} .faint{color:var(--text-3)}
`;

const SHELL = `
  .bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:var(--s5);height:56px;padding:0 var(--s6);
    background:var(--bar-bg);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line);view-transition-name:bar}
  .brand{display:inline-flex;align-items:center;gap:var(--s2);font-family:var(--mono);font-size:14px;font-weight:600;color:var(--text);flex:none}
  .brand:hover{text-decoration:none}
  .brand b{color:var(--acc);font-weight:600}
  .logo{width:20px;height:20px;stroke:var(--acc);fill:none;stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round}
  nav{display:flex;gap:2px;min-width:0}
  .nav-link{position:relative;display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:var(--r-ctl);
    color:var(--text-2);font-size:var(--fs-sm);font-weight:500;transition:color var(--dur-1),background-color var(--dur-1)}
  .nav-link:hover{color:var(--text);text-decoration:none}
  .nav-link:not(.on):hover{background:color-mix(in srgb,var(--surface-2) 70%,transparent)}
  .nav-link.on{color:var(--text)}
  .nav-link .icon,.nav-label{position:relative}
  .nav-ind{position:absolute;inset:0;border-radius:var(--r-ctl);background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--line-2);view-transition-name:nav-ind}
  .bar .grow{flex:1}
  .bar-group{display:flex;align-items:center;gap:2px}
  .bar-sep{width:1px;height:20px;background:var(--line-2);flex:none}
  .health{display:inline-flex;align-items:center;gap:var(--s2);padding:4px 10px;border:1px solid var(--line);border-radius:999px;font-size:var(--fs-xs);color:var(--text-2);white-space:nowrap}
  .who{font-size:var(--fs-xs);font-family:var(--mono);color:var(--text-2);padding:0 var(--s2)}
  .bar button.ghost{padding:6px;display:inline-flex}
  .bar .langBtn{font-size:var(--fs-xs);font-weight:600;min-width:32px;justify-content:center}

  .dot{position:relative;display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}
  .dot.busy{background:var(--acc)} .dot.warn{background:var(--warn)} .dot.err{background:var(--err)} .dot.off{background:var(--text-3)}
  .dot.live::after{content:"";position:absolute;inset:0;border-radius:50%;background:inherit;animation:pulse 2.4s var(--ease-out) infinite}

  main{max-width:1200px;margin:0 auto;padding:var(--s6) var(--s6) var(--s7)}
  .page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--s4);flex-wrap:wrap;margin-bottom:var(--s5)}
  .page-title{font-size:var(--fs-h1);font-weight:600;letter-spacing:-.01em;line-height:1.3}
  .page-sub{font-size:var(--fs-sm);color:var(--text-2);margin-top:2px}
  .page-actions{display:flex;align-items:center;gap:var(--s3)}
  .boot-error{display:flex;align-items:center;gap:var(--s3);padding:var(--s4) var(--s5);border:1px solid var(--err);background:var(--err-soft);border-radius:var(--r-panel);margin-bottom:var(--s5)}
`;

const COMPONENTS = `
  section{margin-bottom:var(--s6)}
  .section-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);margin-bottom:var(--s3)}
  .section-title{font-size:var(--fs-h2);font-weight:600}
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-panel);box-shadow:var(--shadow-panel);overflow:hidden}
  .panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--s3);padding:var(--s4) var(--s5) 0}
  .panel-title{font-size:var(--fs-h2);font-weight:600;line-height:1.4}
  .panel-sub{font-size:var(--fs-xs);color:var(--text-3);margin-top:2px}
  .panel-body{padding:var(--s4) var(--s5) var(--s5)}
  .panel-flush{margin-top:var(--s2)}
  .grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s4)}
  .grid-7-5{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:var(--s4);align-items:start}
  .cap{font-size:var(--fs-xs);font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3)}
  .count{font-size:var(--fs-xs);color:var(--text-3);font-weight:400;margin-left:6px}

  /* segmented control with a sliding indicator */
  .seg{position:relative;display:inline-flex;padding:2px;background:var(--surface-2);border:1px solid var(--line);border-radius:8px}
  .seg button{position:relative;z-index:1;min-width:44px;background:none;border:0;padding:3px 10px;border-radius:6px;font-size:var(--fs-xs);font-weight:500;color:var(--text-2)}
  .seg button:hover{color:var(--text)}
  .seg button[aria-pressed=true]{color:var(--text)}
  .seg-ind{position:absolute;top:2px;bottom:2px;left:0;border-radius:6px;background:var(--surface);box-shadow:var(--shadow-knob),inset 0 0 0 1px var(--line-2);
    transition:transform var(--dur-3) var(--ease-out),width var(--dur-3) var(--ease-out)}
  .seg.no-anim .seg-ind{transition:none}
  .seg:empty{visibility:hidden;min-width:140px;height:28px}

  /* data table inside a panel */
  .tbl{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
  .tbl th{font-size:var(--fs-xs);font-weight:500;color:var(--text-3);text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
  .tbl td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap}
  .tbl tr:last-child td{border-bottom:0}
  .tbl th:first-child,.tbl td:first-child{padding-left:var(--s5)}
  .tbl th:last-child,.tbl td:last-child{padding-right:var(--s5)}
  .tbl .r{text-align:right}
  .state{display:inline-flex;align-items:center;gap:6px}
  .meter{display:inline-block;width:48px;height:4px;border-radius:2px;background:var(--surface-2);overflow:hidden;vertical-align:middle;margin-right:var(--s2)}
  .meter i{display:block;height:100%;background:var(--acc);border-radius:2px;transition:width var(--dur-3) var(--ease-out)}
  .tbl td.empty,.feed li.empty{padding:var(--s5);text-align:center;color:var(--text-3);font-size:var(--fs-sm)}

  /* loading + "updated" indicator */
  .sk{display:inline-block;width:4em;height:.75em;border-radius:4px;vertical-align:middle;
    background:linear-gradient(90deg,var(--sk-a) 25%,var(--sk-b) 37%,var(--sk-a) 63%);background-size:400% 100%;animation:shimmer 1.4s ease infinite}
  .sk.block{display:block;width:100%;height:100%}
  .sk.line{display:block;width:100%;height:12px;margin:6px 0}
  .updated{display:inline-flex;align-items:center;gap:var(--s2);font-size:var(--fs-xs);color:var(--text-3)}
  .updated.err{color:var(--err)}
  .spin{width:12px;height:12px;border-radius:50%;border:1.5px solid var(--line-2);border-top-color:var(--acc);
    opacity:0;animation:spin .8s linear infinite paused;transition:opacity var(--dur-1)}
  .updated.loading .spin{opacity:1;animation-play-state:running;transition-delay:300ms}
  .spin.on{opacity:1;animation-play-state:running;border-top-color:currentColor}

  .tbl-wrap{overflow-x:auto}
  .tbl td.wrap{white-space:normal}
  .empty-state{display:flex;flex-direction:column;align-items:center;gap:var(--s2);padding:var(--s6) var(--s4);text-align:center;color:var(--text-2);font-size:var(--fs-sm);white-space:normal}
  .empty-state .icon{width:28px;height:28px;stroke-width:1.5;color:var(--text-3)}
  .empty-title{font-size:var(--fs-body);font-weight:500;color:var(--text)}

  /* tags & badges */
  .tag{display:inline-block;padding:1px 6px;border-radius:4px;font:500 11px/1.6 var(--mono);color:var(--text-2);background:var(--surface-2);border:1px solid var(--line);white-space:nowrap}
  .tag.acc{color:var(--acc);background:var(--acc-soft);border-color:transparent}
  .badge{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:var(--fs-xs);font-weight:500;white-space:nowrap}
  .badge.ok{color:var(--ok);background:var(--ok-soft)} .badge.err{color:var(--err);background:var(--err-soft)}
  .badge.warn{color:var(--warn);background:var(--warn-soft)} .badge.acc{color:var(--acc);background:var(--acc-soft)}
  .badge.off{color:var(--text-2);background:var(--surface-2)}

  /* filter chips + search */
  .chips{display:flex;flex-wrap:wrap;gap:4px}
  .chip{border-radius:999px;border-color:transparent;background:transparent;color:var(--text-2);padding:5px 12px;font-size:var(--fs-sm);font-weight:500}
  .chip:hover{background:var(--surface-2);color:var(--text);border-color:transparent}
  .chip[aria-pressed=true]{background:var(--acc-soft);color:var(--acc)}
  .chip .n{font-size:var(--fs-xs);color:var(--text-3)}
  .chip[aria-pressed=true] .n{color:inherit;opacity:.8}
  .search{position:relative;display:flex;align-items:center}
  .search>.icon{position:absolute;left:10px;color:var(--text-3);pointer-events:none}
  .search input{width:260px;padding-left:32px;padding-right:32px}
  .search input::-webkit-search-cancel-button{display:none}
  .search .icon-btn{position:absolute;right:3px;padding:4px}

  /* switch */
  .switch{position:relative;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:var(--line-2);flex:none;transition:background-color var(--dur-2)}
  .switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:var(--shadow-knob);transition:transform var(--dur-2) var(--ease-out)}
  .switch[aria-checked=true]{background:var(--acc)}
  .switch[aria-checked=true]::after{transform:translateX(16px)}
  .switch:hover{filter:brightness(1.08)}
  .switch:active:not(:disabled){transform:none}
  .switch-label{display:inline-flex;align-items:center;gap:var(--s2);font-size:var(--fs-sm);color:var(--text-2);cursor:pointer;user-select:none}

  /* key/value grid, form fields, notes */
  .kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:var(--s4) var(--s5)}
  .kv-grid .wide{grid-column:span 2}
  .kv-grid dt{font-size:var(--fs-xs);color:var(--text-3)}
  .kv-grid dd{margin:2px 0 0;font-weight:500;font-variant-numeric:tabular-nums;word-break:break-word}
  .field{display:flex;flex-direction:column;gap:6px}
  .field label{font-size:var(--fs-xs);font-weight:500;color:var(--text-2)}
  .field input{width:100%}
  .field-msg{font-size:var(--fs-xs)}
  .field-msg:empty{display:none}
  .field-msg.err{color:var(--err)} .field-msg.ok{color:var(--ok)}
  .note{display:flex;align-items:flex-start;gap:var(--s2);padding:var(--s3) var(--s4);border-radius:var(--r-ctl);background:var(--surface-2);color:var(--text-2);font-size:var(--fs-sm)}
  .note .icon{margin-top:2px}
  .note.warn{background:var(--warn-soft);color:var(--warn)}

  /* code blocks (optionally tabbed) */
  .code{position:relative;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);min-width:0}
  .code pre{margin:0;padding:var(--s3) var(--s4);font:12.5px/1.65 var(--mono);color:var(--text);white-space:pre;overflow:auto;max-height:420px;tab-size:2}
  .code.wrap pre{white-space:pre-wrap;word-break:break-word}
  .code-head{display:flex;align-items:center;gap:var(--s2);padding:0 6px 0 var(--s2);border-bottom:1px solid var(--line)}
  .code-tabs{display:flex;gap:2px;flex:1;overflow-x:auto}
  .code-tabs button{position:relative;background:none;border:0;border-radius:0;padding:9px 10px;font-size:var(--fs-xs);font-weight:500;color:var(--text-2)}
  .code-tabs button:hover{color:var(--text)}
  .code-tabs button[aria-selected=true]{color:var(--text)}
  .code-tabs button[aria-selected=true]::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:1px;background:var(--acc)}
  .code .copy-btn{padding:5px}
  .code .copy-btn.float{position:absolute;top:6px;right:6px;background:var(--surface-2);opacity:.75}
  .code:hover .copy-btn.float,.code .copy-btn.float:focus-visible{opacity:1}
  .block-cap{margin-top:var(--s2)}

  /* dialogs: centred modal + right-side drawer */
  dialog{background:var(--surface);color:var(--text);border:1px solid var(--line-2);border-radius:var(--r-pop);box-shadow:var(--shadow-pop);
    padding:0;width:min(440px,calc(100vw - 32px));max-height:85vh;margin:auto;overflow:auto}
  dialog.wide{width:min(680px,calc(100vw - 32px))}
  .dlg-head{display:flex;align-items:center;gap:var(--s2);padding:var(--s4) var(--s5);border-bottom:1px solid var(--line)}
  .dlg-title{font-size:var(--fs-h2);font-weight:600}
  .dlg-body{padding:var(--s5)}
  .dlg-text{color:var(--text-2);font-size:var(--fs-sm)}
  .dlg-foot{display:flex;justify-content:flex-end;gap:var(--s2);padding:var(--s3) var(--s5);border-top:1px solid var(--line)}
  .confirm .dlg-head{border-bottom:0;padding-bottom:0}
  .confirm .dlg-body{padding-top:var(--s2)}
  .confirm .dlg-foot{border-top:0;padding-top:0;padding-bottom:var(--s5)}
  .modal .dlg-body{display:flex;flex-direction:column;gap:var(--s3)}
  dialog.drawer{margin:0 0 0 auto;width:min(620px,100vw);height:100dvh;max-height:100dvh;border-radius:0;border:0;border-left:1px solid var(--line-2)}
  dialog.drawer[open]{display:flex;flex-direction:column}
  dialog.drawer .dlg-head{position:sticky;top:0;background:var(--surface);z-index:1}
  dialog.drawer .dlg-body{flex:1;overflow:auto}
  dialog.drawer .dlg-body:focus{outline:none}

  /* toasts */
  .toasts{inset:auto;margin:0;border:0;padding:0;background:none;overflow:visible;color:inherit;
    position:fixed;right:var(--s5);bottom:var(--s5);z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:var(--s2);pointer-events:none}
  .toast{display:flex;align-items:center;gap:var(--s2);max-width:420px;padding:10px 14px;background:var(--surface);border:1px solid var(--line-2);border-radius:8px;
    box-shadow:var(--shadow-pop);font-size:var(--fs-sm);pointer-events:auto;animation:toast-in var(--dur-2) var(--ease-out)}
  .toast.ok .icon{color:var(--ok)} .toast.err .icon{color:var(--err)}
  .toast.out{animation:toast-out var(--dur-2) var(--ease-in) forwards}
`;

const MOTION = `
  /* page entrance: header and sections rise in, 50ms apart (also replays
     when the auth overlay hands over to the app) */
  main>:not(dialog){animation:rise var(--dur-3) var(--ease-out) both}
  main>:nth-child(2):not(dialog){animation-delay:50ms} main>:nth-child(3):not(dialog){animation-delay:100ms} main>:nth-child(n+4):not(dialog){animation-delay:150ms}
  .fade-in{animation:fade var(--dur-2) var(--ease-out) both}
  .tick{animation:tick .8s var(--ease-out)}
  @keyframes rise{from{opacity:0;transform:translateY(6px)}}
  @keyframes fade{from{opacity:0}}
  @keyframes tick{from{color:var(--acc)}}
  @keyframes pulse{0%{transform:scale(1);opacity:.55}70%,100%{transform:scale(2.6);opacity:0}}
  @keyframes shimmer{from{background-position:100% 50%}to{background-position:0 50%}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes vt-out{to{opacity:0}}
  @keyframes vt-in{from{opacity:0}}

  /* cross-document navigation: bar stays put, the active-nav pill slides,
     the new page's own .enter animation handles the content */
  ::view-transition-old(root),::view-transition-new(root){animation:none}
  ::view-transition-group(nav-ind){animation-duration:var(--dur-3);animation-timing-function:var(--ease-out)}
  ::view-transition-old(bar),::view-transition-new(bar){animation:none}
  /* same-document theme switch: plain cross-fade */
  :root.vt-fade::view-transition-old(*){animation:vt-out var(--dur-3) var(--ease-in) both}
  :root.vt-fade::view-transition-new(*){animation:vt-in var(--dur-3) var(--ease-out) both}

  dialog{opacity:0;transform:translateY(8px) scale(.98);
    transition:opacity var(--dur-2) var(--ease-out),transform var(--dur-2) var(--ease-out),overlay var(--dur-2) allow-discrete,display var(--dur-2) allow-discrete}
  dialog[open]{opacity:1;transform:none}
  dialog::backdrop{background:var(--backdrop);opacity:0;transition:opacity var(--dur-2),overlay var(--dur-2) allow-discrete,display var(--dur-2) allow-discrete}
  dialog[open]::backdrop{opacity:1}
  @starting-style{dialog[open]{opacity:0;transform:translateY(8px) scale(.98)} dialog[open]::backdrop{opacity:0}}
  dialog.drawer{transform:translateX(32px)}
  dialog.drawer[open]{transform:none}
  @starting-style{dialog.drawer[open]{opacity:0;transform:translateX(32px)}}
  @keyframes toast-in{from{opacity:0;transform:translateY(8px)}}
  @keyframes toast-out{to{opacity:0;transform:translateY(8px)}}

  @media (prefers-reduced-motion: reduce){
    html{scroll-behavior:auto}
    *,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;animation-delay:0s !important;transition-duration:.01ms !important}
    ::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none !important}
  }
`;

const RESPONSIVE = `
  @media (max-width:1000px){
    .grid-2,.grid-7-5{grid-template-columns:minmax(0,1fr)}
  }
  @media (max-width:760px){
    .bar{padding:0 var(--s3);gap:var(--s2)}
    .nav-label,.who,.health-txt{display:none}
    .nav-link{padding:7px 9px}
    .health{padding:6px;border-color:transparent}
    main{padding:var(--s5) var(--s4) var(--s7)}
    .panel-head{padding:var(--s4) var(--s4) 0}
    .panel-body{padding:var(--s4)}
    .tbl th:first-child,.tbl td:first-child{padding-left:var(--s4)}
    .tbl th:last-child,.tbl td:last-child{padding-right:var(--s4)}
    .toasts{left:var(--s4);right:var(--s4);bottom:var(--s4)}
  }
  @media (max-width:480px){
    .brand-name,.bar-sep{display:none}
    .bar .grow{display:none}
    nav{flex:1;justify-content:space-between}
  }
`;

export const CSS = TOKENS + BASE + SHELL + COMPONENTS + MOTION + PAGE_CSS + RESPONSIVE;
