// admin/client/ui.js — shared UI components for every admin page: toasts,
// clipboard copy, tabbed code blocks, confirm dialog, switches and busy
// buttons. Inlined after base.js (uses T, esc, ICONS).

// ---------- toasts ----------

const TOAST_MS = 2600;
function toast(message, kind = 'ok') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const icon = kind === 'err' ? ICONS.alert : ICONS.check;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = icon + '<span>' + esc(message) + '</span>';
  box.appendChild(el);
  if (box.showPopover) { // re-enter the top layer so it sits above any open modal
    if (box.matches(':popover-open')) box.hidePopover();
    box.showPopover();
  }
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // reduced motion: no animationend
  }, TOAST_MS);
}

// POST/PATCH/DELETE helper: resolves with the JSON body, throws Error(message)
// when the server answers ok:false (callers surface it with toast()).
async function mutate(path, method, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await api(path, opts);
  if (!res || res.ok === false) throw new Error(res?.error?.message || res?.error?.type || T('ui.failed'));
  return res;
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', String(busy));
  btn.querySelector(':scope > .spin')?.remove();
  if (busy) btn.insertAdjacentHTML('afterbegin', '<span class="spin on" aria-hidden="true"></span>');
}

// ---------- clipboard ----------

// navigator.clipboard needs a secure context; the admin UI is often opened
// over plain http on a LAN address, so fall back to execCommand there.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  (document.querySelector('dialog:modal') || document.body).appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

function copyButtonHtml(extraClass) {
  return '<button type="button" class="ghost copy-btn' + (extraClass ? ' ' + extraClass : '') + '" data-copy title="' +
    esc(T('ui.copy')) + '" aria-label="' + esc(T('ui.copy')) + '">' + ICONS.copy + '</button>';
}

// Wire a copy button: getText() supplies the text at click time.
function bindCopy(btn, getText) {
  btn.addEventListener('click', async () => {
    try {
      await copyText(getText());
      btn.innerHTML = ICONS.check;
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = ICONS.copy; btn.classList.remove('copied'); }, 1400);
      toast(T('ui.copied'));
    } catch (e) {
      toast(T('ui.copyFailed'), 'err');
    }
  });
}

// ---------- code blocks ----------

// tabs: [{ label, code }]. One tab → plain block with a floating copy button.
// opts.wrap: soft-wrap long lines (stdout); default keeps code unwrapped.
function codeBlock(host, tabs, opts = {}) {
  const multi = tabs.length > 1;
  let active = 0;
  host.classList.add('code');
  if (opts.wrap) host.classList.add('wrap');
  host.innerHTML = (multi
    ? '<div class="code-head"><div class="code-tabs" role="tablist">' + tabs.map((t, i) =>
      '<button type="button" role="tab" aria-selected="' + (i === 0) + '" data-i="' + i + '">' + esc(t.label) + '</button>').join('') +
      '</div>' + copyButtonHtml() + '</div>'
    : copyButtonHtml('float')) +
    '<pre tabindex="0"></pre>';
  const pre = host.querySelector('pre');
  const show = (i) => {
    active = i;
    pre.textContent = tabs[i].code;
    host.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(Number(b.dataset.i) === i)));
  };
  host.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.i))));
  bindCopy(host.querySelector('[data-copy]'), () => tabs[active].code);
  show(0);
  return { set(newTabs) { tabs = newTabs; show(Math.min(active, tabs.length - 1)); } };
}

// ---------- dialogs ----------

// Backdrop click closes a modal <dialog> (the click target is the dialog
// element itself only when the pointer is outside its content box).
function closeOnBackdrop(dlg) {
  let downOnBackdrop = false;
  dlg.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dlg; });
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg || !downOnBackdrop) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dlg.close();
  });
}

// Promise<boolean>. Uses the shared #confirmDlg rendered by the shell.
function confirmDialog({ title, body, ok, danger = false }) {
  const dlg = document.getElementById('confirmDlg');
  dlg.querySelector('.dlg-title').textContent = title;
  dlg.querySelector('.dlg-text').textContent = body;
  const okBtn = dlg.querySelector('[data-ok]');
  okBtn.textContent = ok;
  dlg.querySelector('[data-cancel]').textContent = T('ui.cancel');
  okBtn.className = danger ? 'danger-solid' : 'primary';
  return new Promise((resolve) => {
    const done = (v) => () => { dlg.close(); resolve(v); };
    okBtn.onclick = done(true);
    dlg.querySelector('[data-cancel]').onclick = done(false);
    dlg.onclose = () => resolve(false); // Esc / backdrop; resolving twice is a no-op
    dlg.showModal();
    dlg.querySelector('[data-cancel]').focus();
  });
}

// ---------- switch ----------

// <button class="switch" role="switch" aria-checked="false">; returns a setter.
function bindSwitch(btn, onToggle) {
  btn.addEventListener('click', () => onToggle(btn.getAttribute('aria-checked') !== 'true'));
  return (on) => btn.setAttribute('aria-checked', String(Boolean(on)));
}
