// admin/client/api.js — API reference page: quick-start snippets, response
// examples, live request limits from the running config, and a scroll-spy
// table of contents.

const $ = (id) => document.getElementById(id);

codeBlock($('quickstart'), execSnippetTabs());

const json = (v) => JSON.stringify(v, null, 2);
codeBlock($('responses'), [
  { label: T('api.resOk'), code: json({ ok: true, result: { n: 42 }, warnings: [], stdout: '' }) },
  {
    label: T('api.resErr'),
    code: json({
      ok: false, warnings: [],
      error: { type: 'PolicyError', code: 'forbidden_syntax', symbol: 'import', line: 1, message: '…', retryable: true },
      stdout: '',
    }),
  },
  { label: T('api.resRejected'), code: json({ ok: false, error: { type: 'queue_full', message: '…', retryable: true } }) },
]);

function sizeLabel(n) {
  if (n == null) return '—';
  if (n >= 1048576) return +(n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return +(n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

async function loadLimits() {
  const box = $('limitsGrid');
  try {
    const c = await api('/admin/api/config');
    if (!c.ok) throw new Error(c.error?.type || 'config_failed');
    $('presetTag').textContent = 'preset · ' + c.preset;
    const items = [
      ['api.timeout', Math.round(c.pool.execTimeoutMs / 1000) + ' s'],
      ['api.queue', c.pool.maxQueue],
      ['api.poolSize', c.pool.size],
      ['api.maxCode', sizeLabel(c.policy.maxCodeBytes)],
      ['api.maxFiles', c.files.maxCount],
      ['api.maxFileBytes', sizeLabel(c.files.maxBytesPerFile)],
      ['api.maxResult', sizeLabel(c.output.resultMaxBytes)],
      ['api.maxStdout', T('api.chars', { n: Number(c.output.stdoutMaxChars).toLocaleString() })],
    ];
    box.innerHTML = items.map(([k, v]) => '<div><dt>' + esc(T(k)) + '</dt><dd class="fade-in">' + esc(v) + '</dd></div>').join('');
  } catch (e) {
    if (e.message !== 'unauthorized') box.innerHTML = '<div class="faint">' + esc(T('ui.loadFailed')) + '</div>';
  }
}

// table of contents: highlight the section currently in view
const tocLinks = [...document.querySelectorAll('.toc a')];
const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    tocLinks.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id));
  }
}, { rootMargin: '-80px 0px -65% 0px' });
document.querySelectorAll('.doc-main > section[id]').forEach((s) => spy.observe(s));

loadLimits();
