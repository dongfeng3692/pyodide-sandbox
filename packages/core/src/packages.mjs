// packages.mjs — injectable dependency manifest: validation + compilation.
//
// The `packages` config section is the single declarative list of what the
// sandbox pre-binds for model code. It compiles down to the existing boot
// primitives (runtime.preload / runtime.preimport / policy.exposeModules /
// the sha256-locked wheels dir) — no new runtime path, no new import surface.
//
// Three injection channels with separate gates:
//   pyodide  — official pyodide packages (py.loadPackage, pinned by the
//              npm-pinned pyodide release's lock file)
//   wheel    — .whl files in runtime.wheelsDir, sha256-verified against
//              wheels-lock.json at every boot (fail closed); `pypi` is the
//              same channel with provenance "downloaded by the installer"
//   stdlib   — Python standard library modules, zero download, gated by a
//              code-level allowlist (STDLIB_SAFE_ALLOWLIST)
//
// Model code still cannot `import` anything: aliases are pre-bound globals
// injected by trusted boot code, exactly like the preset's pd/np.

import { SAFE_BUILTINS, resolvePolicy } from './policy/index.mjs';

/** Pure-computation stdlib modules an operator may pre-bind. Curated, not
 *  derived: anything with fs/process/network/interpreter reach (os, sys, io,
 *  socket, ctypes, …) is deliberately absent. Extending this list is a code
 *  change that must extend the test suites (threat-model §8). */
export const STDLIB_SAFE_ALLOWLIST = Object.freeze([
  'base64', 'binascii', 'cmath', 'collections', 'csv', 'datetime', 'decimal',
  'fractions', 'functools', 'hashlib', 'html', 'itertools', 'json', 'math',
  'random', 're', 'statistics', 'string', 'textwrap', 'time', 'unicodedata',
  'urllib.parse', 'uuid',
]);

/** Modules that must never be handed to model code through the manifest,
 *  regardless of channel. Hard error (fail fast at resolve time), not a
 *  warning — hand-written policy.exposeModules keeps its softer UNSAFE
 *  warning for backwards compatibility; the manifest is the new first-class
 *  entry point and rejects outright. */
export const FORBIDDEN_EXPOSE = Object.freeze(new Set([
  'os', 'sys', 'io', 'js', 'pyodide', 'micropip', '_pyodide', 'importlib',
  'ctypes', 'subprocess', 'socket', 'threading', 'multiprocessing', 'shutil',
  'pickle', 'builtins', 'types', 'pathlib', 'tempfile', 'code', 'codeop',
  'compileall', 'site', 'runpy', 'pkgutil', 'zipimport', 'venv', 'ensurepip',
  'warnings', 'logging', 'traceback', 'linecache', 'inspect', 'dis', 'gc',
  'atexit', 'signal', 'select', 'asyncio', 'http', 'urllib', 'ftplib',
  'imaplib', 'poplib', 'smtplib', 'telnetlib', 'xmlrpc', 'webbrowser',
  'distutils', 'lib2to3', 'tkinter', 'turtle',
]));

/** Top-level name (before the first dot) of a module path. */
const topSegment = (name) => name.split('.', 1)[0];

const isIdentifier = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
const noDunder = (s) => !s.startsWith('__') && !s.endsWith('__');

/** Alias names reserved by the execution contract itself. */
const RESERVED_ALIASES = new Set(['files', 'result']);

const PACKAGE_ENTRY_KEYS = new Set(['name', 'source', 'aliases', 'hint', 'version', 'wheel', 'sha256']);
const PACKAGE_SOURCES = new Set(['pyodide', 'wheel', 'pypi', 'stdlib']);

/** Upper bound for a single downloaded wheel (installer gate). */
export const MAX_WHEEL_BYTES = 64 * 1024 * 1024;

/** One-line usage hints shown to the model in the tool description. The
 *  manifest's per-entry `hint` overrides these. Keep each ≤ ~120 chars —
 *  they are inlined into the MCP tool description on every tools/list. */
