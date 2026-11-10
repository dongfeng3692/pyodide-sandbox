// describe.mjs — model-facing description of the execution environment,
// generated from the ACTIVE policy + config (never hand-written, so it cannot
// drift from what the workers enforce). Used for the MCP tool description and
// the initialize `instructions`; embedders can reuse it for their own tools.
import { SAFE_BUILTINS } from './policy/index.mjs';
import { BUILTIN_HINTS, STDLIB_SAFE_ALLOWLIST } from './packages.mjs';

const SYNTAX_LABELS = {
  Import: '`import`', ImportFrom: '`from ... import`', FunctionDef: '`def`',
  AsyncFunctionDef: '`async def`', ClassDef: '`class`', Lambda: '`lambda`',
  Global: '`global`', Nonlocal: '`nonlocal`',
};

const kib = (bytes) => (bytes >= 1_048_576 ? `${Math.round(bytes / 1_048_576)} MB` : `${Math.round(bytes / 1024)} KB`);

function moduleLines(policy, runtime, packages = []) {
  const exposed = Object.entries(policy.exposeModules ?? {});
  const allowsImport = !(policy.banSyntax ?? []).includes('Import');
  if (!exposed.length) {
    return [allowsImport
      ? '- No modules are pre-bound; `import` is allowed.'
      : '- No modules are available (no imports, nothing pre-bound): plain Python only.'];
  }
  const versions = runtime?.modules ?? {};
  const list = exposed.map(([alias, mod]) => {
    const v = versions[alias]?.version;
    return `\`${alias}\` = ${mod}${v ? ` ${v}` : ''}`;
  }).join(', ');
  if (allowsImport) return [`- Pre-bound globals: ${list}.`];
  const lines = [
    `- Pre-bound globals (already imported — do NOT write import statements): ${list}.`,
  ];
  // The "nothing else exists" line must not name modules the manifest just
  // injected: derive the examples from the allowlist minus what is bound.
  const bound = new Set((packages ?? []).flatMap((e) => [e.name, ...Object.values(e.aliases ?? {})]));
  const missing = ['math', 'json', 're', 'datetime', 'collections']
    .filter((m) => STDLIB_SAFE_ALLOWLIST.includes(m) && !bound.has(m));
  if (missing.length) {
    lines.push(`- \`import\` is rejected and no other module exists (no ${missing.join('/')}): `
      + 'use the pre-bound libraries instead (np.sqrt, np.pi, pd.to_datetime, pd.Timestamp, s.str.contains, s.value_counts).');
  } else {
    lines.push('- `import` is rejected and no other module exists: use the pre-bound globals above.');
  }
  // Per-package usage hints (manifest `hint` wins over the built-in one).
  for (const e of packages ?? []) {
    const hint = (e.hint && e.hint.trim()) || BUILTIN_HINTS[e.name] || BUILTIN_HINTS[e.name.split('.', 1)[0]];
    if (!hint) continue;
    const aliases = Object.keys(e.aliases ?? {});
    if (!aliases.length) continue;
    lines.push(`- Usage \`${aliases.join('`, `')}\`: ${hint}.`);
  }
  return lines;
}

function builtinLines(policy) {
  if (policy.builtinsMode === 'full') return ['- All Python builtins are available.'];
  const banned = new Set(policy.banNames ?? []);
  const available = [...SAFE_BUILTINS, ...(policy.builtinsExtra ?? [])]
    .filter((n) => !n.startsWith('_') && !banned.has(n));
  // Names models habitually reach for even though the "(nothing else)" list
  // above already excludes them — naming them here stops `dir()`-style
  // first-attempt failures. Keep in sync with _BANNED_NAME_HINTS in hints.py.
  const notable = ['print', 'type', 'getattr', 'hasattr', 'repr', 'dir', 'vars',
    'globals', 'locals', 'id', 'object', 'super', 'open', 'eval', 'exec',
    'iter', 'next', 'format']
    .filter((n) => banned.has(n) || !available.includes(n));
  const lines = [`- Builtins available (nothing else): ${available.join(', ')}.`];
  if (notable.length) lines.push(`- Not available: ${notable.join(', ')}.`);
  return lines;
}

function syntaxLines(policy) {
  const lines = [];
  const banned = (policy.banSyntax ?? []).filter((k) => k !== 'Import' && k !== 'ImportFrom');
  if (banned.length) {
    lines.push(`- Rejected syntax: ${banned.map((k) => SYNTAX_LABELS[k] ?? k).join(', ')} — write top-level statements and comprehensions instead.`);
  }
  if (policy.denyUnderscoreNames !== false) {
    lines.push('- Names may not start with `_` (use `tmp`, not `_tmp`).');
  }
  if (policy.attributeMode === 'deny-underscore') {
    lines.push('- Attributes starting with `_` (incl. all dunders) are not accessible; use public APIs.');
  } else if (policy.attributeMode === 'whitelist') {
    lines.push(`- Only these attributes are accessible: ${(policy.attributeWhitelist ?? []).join(', ')}.`);
  }
  if (policy.forbidAttributeStore !== false) {
    lines.push('- Assigning to an attribute (`obj.x = ...`, e.g. `df.columns = [...]`) is rejected. '
      + 'Variables and item assignment are fine: `df = df.rename(columns={...})`, `df = df.set_axis([...], axis=1)`, `df["new"] = ...`.');
  }
  return lines;
}

/**
 * @param {object} args
 * @param {object} args.policy  resolved policy (resolvePolicy().policy)
 * @param {object} args.config  resolved config
 * @param {object} [args.runtime] runtime info ({modules: {alias: {version}}})
 * @returns {string} environment description (markdown-ish plain text)
 */
export function describeEnvironment({ policy, config, runtime = null }) {
  const resultRule = policy.resultMustBeDict === false
    ? 'Assign the answer to a top-level variable `result` (any JSON-able value).'
    : 'Assign the answer to a top-level variable `result` that is a dict, e.g. `result = {"total": df["sales"].sum()}`.';
  const stdout = config.output.stdoutMode === 'discard'
    ? 'stdout is discarded.'
    : `print() output comes back in \`stdout\` (first ${config.output.stdoutMaxChars} chars).`;
  return [
    'RETURNING DATA',
    `- ${resultRule} numpy/pandas values are converted automatically (scalars → numbers, Timestamps → ISO strings, Series → dict, DataFrame → list of row dicts).`,
    `- ${stdout}`,
    '',
    `ENVIRONMENT (policy preset "${policy.preset}")`,
    ...moduleLines(policy, runtime, config.packages ?? []),
    '- Input files: the `files` dict maps name → a fresh file object on every access, e.g. '
      + '`df = pd.read_csv(files["data.csv"])` or `files["notes.txt"].read().decode()`. '
      + 'There are no filesystem paths and no network.',
    ...builtinLines(policy),
    ...syntaxLines(policy),
    '',
    'LIMITS',
    `- Timeout ${Math.round(config.pool.execTimeoutMs / 1000)}s per call; code ≤ ${kib(policy.maxCodeBytes)}; `
      + `result ≤ ${kib(config.output.resultMaxBytes)} of JSON (aggregate or use .head(n)); `
      + `≤ ${config.files.maxCount} files of ≤ ${kib(config.files.maxBytesPerFile)} each.`,
    '- Stateless: every call starts from scratch — variables AND files from earlier calls are gone; re-send files with every call.',
    '',
    'ERRORS',
    '- Failures return {ok: false, error: {type, line, symbol, message, hint}}. Follow the `hint` and change the code; '
      + 'resending the same code fails the same way.',
  ].join('\n');
}
