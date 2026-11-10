// config.mjs — single source of truth for configuration.
// Defaults are SAFE defaults. Every dangerous override emits a loud warning.
// Unknown keys are rejected (typo protection).

import { validatePackages, compilePackages } from '../packages.mjs';

const RUNTIME_KEYS = new Set([
  'cacheDir', 'wheelsDir', 'wheelsLockPath', 'preload', 'preimport',
  'denyModules', 'removeBridge', 'indexURL',
]);
const POLICY_KEYS = new Set([
  'preset', 'banSyntax', 'banNames', 'extraBanNames', 'extraAllowNames',
  'attributeMode', 'attributeWhitelist', 'forbidAttributeStore',
  'builtinsMode', 'builtinsExtra', 'resultMustBeDict', 'maxCodeBytes',
  'exposeModules',
]);
const FILES_KEYS = new Set(['maxCount', 'maxBytesPerFile']);
const OUTPUT_KEYS = new Set(['resultMaxBytes', 'stdoutMode', 'stdoutMaxChars']);
const POOL_KEYS = new Set([
  'size', 'execTimeoutMs', 'bootTimeoutMs', 'recycleAfter', 'rssLimitMb', 'maxQueue',
]);
const STATE_KEYS = new Set(['provider', 'maxCount', 'maxBytes']);
const SERVER_KEYS = new Set(['host', 'port', 'maxBodyBytes', 'allowNoToken',
  'adminUser', 'adminPassword', 'dbPath', 'dbRetentionHours', 'sampleIntervalMs']);
const TOP_KEYS = new Set(['runtime', 'policy', 'files', 'output', 'pool', 'state', 'server', 'packages']);
const SECTION_KEYS = {
  runtime: RUNTIME_KEYS, policy: POLICY_KEYS, files: FILES_KEYS, output: OUTPUT_KEYS,
  pool: POOL_KEYS, state: STATE_KEYS, server: SERVER_KEYS,
};
const SECTIONS = Object.keys(SECTION_KEYS);

export const DEFAULT_CONFIG = {
  // Injectable dependency manifest — see packages.mjs. Empty = exactly the
  // pre-manifest behavior (preset exposeModules only). Entries compile into
  // runtime.preload/preimport + policy.exposeModules at resolve time.
  packages: [],
  runtime: {
    cacheDir: './pkg-cache',
    wheelsDir: './wheels',
    wheelsLockPath: './wheels/wheels-lock.json',
    preload: ['pandas', 'numpy'],
    preimport: ['pandas', 'numpy'],
    denyModules: ['js', 'pyodide', 'micropip', '_pyodide'],
    removeBridge: true,
    indexURL: null,
  },
  policy: {
    preset: 'general',
    banSyntax: null,          // null → preset supplies
    banNames: null,           // null → preset supplies
    extraBanNames: [],
    extraAllowNames: [],
    attributeMode: null,      // null → preset supplies
    attributeWhitelist: [],
    forbidAttributeStore: null,
    builtinsMode: null,       // null → preset supplies
    builtinsExtra: [],
    resultMustBeDict: null,
    maxCodeBytes: 24_000,
    exposeModules: null,      // null → preset supplies; e.g. { pd: 'pandas' }
  },
  files: { maxCount: 5, maxBytesPerFile: 26_214_400 },
  output: { resultMaxBytes: 24_576, stdoutMode: 'capture', stdoutMaxChars: 4096 },
  pool: {
    // execTimeoutMs must stay under common MCP client timeouts (~30s): above
    // that the client drops the call first and the model never sees the
    // structured execution_timeout error. Longer-lived HTTP API users can
    // override via SBX_TIMEOUT_MS / config file.
    size: 2, execTimeoutMs: 25_000, bootTimeoutMs: 60_000,
    recycleAfter: 50, rssLimitMb: 512, maxQueue: 32,
  },
  state: { provider: 'none', maxCount: 3, maxBytes: 20_971_520 },
  server: {
    host: '127.0.0.1', port: 8787,
    maxBodyBytes: 48 * 1024 * 1024, allowNoToken: false,
    // Admin UI (monitoring + logs + token management). With no adminPassword
    // set, the first visit to /admin initializes the account (stored in the DB).
    // API tokens live in the DB too — created/toggled in the admin UI.
    adminUser: 'admin',
    adminPassword: null,
    dbPath: './data/sbx.db',
    dbRetentionHours: 72,
    // admin-dashboard resource sampler cadence (host CPU/RSS + pool counters)
    sampleIntervalMs: 10_000,
  },
};