export const BUILTIN_HINTS = Object.freeze({
  pandas: 'DataFrames: pd.read_csv(files["data.csv"]), df["col"].sum(), df.groupby("k")["v"].mean(), df.merge(other)',
  numpy: 'numeric arrays: np.array([...]), np.sqrt/np.mean/np.arange/np.linspace; for columns prefer df["col"].to_numpy()',
  scipy: 'scipy.stats: t-tests, linregress, norm distribution functions',
  openpyxl: 'xlsx: wb = openpyxl.load_workbook(files["a.xlsx"], read_only=True); ws = wb.active; rows via ws.iter_rows(values_only=True)',
  json: 'parse/emit JSON text: json.loads(files["a.json"].read()), json.dumps(obj)',
  re: 'regex: re.search(r"\\d+", s).group(), re.findall(r"[a-z]+", s), re.sub(pat, repl, s)',
  math: 'math.sqrt/log/floor/ceil, math.pi; for arrays prefer the numpy equivalents',
  cmath: 'complex math: cmath.sqrt on complex numbers',
  statistics: 'plain-list stats: statistics.mean/median/stdev/quantiles',
  datetime: 'dates: datetime.datetime.fromisoformat("2024-01-01T00:00:00"), datetime.date(2024, 1, 1); for columns prefer pd.to_datetime',
  time: 'time.time() epoch seconds, struct_time parsing',
  decimal: 'exact decimal arithmetic: decimal.Decimal("0.1") + decimal.Decimal("0.2")',
  fractions: 'exact rationals: fractions.Fraction(1, 3)',
  random: 'random.random()/randint(a, b)/choice/shuffle/seeded Random(n)',
  csv: 'csv.DictReader(files["a.csv"]) streams rows as dicts; for tables prefer pd.read_csv',
  collections: 'collections.Counter(it).most_common(n), defaultdict(list), OrderedDict',
  itertools: 'itertools.chain/product/combinations/islice/groupby',
  functools: 'functools.reduce(f, it), functools.partial, lru_cache-free helpers',
  string: 'string.ascii_lowercase, punctuation, Template("$x").substitute(d)',
  textwrap: 'textwrap.wrap/shorten/dedent long strings',
  unicodedata: 'unicodedata.name/category/normalize("NFKC", s)',
  uuid: 'uuid.uuid4().hex random identifiers',
  hashlib: 'hashlib.sha256(b"...").hexdigest()',
  base64: 'base64.b64encode(b"...").decode(), b64decode(s)',
  binascii: 'binascii.hexlify/unhexlify byte conversions',
  html: 'html.escape(s), html.unescape(s)',
  'urllib.parse': 'urllib.parse.urlparse(u), parse_qs, urlencode — parsing only, no network',
});

const err = (index, field, message) => ({ index, field, message });

/**
 * Validate + normalize a packages manifest.
 * @param {Array} manifest raw entries from config/DB/admin UI
 * @param {object} [opts]
 * @param {object} [opts.policyConfig] resolved config.policy section (preset,
 *        banNames context, explicit exposeModules) for alias-collision checks
 * @param {string[]} [opts.denyModules] runtime.denyModules (bridge modules)
 * @returns {{entries: Array, errors: Array, baseExposeModules: object}}
 *          entries are normalized (source inferred, aliases defaulted);
 *          errors is [] when valid — callers decide warn-vs-throw.
 */
