// runtime.mjs — one hardened Pyodide runtime instance (no pool, no HTTP).
// Reusable standalone: embed this in your own process if you don't want a server.

import { mkdirSync, existsSync, readdirSync, readFileSync, constants as FS_CONSTANTS } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { resolvePolicy, buildWrapperSource } from '../policy/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function sanitizeName(name) {
  const base = String(name).replace(/.*[/\\]/, '');
  return base.replace(/[^A-Za-z0-9._-]/g, '_') || 'file';
}

/** Fail-closed wheels verification: any wheel in the directory must be
 *  present in wheels-lock.json with a matching sha256. A non-empty wheels
 *  directory without a lock file is a boot error (never a silent pass). */
export function verifyWheels(wheelsDir, lockPath) {
  const whls = existsSync(wheelsDir)
    ? readdirSync(wheelsDir).filter((f) => f.endsWith('.whl')).sort()
    : [];
  if (!whls.length) return; // no wheels configured
  if (!existsSync(lockPath)) {
    throw new Error(
      `wheels present in ${wheelsDir} but lock file ${lockPath} is missing — run "npm run lock:wheels" (fail closed)`,
    );
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
  for (const name of whls) {
    const expected = lock[name];
    if (!expected) throw new Error(`wheels-lock: "${name}" is not in the lock file (fail closed)`);
    const actual = createHash('sha256').update(readFileSync(join(wheelsDir, name))).digest('hex');
    if (actual !== expected) throw new Error(`wheels-lock: sha256 mismatch for ${name}`);
  }
}

async function installWheels(py, wheelsDir) {
  if (!existsSync(wheelsDir)) return;
  const whls = readdirSync(wheelsDir).filter((f) => f.endsWith('.whl'));
  if (!whls.length) return;
  py.FS.mkdir('/wheels');
  for (const f of whls) py.FS.writeFile('/wheels/' + f, readFileSync(join(wheelsDir, f)));
  await py.loadPackage(['micropip']);
  // micropip parses bare strings as URLs — wheels inside the Emscripten FS
  // need the emfs: scheme (verified against pyodide 314 / micropip).
  const list = whls.map((f) => `"emfs:/wheels/${f}"`).join(', ');
  await py.runPythonAsync(`import micropip\nawait micropip.install([${list}])`);
}

/** pyodide's Emscripten layer (NODEFS.staticInit) reads the fs flag constants
 *  through process.binding("constants"), which `node --permission` denies —
 *  the whole pyodide boot dies with "process.binding". fs.constants is the
 *  identical object (verified key-for-key) and legitimately readable under
 *  the permission model, so shim exactly that: `constants` resolves, every
 *  other binding name stays refused. Trusted boot code, runs before any
 *  pyodide import, once per thread (workers have own module instances). */
let bindingShimmed = false;
function ensureNodefsBindingShim() {
  if (bindingShimmed) return;
  bindingShimmed = true;
  try {
    process.binding('constants');
    return; // not gated (no --permission, or a future Node that allows it)
  } catch { /* gated — install the shim */ }
  process.binding = (name) => {
    if (name === 'constants') return { fs: FS_CONSTANTS };
    throw new Error(`process.binding(${JSON.stringify(name)}) is blocked in this host (permission model)`);
  };
}

/**
 * Boot a hardened runtime.
 * @param {object} cfg resolved config (runtime/policy/files/output sections used)
 * @param {object} [inject] {loadPyodide} for tests
 */
export async function initRuntime(cfg, { loadPyodide } = {}) {
  ensureNodefsBindingShim();
  const loader = loadPyodide ?? (await import('pyodide')).loadPyodide;
  const cacheDir = resolve(cfg.runtime.cacheDir);
  // create only when missing: mkdir unconditionally would demand fs-write
  // permission even on an existing (pre-warmed, read-only) cache — e.g. under
  // `node --permission` in a container (threat-model §4.6)
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  verifyWheels(resolve(cfg.runtime.wheelsDir), resolve(cfg.runtime.wheelsLockPath));

  const loadOpts = { packageCacheDir: cacheDir };
  if (cfg.runtime.indexURL) loadOpts.indexURL = cfg.runtime.indexURL;

  // Manifest wheel files must actually exist (verifyWheels above already
  // ensured every file present in the dir matches the sha256 lock).
  for (const e of cfg.packages ?? []) {
    if (!e.wheel) continue;
    if (!existsSync(join(resolve(cfg.runtime.wheelsDir), e.wheel))) {
      throw new Error(
        `packages: wheel "${e.wheel}" for "${e.name}" not found in ${cfg.runtime.wheelsDir} — place it there and run "npm run lock:wheels"`,
      );
    }
  }

  const py = await loader(loadOpts);

  // worker_threads have no real stdout fd; capture with cap instead.
  let stdoutBuf = '';
  let stdoutTruncated = false;
  const cap = cfg.output.stdoutMaxChars;
  py.setStdout({
    batched: (s) => {
      if (cfg.output.stdoutMode === 'discard') return;
      if (stdoutBuf.length >= cap) { stdoutTruncated = true; return; }
      stdoutBuf += s + '\n';
      if (stdoutBuf.length > cap) {
        stdoutBuf = stdoutBuf.slice(0, cap);
        stdoutTruncated = true;
      }
    },
  });
  py.setStderr({ batched: () => {} });

  if (cfg.runtime.preload?.length) await py.loadPackage(cfg.runtime.preload);
  await installWheels(py, resolve(cfg.runtime.wheelsDir));

  // pay import cost at boot so the first user call is warm
  if (cfg.runtime.preimport?.length) {
    py.runPython(`import ${cfg.runtime.preimport.join(', ')}`);
  }

  if (cfg.runtime.removeBridge) {
    const deny = JSON.stringify(cfg.runtime.denyModules);
    py.runPython(
      'import json\n' +
      readFileSync(join(HERE, 'harden.py'), 'utf-8') +
      `\nharden(json.loads(r'''${deny}'''))`,
    );
  }

  const { policy, warnings: policyWarnings } = resolvePolicy(cfg.policy);
  // Expose modules purely on the Python side (importlib is trusted init code;
  // preimport has already paid the import cost for common modules).
  const exposedSpec = JSON.stringify(policy.exposeModules ?? {});
  try {
    py.runPython(
      'import json, importlib\n' +
      `_EXPOSED_MODULES = {a: importlib.import_module(m) for a, m in json.loads(r'''${exposedSpec}''').items()}`,
    );
  } catch (err) {
    const names = Object.values(policy.exposeModules ?? {}).join(', ');
    throw new Error(
      `exposeModules failed to import [${names}] — add them to runtime.preload/preimport or wheels (e.g. SBX_WITH_PANDAS=0 removes pandas but preset "${cfg.policy.preset}" still exposes it). Cause: ${String(err).slice(0, 200)}`,
    );
  }

  const source = buildWrapperSource(policy, { resultMaxBytes: cfg.output.resultMaxBytes });
  const WRAP = py.runPython(source);
  const RESET = py.globals.get('SBX_RESET');
  const info = JSON.parse(py.runPython(
    'json.dumps({a: {"module": m.__name__, "version": getattr(m, "__version__", None)} '
    + 'for a, m in _EXPOSED_MODULES.items()})',
  ));

  // Version pins from the packages manifest: fail closed — a pinned module
  // that reports a different (or no) version means the supply chain moved.
  const pinByModule = new Map();
  for (const e of cfg.packages ?? []) {
    if (!e.version) continue;
    for (const target of new Set([e.name, ...Object.values(e.aliases ?? {})])) pinByModule.set(target, e);
  }
  for (const { module: modName, version: modVersion } of Object.values(info)) {
    const entry = pinByModule.get(modName);
    if (!entry) continue;
    if (modVersion == null) {
      throw new Error(`packages: "${entry.name}" is pinned to ${entry.version} but reports no __version__ — remove the pin or the entry`);
    }
    if (modVersion !== entry.version) {
      throw new Error(`packages: "${entry.name}" is pinned to ${entry.version} but ${modVersion} is loaded — update the pin or the wheel`);
    }
  }

  try { py.FS.mkdir('/scratch'); } catch { /* exists */ }

  /** Execute one call. Zero persistence: scratch wiped before and after,
   *  shared library state restored after (health.broken → recycle me). */
  async function run({ code, files = [] }) {
    stdoutBuf = '';
    stdoutTruncated = false;
    wipeScratch(py);
    const names = [];
    for (const f of files) {
      const name = sanitizeName(f.name);
      py.FS.writeFile('/scratch/' + name, Buffer.from(f.b64, 'base64'));
      names.push(name);
    }
    const out = WRAP(code, JSON.stringify(names));
    wipeScratch(py);
    const health = JSON.parse(RESET());
    const payload = JSON.parse(out);
    payload.stdout = stdoutBuf;
    if (stdoutTruncated) {
      payload.warnings = [...(payload.warnings ?? []), 'stdout_truncated'];
    }
    return { payload, health };
  }

  return {
    py,
    policy,
    policyWarnings,
    WRAP,
    /** {alias: {module, version}} for the exposed modules. */
    info: { modules: info },
    run,
    async exec(call) {
      return (await run(call)).payload;
    },
    dispose() {
      try { py.destroy?.(); } catch { /* best effort */ }
    },
  };
}

export function wipeScratch(py) {
  for (const entry of py.FS.readdir('/scratch')) {
    if (entry === '.' || entry === '..') continue;
    try { py.FS.unlink('/scratch/' + entry); } catch { /* flat files only */ }
  }
}
