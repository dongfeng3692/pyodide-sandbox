// admin/shell.mjs — page chrome shared by every admin page: top bar, page
// header, auth overlay and the inlined client runtime. Output is a single
// self-contained HTML document (no external assets, works offline).

import { readFileSync } from 'node:fs';
import { CSS } from './styles.mjs';
import { I18N } from './i18n.mjs';
import { ICONS, LOGO } from './icons.mjs';

const readClient = (name) => {
  const src = readFileSync(new URL(`./client/${name}`, import.meta.url), 'utf8');
  if (/<\/script/i.test(src)) throw new Error(`admin/client/${name} must not contain "</script"`);
  return src;
};
export const CLIENT = Object.fromEntries(
  ['base', 'ui', 'snippets', 'charts', 'monitoring', 'logs', 'api', 'mcp', 'settings'].map((n) => [n, readClient(`${n}.js`)]),
);

/** Server-rendered zh fallback for [data-i18n] nodes (applyLang swaps it). */
export const zh = (key) => I18N.zh[key] ?? key;

// applied in <head> before first paint to avoid a theme flash
const THEME_BOOT_JS = 'try{document.documentElement.dataset.theme=localStorage.getItem("sbx-theme")||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark")}catch(e){document.documentElement.dataset.theme="dark"}';

const NAV = [
  ['monitoring', '/admin', ICONS.activity],
  ['logs', '/admin/logs', ICONS.logs],
  ['api', '/admin/api-doc', ICONS.api],
  ['mcp', '/admin/mcp', ICONS.mcp],
  ['settings', '/admin/settings', ICONS.key],
];

function navHtml(active) {
  return NAV.map(([key, href, icon]) => {
    const on = key === active;
    return `<a href="${href}" class="nav-link${on ? ' on' : ''}"${on ? ' aria-current="page"' : ''}>` +
      `${on ? '<span class="nav-ind" aria-hidden="true"></span>' : ''}${icon}` +
      `<span class="nav-label" data-i18n="nav.${key}">${zh(`nav.${key}`)}</span></a>`;
  }).join('');
}

const TOGGLES = `
  <button type="button" class="ghost themeBtn" data-i18n-title="auth.theme" onclick="toggleTheme()"></button>
  <button type="button" class="ghost langBtn" data-i18n-title="auth.lang" onclick="toggleLang()">EN</button>`;

/**
 * @param {object} o
 * @param {string} o.page     nav key (monitoring|logs|api|mcp|settings)
 * @param {string} o.body     page markup (inside <main>, after the header)
 * @param {string} o.js       page script; runs after a successful auth boot
 * @param {string} [o.actions] markup for the right side of the page header
 */
export function shell({ page, body, js, actions = '' }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${zh(`page.${page}`)} · pyodide-sandbox</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script>${THEME_BOOT_JS}</script>
<style>${CSS}</style></head>
<body data-page="${page}">
<header class="bar" id="appbar">
  <a class="brand" href="/admin">${LOGO}<span class="brand-name">pyodide<b>-sandbox</b></span></a>
  <nav aria-label="main">${navHtml(page)}</nav>
  <span class="grow"></span>
  <span class="health" id="health"><span class="dot off" id="liveDot"></span><span class="health-txt" id="liveTxt">…</span></span>
  <span class="bar-sep"></span>
  <div class="bar-group">
    <span class="who" id="who"></span>
    ${TOGGLES}
    <button type="button" class="ghost" id="logoutBtn" data-i18n-title="auth.logout">${ICONS.logout}</button>
  </div>
</header>
<main id="appmain">
  <div class="page-head">
    <div><h1 class="page-title" data-i18n="page.${page}">${zh(`page.${page}`)}</h1>
    <p class="page-sub" data-i18n="page.${page}Sub">${zh(`page.${page}Sub`)}</p></div>
    <div class="page-actions">${actions}</div>
  </div>
  ${body}
</main>
<div class="toasts" id="toasts" role="status" aria-live="polite" popover="manual"></div>
<dialog class="modal confirm" id="confirmDlg" aria-labelledby="confirmTitle">
  <div class="dlg-head"><h2 class="dlg-title" id="confirmTitle"></h2></div>
  <div class="dlg-body"><p class="dlg-text"></p></div>
  <div class="dlg-foot"><button type="button" data-cancel data-i18n="ui.cancel">${zh('ui.cancel')}</button><button type="button" data-ok></button></div>
</dialog>
<div class="auth" id="auth" style="display:none">
  <div class="auth-tools">${TOGGLES}</div>
  <div class="auth-card">
    <div class="auth-brand">${LOGO}<span>pyodide<b>-sandbox</b></span></div>
    <h1 class="auth-title" id="authTitle">${zh('auth.loginTitle')}</h1>
    <p class="auth-sub" id="authSub"></p>
    <form id="authForm" autocomplete="on" novalidate>
      <div class="field"><label for="authUser" data-i18n="auth.user">${zh('auth.user')}</label>
        <input id="authUser" name="user" autocomplete="username" autocapitalize="off" spellcheck="false" required></div>
      <div class="field"><label for="authPass" data-i18n="auth.password">${zh('auth.password')}</label>
        <input id="authPass" name="password" type="password" autocomplete="current-password" required></div>
      <div class="field" id="authConfirmField" hidden><label for="authConfirm" data-i18n="auth.confirm">${zh('auth.confirm')}</label>
        <input id="authConfirm" name="confirm" type="password" autocomplete="new-password"></div>
      <p class="auth-msg" id="authMsg" role="alert"></p>
      <button class="primary block" id="authSubmit"><span id="authSubmitTxt">${zh('auth.signIn')}</span></button>
      <p class="auth-hint" id="authHint"></p>
    </form>
  </div>
</div>
<script>
const I18N = ${JSON.stringify(I18N)};
const ICONS = ${JSON.stringify(ICONS)};
${CLIENT.base}
${CLIENT.ui}
${CLIENT.snippets}
applyLang(); syncThemeBtn();
document.getElementById('logoutBtn').onclick = () => {
  fetch('/admin/api/logout', { method: 'POST', credentials: 'same-origin' }).finally(() => location.reload());
};
(async () => {
  let ok = false;
  try { ok = await boot(); } catch (e) { showBootError(); return; }
  if (!ok) return;
  document.getElementById('who').textContent = ADMIN_USER || '';
  pollHealth(); every(5000, pollHealth);
  ${js}
})();
</script></body></html>`;
}