export function validatePackages(manifest, { policyConfig = {}, denyModules = [] } = {}) {
  const errors = [];
  if (manifest === undefined || manifest === null) manifest = [];
  if (!Array.isArray(manifest)) {
    return { entries: [], errors: [err(null, 'packages', 'must be an array of entries')], baseExposeModules: {} };
  }

  const { policy } = resolvePolicy(policyConfig); // throws on unknown preset — fail fast
  const presetExpose = { ...(policy.exposeModules ?? {}) };
  const banned = new Set(policy.banNames ?? []);
  const deny = new Set([...denyModules, ...FORBIDDEN_EXPOSE]);

  const seenNames = new Set();
  const seenWheels = new Set();
  const aliasOwner = new Map(); // alias → entry name (for duplicate messages)
  for (const [alias, mod] of Object.entries(presetExpose)) aliasOwner.set(alias, `preset:${mod}`);

  const entries = manifest.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(err(index, 'entry', 'must be an object'));
      return null;
    }
    for (const key of Object.keys(raw)) {
      if (!PACKAGE_ENTRY_KEYS.has(key)) errors.push(err(index, key, `unknown key "${key}" (typo?)`));
    }

    // --- name ---
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) { errors.push(err(index, 'name', 'required, e.g. "openpyxl"')); }
    else if (name.startsWith('_') || topSegment(name).startsWith('_')) {
      errors.push(err(index, 'name', `"${name}" starts with "_" — private modules cannot be exposed`));
    }
    else if (!/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name) || name.includes('..') || /[\\/]/.test(name)) {
      errors.push(err(index, 'name', `"${name}" is not a valid package/module name`));
    }
    else if ((deny.has(topSegment(name)) || deny.has(name)) && !STDLIB_SAFE_ALLOWLIST.includes(name)) {
      // allowlisted dotted paths (urllib.parse) are explicit exceptions under
      // a forbidden parent (urllib) — both lists are code-level curated
      errors.push(err(index, 'name', `"${name}" is forbidden (bridge/host/interpreter module)`));
    }
    if (name && seenNames.has(name)) errors.push(err(index, 'name', `"${name}" appears twice`));
    if (name) seenNames.add(name);

    // --- source ---
    let source = raw.source;
    if (source !== undefined && !PACKAGE_SOURCES.has(source)) {
      errors.push(err(index, 'source', `"${source}" must be one of ${[...PACKAGE_SOURCES].join('|')}`));
      source = undefined;
    }
    if (source === undefined) {
      if (typeof raw.wheel === 'string' && raw.wheel) source = 'wheel';
      else if (STDLIB_SAFE_ALLOWLIST.includes(name)) source = 'stdlib';
      else source = 'pyodide';
    }
    if (source === 'stdlib' && !STDLIB_SAFE_ALLOWLIST.includes(name)) {
      errors.push(err(index, 'source', `"${name}" is not on the stdlib allowlist (${STDLIB_SAFE_ALLOWLIST.length} curated modules)`));
    }
    if (source === 'pypi' || source === 'wheel') {
      if (source === 'pypi' && typeof raw.wheel !== 'string') {
        errors.push(err(index, 'wheel', 'pypi entries need the wheel filename (the installer fills it)'));
      }
      if (typeof raw.wheel === 'string' && raw.wheel) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*\.whl$/.test(raw.wheel)) {
          errors.push(err(index, 'wheel', `"${raw.wheel}" is not a plain .whl filename`));
        } else if (seenWheels.has(raw.wheel)) {
          errors.push(err(index, 'wheel', `"${raw.wheel}" is referenced twice`));
        } else seenWheels.add(raw.wheel);
      }
    } else if (typeof raw.wheel === 'string' && raw.wheel) {
      errors.push(err(index, 'wheel', `wheel only applies to wheel/pypi sources, not "${source}"`));
    }

    // --- aliases ---
    let aliases = raw.aliases;
    if (aliases === undefined) {
      // default: bind the package under its own top-level name; dotted names
      // (urllib.parse) REQUIRE explicit aliases — a default would bind the
      // whole parent package (urllib incl. urllib.request).
      aliases = name.includes('.') ? null : { [topSegment(name)]: name };
    }
    if (aliases === null) {
      if (source === 'stdlib' && name.includes('.')) {
        errors.push(err(index, 'aliases', `"${name}" is a submodule — add explicit aliases, e.g. {"up": "urllib.parse"}`));
      } else {
        aliases = {}; // explicit dependency-only entry (deps of other packages)
      }
    } else if (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases)) {
      errors.push(err(index, 'aliases', 'must be an object {alias: "module.path"} or null'));
      aliases = {};
    } else {
      const clean = {};
      for (const [alias, target] of Object.entries(aliases)) {
        if (!isIdentifier(alias) || !noDunder(alias)) {
          errors.push(err(index, 'aliases', `"${alias}" is not a usable alias name`));
        } else if (RESERVED_ALIASES.has(alias)) {
          errors.push(err(index, 'aliases', `"${alias}" is reserved by the execution contract`));
        } else if (SAFE_BUILTINS.includes(alias)) {
          errors.push(err(index, 'aliases', `"${alias}" collides with a safe builtin`));
        } else if (banned.has(alias)) {
          errors.push(err(index, 'aliases', `"${alias}" is a banned name under preset "${policy.preset}"`));
        } else if (aliasOwner.has(alias)) {
          errors.push(err(index, 'aliases', `"${alias}" is already bound by ${aliasOwner.get(alias)}`));
        }
        if (typeof target !== 'string' || (target !== name && !target.startsWith(`${name}.`))) {
          errors.push(err(index, 'aliases', `target "${target}" must be "${name}" or a submodule of it`));
        }
        if (isIdentifier(alias) && typeof target === 'string') {
          aliasOwner.set(alias, name);
          clean[alias] = target;
        }
      }
      aliases = clean;
    }

    // --- hint / version / sha256 ---
    if (raw.hint !== undefined && (typeof raw.hint !== 'string' || !raw.hint.trim() || raw.hint.length > 300 || /[\r\n]/.test(raw.hint))) {
      errors.push(err(index, 'hint', 'optional single-line string, 1-300 chars'));
    }
    if (raw.version !== undefined && (typeof raw.version !== 'string' || !/^[0-9][A-Za-z0-9.+*!]*$/.test(raw.version))) {
      errors.push(err(index, 'version', `"${raw.version}" is not a PEP 440-ish version string`));
    }
    if (raw.sha256 !== undefined && (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256))) {
      errors.push(err(index, 'sha256', 'must be 64 hex chars'));
    }

    return {
      name, source, aliases,
      ...(raw.hint !== undefined ? { hint: raw.hint } : {}),
      ...(raw.version !== undefined ? { version: raw.version } : {}),
      ...(raw.wheel !== undefined ? { wheel: raw.wheel } : {}),
      ...(raw.sha256 !== undefined ? { sha256: raw.sha256 } : {}),
    };
  });

  return { entries: errors.length ? null : entries, errors, baseExposeModules: presetExpose };
}

/**
 * Compile validated entries into the existing boot primitives. Additive:
 * callers merge these into runtime.preload / runtime.preimport /
 * policy.exposeModules (dedup for the arrays, conflict-checked for the map).
 * @param {Array} entries normalized entries from validatePackages()
 */
export function compilePackages(entries) {
  const preload = [];
  const preimport = new Set();
  const exposeModules = {};
  const wheels = [];
  for (const e of entries) {
    if (e.source === 'pyodide') preload.push(e.name);
    if (e.source === 'wheel' || e.source === 'pypi') wheels.push({ name: e.name, wheel: e.wheel });
    preimport.add(e.name);
    for (const target of Object.values(e.aliases)) preimport.add(target);
    Object.assign(exposeModules, e.aliases);
  }
  return { preload, preimport: [...preimport], exposeModules, wheels };
}