function rejectUnknown(section, keys, where, warnings) {
  for (const key of Object.keys(section ?? {})) {
    if (!keys.has(key)) {
      warnings.push(`config.${where}: unknown key "${key}" ignored (typo?)`);
      delete section[key];
    }
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function resolveConfig(overrides = {}, base = DEFAULT_CONFIG) {
  const warnings = [];
  if (!isPlainObject(overrides)) throw new TypeError('config must be an object');
  rejectUnknown(overrides, TOP_KEYS, '', warnings);

  const merged = structuredClone(base);
  for (const section of SECTIONS) {
    const ov = overrides[section];
    if (!ov) continue;
    const copy = { ...ov }; // never mutate the caller's object
    rejectUnknown(copy, SECTION_KEYS[section], section, warnings);
    Object.assign(merged[section], copy);
  }
  // `packages` is an array section: a later layer replaces it wholesale
  // (per-entry merge semantics would be surprising for a manifest).
  if (overrides?.packages !== undefined) {
    if (Array.isArray(overrides.packages)) merged.packages = structuredClone(overrides.packages);
    else warnings.push('config.packages: must be an array of entries — ignored');
  }

  // Dangerous-override warnings (safety ergonomics). Anything that weakens
  // threat-model layers 3-5 must announce itself here.
  if (merged.runtime.removeBridge === false) {
    warnings.push('UNSAFE: runtime.removeBridge=false — the js bridge stays importable; model code can reach the host runtime. Do not use with untrusted input.');
  }
  if (merged.policy.preset === 'raw') {
    warnings.push('UNSAFE: policy.preset="raw" — no syntax/name/attribute restrictions. Only for fully trusted code.');
  }
  if (merged.policy.builtinsMode === 'full') {
    warnings.push('UNSAFE: policy.builtinsMode="full" — real builtins (incl. __import__, open, eval) are exposed to model code.');
  }
  if (merged.policy.attributeMode === 'off') {
    warnings.push('UNSAFE: policy.attributeMode="off" — attribute access unrestricted; dunder paths become reachable.');
  }
  if (merged.policy.forbidAttributeStore === false) {
    warnings.push('UNSAFE: forbidAttributeStore=false — model code can monkeypatch shared module objects within a worker.');
  }
  if (merged.server.allowNoToken) {
    warnings.push('UNSAFE: server.allowNoToken=true — HTTP API is unauthenticated; bind to loopback only.');
  }
  if (overrides?.policy?.exposeModules) {
    const dangerous = new Set(['sys', 'os', 'js', 'importlib', 'ctypes', 'subprocess', 'socket', 'threading', 'multiprocessing', 'micropip', 'pyodide', '_pyodide']);
    const bad = Object.values(overrides.policy.exposeModules).filter((m) => dangerous.has(m));
    if (bad.length) {
      warnings.push(`UNSAFE: policy.exposeModules hands ${bad.join(', ')} directly to model code.`);
    }
  }
  // trivial values — including placeholders copy-pasted from public configs
  // (compose files, tutorials); a publicly-known password is no password
  const trivialPasswords = new Set(['admin', 'password', 'changeme', 'change-me', 'change-me-before-use', 'secret', 'set-a-real-secret']);
  if (merged.server.adminPassword != null && trivialPasswords.has(merged.server.adminPassword.toLowerCase())) {
    warnings.push('UNSAFE: server.adminPassword is a trivial guessable value — set a real secret.');
  }
  if (merged.state.provider !== 'none') {
    warnings.push(`state.provider="${merged.state.provider}" is reserved for a future release; falling back to "none".`);
    merged.state.provider = 'none';
  }

  // --- packages manifest: validate fail-fast, then compile into the
  // existing boot primitives. `_pristine` (captured before any compile) makes
  // resolveConfig idempotent: re-resolving over an already-resolved config
  // with a different manifest strips the old manifest's contributions first,
  // so a removed entry really goes away.
  {
    const manifest = merged.packages ?? [];
    const pristine = merged._pristine ?? {
      policyExposeModules: merged.policy.exposeModules,
      preload: merged.runtime.preload,
      preimport: merged.runtime.preimport,
    };
    // strip any previous manifest's compiled contributions first
    merged.runtime.preload = pristine.preload;
    merged.runtime.preimport = pristine.preimport;
    merged.policy.exposeModules = pristine.policyExposeModules;
    merged.packages = [];
    if (manifest.length) {
      const { entries, errors, baseExposeModules } = validatePackages(manifest, {
        policyConfig: merged.policy,
        denyModules: merged.runtime.denyModules,
      });
      if (errors.length) {
        throw new Error(`config.packages invalid: ${errors.map((e) => `[${e.index ?? '?'}] ${e.field}: ${e.message}`).join('; ')}`);
      }
      const compiled = compilePackages(entries);
      merged.runtime.preload = [...new Set([...pristine.preload, ...compiled.preload])];
      merged.runtime.preimport = [...new Set([...pristine.preimport, ...compiled.preimport])];
      if (Object.keys(compiled.exposeModules).length) {
        merged.policy.exposeModules = { ...(pristine.policyExposeModules ?? baseExposeModules), ...compiled.exposeModules };
      }
      merged.packages = entries; // normalized (source inferred, aliases defaulted)
    }
    merged._pristine = pristine;
  }
  validateNumbers(merged);
  return { config: merged, warnings };
}

// [section, key, min, max, nullable]. A typo such as SBX_TIMEOUT_MS=60s
// becomes NaN, and setTimeout(NaN) fires after 1ms: every call would "time
// out". Numbers are therefore validated fail-fast, never coerced.
const NUMERIC_RULES = [
  ['pool', 'size', 1, 64],
  ['pool', 'execTimeoutMs', 1, 3_600_000],
  ['pool', 'bootTimeoutMs', 1, 3_600_000],
  ['pool', 'recycleAfter', 1, 1_000_000],
  ['pool', 'rssLimitMb', 0, 1_048_576, true], // 0/null disables the RSS recycle
  ['pool', 'maxQueue', 0, 1_000_000],
  ['files', 'maxCount', 0, 1000],
  ['files', 'maxBytesPerFile', 0, 2 ** 31],
  ['output', 'resultMaxBytes', 1, 2 ** 31],
  ['output', 'stdoutMaxChars', 0, 2 ** 31],
  ['policy', 'maxCodeBytes', 1, 2 ** 31],
  ['server', 'port', 0, 65_535],
  ['server', 'maxBodyBytes', 1, 2 ** 31],
  ['server', 'dbRetentionHours', 1, 1_000_000],
  ['server', 'sampleIntervalMs', 1, 86_400_000],
];

function validateNumbers(cfg) {
  for (const [section, key, min, max, nullable] of NUMERIC_RULES) {
    const v = cfg[section][key];
    if (nullable && v == null) continue;
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new RangeError(
        `${section}.${key} must be an integer in [${min}, ${max}] (got ${JSON.stringify(v) ?? String(v)})`,
      );
    }
  }
}

/** Deep-merge config override layers section by section (later layers win
 *  per key). A shallow spread would let one env var (e.g. SBX_PORT) replace
 *  the config file's entire `server` section. */
export function mergeOverrides(...layers) {
  const out = {};
  for (const layer of layers) {
    for (const [section, value] of Object.entries(layer ?? {})) {
      out[section] = isPlainObject(value) && isPlainObject(out[section])
        ? { ...out[section], ...value }
        : (isPlainObject(value) ? { ...value } : value);
    }
  }
  return out;
}

// Map SBX_* env vars to config overrides (server CLI entry point).
export function overridesFromEnv(env = process.env) {
  const ov = {};
  const num = (v) => (v == null || v === '' ? undefined : Number(v));
  if (env.SBX_HOST) set(ov, 'server', 'host', env.SBX_HOST);
  if (env.SBX_PORT) set(ov, 'server', 'port', num(env.SBX_PORT));
  if (env.SBX_ALLOW_NO_TOKEN === '1') set(ov, 'server', 'allowNoToken', true);
  if (env.SBX_POOL) set(ov, 'pool', 'size', num(env.SBX_POOL));
  if (env.SBX_TIMEOUT_MS) set(ov, 'pool', 'execTimeoutMs', num(env.SBX_TIMEOUT_MS));
  if (env.SBX_RECYCLE_EVERY) set(ov, 'pool', 'recycleAfter', num(env.SBX_RECYCLE_EVERY));
  if (env.SBX_RSS_LIMIT_MB) set(ov, 'pool', 'rssLimitMb', num(env.SBX_RSS_LIMIT_MB));
  if (env.SBX_CACHE_DIR) set(ov, 'runtime', 'cacheDir', env.SBX_CACHE_DIR);
  if (env.SBX_WHEELS_DIR) set(ov, 'runtime', 'wheelsDir', env.SBX_WHEELS_DIR);
  if (env.SBX_ADMIN_USER) set(ov, 'server', 'adminUser', env.SBX_ADMIN_USER);
  if (env.SBX_ADMIN_PASSWORD) set(ov, 'server', 'adminPassword', env.SBX_ADMIN_PASSWORD);
  if (env.SBX_DB_PATH) set(ov, 'server', 'dbPath', env.SBX_DB_PATH);
  if (env.SBX_PRESET) set(ov, 'policy', 'preset', env.SBX_PRESET);
  if (env.SBX_WITH_PANDAS === '0') {
    set(ov, 'runtime', 'preload', []);
    set(ov, 'runtime', 'preimport', []);
  }
  return ov;
}

function set(obj, section, key, value) {
  if (value === undefined) return;
  obj[section] = obj[section] ?? {};
  obj[section][key] = value;
}
