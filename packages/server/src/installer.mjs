// installer.mjs — admin-triggered ONLINE package installation.
//
// Trust boundary (threat-model D10): the ONLY code path that touches the
// network for packages. It runs on an admin session, at INSTALL time — never
// in the serving boot path (pool workers stay fully offline + sha256-locked).
//
// Flow: validate spec → route (stdlib | pyodide | pypi) →
//   pypi: resolve the exact (name, version) closure with a throwaway Pyodide
//         instance's micropip (same interpreter & pyodide constraints as the
//         serving runtime — no hand-rolled dependency resolver), download
//         each pure-Python wheel from PyPI, verify sha256 against the PyPI
//         metadata, extend wheels-lock.json →
//   verify-boot: boot a throwaway hardened runtime with the CANDIDATE
//         manifest (exactly what a serving worker would do) and run one exec.
//         Nothing enters the manifest without surviving this boot.
//   commit: persist the candidate manifest to the DB (applies on restart).
// Any failure rolls the downloads and the lock back; the manifest is never
// touched.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

import {
  resolveConfig, initRuntime, validatePackages,
  STDLIB_SAFE_ALLOWLIST, FORBIDDEN_EXPOSE, MAX_WHEEL_BYTES,
} from '@pyodide-sandbox/core';

const PYPI_API = 'https://pypi.org/pypi';

const specError = (message) => {
  const e = new Error(message);
  e.code = 'invalid_spec';
  return e;
};

/** "openpyxl" | "openpyxl==3.1.5" → {name, version, req}. Rejects URLs,
 *  extras, whitespace and anything that is not a plain package name. */
export function parseSpec(input) {
  const s = String(input ?? '').trim();
  if (!s || s.length > 200 || /[\s/[\\\]]/.test(s)) throw specError(`"${s}" is not a package spec`);
  const parts = s.split('==');
  if (parts.length > 2) throw specError('use exactly one "==" (name==version)');
  const [name, version] = parts;
  if (!/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name) || name.includes('..') || name.startsWith('_')) {
    throw specError(`"${name}" is not a valid package name`);
  }
  if (version !== undefined && !/^[0-9][A-Za-z0-9.+*!]*$/.test(version)) {
    throw specError(`"${version}" is not a valid version`);
  }
  return { name, version: version ?? null, req: version ? `${name}==${version}` : name };
}

/** Package names bundled with the pinned pyodide release (its lock file in
 *  node_modules). Empty when the lock cannot be read — callers then route to
 *  PyPI, which fails closed on non-pure wheels anyway. */
let pyodideNamesCache = null;
export function pyodidePackageNames() {
  if (pyodideNamesCache) return pyodideNamesCache;
  const require = createRequire(import.meta.url);
  let dir;
  try { dir = dirname(require.resolve('pyodide/package.json')); } catch { return []; }
  try {
    const lock = JSON.parse(readFileSync(join(dir, 'pyodide-lock.json'), 'utf-8'));
    pyodideNamesCache = Object.keys(lock.packages ?? {});
  } catch {
    pyodideNamesCache = [];
  }
  return pyodideNamesCache;
}

/** Decide the injection channel for a package name. Throws on forbidden
 *  modules before anything touches the network. */
export function route(name) {
  const top = name.split('.', 1)[0];
  if ((FORBIDDEN_EXPOSE.has(top) || FORBIDDEN_EXPOSE.has(name)) && !STDLIB_SAFE_ALLOWLIST.includes(name)) {
    const e = new Error(`"${name}" is a forbidden module (bridge/host/interpreter access)`);
    e.code = 'forbidden_module';
    throw e;
  }
  if (STDLIB_SAFE_ALLOWLIST.includes(name)) return 'stdlib';
  if (pyodidePackageNames().includes(name)) return 'pyodide';
  return 'pypi';
}

/** The first pure-Python wheel (py3-none-any / py2.py3-none-any) of a PyPI
 *  release — C-extension wheels cannot run under WASM. */
export function pickPureWheel(urls) {
  return (urls ?? []).find((u) => u.packagetype === 'bdist_wheel'
    && /-(?:py3|py2\.py3|py3\.py3)-none-any\.whl$/.test(u.filename ?? '')) ?? null;
}

/** Resolve the exact (name → version) transitive closure with a throwaway
 *  Pyodide instance. micropip evaluates environment markers and pyodide's
 *  own constraints with the SAME interpreter the sandbox serves — a host-side
 *  resolver would drift. The instance never runs model code and is destroyed
 *  afterwards; only the name@version pairs leave it. */
export async function resolveWithMicropip(req, cacheDir, { loadPyodide } = {}) {
  const loader = loadPyodide ?? (await import('pyodide')).loadPyodide;
  const py = await loader({ packageCacheDir: resolve(cacheDir) });
  try {
    await py.loadPackage('micropip');
    const out = await py.runPythonAsync([
      'import json, importlib.metadata as im',
      'def _snap():',
      '    return {d.metadata["Name"].lower(): d.version for d in im.distributions()}',
      'before = _snap()',
      'import micropip',
      `await micropip.install([${JSON.stringify(req)}])`,
      'after = _snap()',
      'print(json.dumps({k: v for k, v in after.items() if before.get(k) != v}))',
    ].join('\n'));
    const resolved = JSON.parse(out);
    if (!resolved || typeof resolved !== 'object') throw new Error('micropip returned no resolution');
    return resolved;
  } finally {
    try { py.destroy(); } catch { /* best effort */ }
  }
}

/** Download one wheel from PyPI, sha256-verified against the PyPI metadata.
 *  Returns {filename, sha256, version, size}; `downloaded` is false when an
 *  identical file is already on disk. */
export async function downloadWheel(name, version, wheelsDir, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${PYPI_API}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
  if (!res.ok) throw new Error(`PyPI metadata for ${name}==${version}: HTTP ${res.status}`);
  const meta = await res.json();
  const url = pickPureWheel(meta.urls);
  if (!url) {
    throw new Error(
      `${name}==${version} has no pure-Python wheel (py3-none-any) — it ships compiled code that Pyodide cannot run; `
      + 'check whether the pyodide distribution already includes it',
    );
  }
  if ((url.size ?? 0) > MAX_WHEEL_BYTES) {
    throw new Error(`${url.filename} is ${Math.round(url.size / 1048576)}MB — over the ${Math.round(MAX_WHEEL_BYTES / 1048576)}MB install limit`);
  }
  const fileRes = await fetchImpl(url.url);
  if (!fileRes.ok) throw new Error(`download ${url.filename}: HTTP ${fileRes.status}`);
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (url.digests?.sha256 && url.digests.sha256 !== sha256) {
    throw new Error(`sha256 mismatch for ${url.filename} (PyPI metadata vs downloaded bytes)`);
  }
  mkdirSync(wheelsDir, { recursive: true });
  const path = join(wheelsDir, url.filename);
  if (existsSync(path)) {
    const existing = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (existing === sha256) return { filename: url.filename, sha256, version: url.version ?? version, size: bytes.length, downloaded: false };
    throw new Error(`${url.filename} already exists in ${wheelsDir} with different content`);
  }
  writeFileSync(path, bytes);
  return { filename: url.filename, sha256, version: url.version ?? version, size: bytes.length, downloaded: true };
}

/** Add downloaded wheels to wheels-lock.json (fail closed if the dir already
 *  has wheels without a lock). Returns the rollback token: the previous file
 *  content, or null when the file did not exist. */
export function extendLock(wheelsDir, lockPath, additions) {
  const whls = existsSync(wheelsDir) ? readdirSync(wheelsDir).filter((f) => f.endsWith('.whl')) : [];
  const backup = existsSync(lockPath) ? readFileSync(lockPath, 'utf-8') : null;
  if (backup === null) {
    const adding = new Set(additions.map((a) => a.filename));
    if (whls.some((f) => !adding.has(f))) {
      throw new Error(`${wheelsDir} holds wheels but ${lockPath} is missing — run "npm run lock:wheels" first (fail closed)`);
    }
  }
  const lock = backup === null ? {} : JSON.parse(backup);
  for (const { filename, sha256 } of additions) {
    if (lock[filename] && lock[filename] !== sha256) {
      throw new Error(`wheels-lock: "${filename}" is already locked with a different sha256`);
    }
    lock[filename] = sha256;
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  return backup;
}

/** Boot a throwaway hardened runtime exactly like a serving worker would,
 *  with the candidate manifest, and run one exec. This is the gate nothing
 *  skips: dependency problems surface here, not in production boots. */
export async function verifyBoot(baseConfig, manifest) {
  const { config } = resolveConfig({ packages: manifest }, structuredClone(baseConfig));
  const rt = await initRuntime(config);
  try {
    const payload = await rt.exec({ code: 'result = {"ok": True}' });
    if (payload?.ok !== true) {
      throw new Error(`verification exec failed: ${payload?.error?.type ?? 'unknown'} ${payload?.error?.message ?? ''}`.trim());
    }
  } finally {
    try { rt.dispose(); } catch { /* best effort */ }
  }
}

const RUNNING_PHASES = new Set(['resolving', 'downloading', 'verifying', 'committing']);

/**
 * One-slot install job registry. `install()` returns immediately; poll
 * `status()`. Errors never throw out of the job — they land in `status()`.
 * @param {object} o
 * @param {object} o.config  the ACTIVE resolved config (rebind target)
 * @param {object} [o.store] SQLite store (manifest + events); without it
 *        every install fails fast
 * @param {Array}  [o.seed]  config-file manifest (DB fallback / first boot)
 * @param {object} [o.policyView] config.policy view with PRISTINE
 *        exposeModules — validating candidates against the compiled map
 *        would make every existing entry collide with itself
 */
export function createInstaller({ config, store = null, seed = [], policyView = config.policy }) {
  let job = { phase: 'idle' };

  const readPending = () => {
    try {
      const raw = store?.getSetting('packages_manifest');
      const parsed = raw == null ? structuredClone(seed) : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : structuredClone(seed);
    } catch {
      return structuredClone(seed);
    }
  };

  const status = () => ({ ...job });

  function install(specStr) {
    if (RUNNING_PHASES.has(job.phase)) {
      const e = new Error('an install is already running');
      e.code = 'install_busy';
      throw e;
    }
    if (!store) {
      const e = new Error('storage unavailable — the installer persists the manifest in SQLite');
      e.code = 'store_unavailable';
      throw e;
    }
    const spec = parseSpec(specStr);       // invalid_spec
    const channel = route(spec.name);      // forbidden_module
    job = { id: randomUUID(), spec: specStr, name: spec.name, channel, phase: 'resolving', startedTs: Date.now(), detail: '' };
    const done = run().then(() => status());
    return { status, done };
  }

  async function run() {
    const spec = parseSpec(job.spec);
    const wheelsDir = resolve(config.runtime.wheelsDir);
    const lockPath = resolve(config.runtime.wheelsLockPath);
    const current = readPending();
    const downloaded = [];
    let lockBackup;
    let extended = false;
    try {
      if (current.some((e) => e?.name === spec.name)) {
        throw new Error(`"${spec.name}" is already in the manifest (remove it first to reinstall)`);
      }
      let entries;
      if (job.channel === 'stdlib' || job.channel === 'pyodide') {
        entries = [{ name: spec.name, source: job.channel, ...(spec.version ? { version: spec.version } : {}) }];
      } else {
        job = { ...job, phase: 'resolving', detail: 'resolving dependencies (micropip oracle)' };
        const resolved = await resolveWithMicropip(spec.req, config.runtime.cacheDir);
        const key = spec.name.toLowerCase();
        if (!resolved[key]) throw new Error(`micropip did not resolve "${spec.name}"`);
        const pyodideNames = new Set(pyodidePackageNames());
        const depEntries = [];
        const lockAdds = [];
        for (const [depName, depVersion] of Object.entries(resolved)) {
          if (depName === key) continue;
          if (current.some((e) => e?.name === depName) || depEntries.some((e) => e.name === depName)) continue;
          if (pyodideNames.has(depName)) {
            depEntries.push({ name: depName, source: 'pyodide', aliases: null });
            continue;
          }
          job = { ...job, phase: 'downloading', detail: `downloading ${depName}==${depVersion}` };
          const d = await downloadWheel(depName, depVersion, wheelsDir);
          if (d.downloaded) downloaded.push(d.filename);
          lockAdds.push(d);
          depEntries.push({ name: depName, source: 'pypi', aliases: null, wheel: d.filename, version: d.version, sha256: d.sha256 });
        }
        job = { ...job, phase: 'downloading', detail: `downloading ${spec.name}==${resolved[key]}` };
        const main = await downloadWheel(spec.name, resolved[key], wheelsDir);
        if (main.downloaded) downloaded.push(main.filename);
        lockAdds.push(main);
        if (lockAdds.some((a) => a.downloaded)) {
          lockBackup = extendLock(wheelsDir, lockPath, lockAdds);
          extended = true;
        }
        entries = [
          { name: spec.name, source: 'pypi', wheel: main.filename, version: main.version, sha256: main.sha256 },
          ...depEntries,
        ];
      }

      const candidate = [...current, ...entries];
      const { errors } = validatePackages(candidate, {
        policyConfig: policyView,
        denyModules: config.runtime.denyModules,
      });
      if (errors.length) {
        throw new Error(`manifest rejected: ${errors.map((e) => `[${e.index}] ${e.field}: ${e.message}`).join('; ')}`);
      }

      job = { ...job, phase: 'verifying', detail: 'booting a verification runtime (applies on restart)' };
      await verifyBoot(config, candidate);

      job = { ...job, phase: 'committing', detail: '' };
      store.setSetting('packages_manifest', JSON.stringify(candidate));
      store.recordEvent('packages_installed', `${spec.name} via ${job.channel}`);
      job = { ...job, phase: 'done', restartRequired: true, detail: '', doneTs: Date.now() };
    } catch (err) {
      // rollback: remove files this run downloaded, restore the lock
      for (const f of downloaded) {
        try { unlinkSync(join(wheelsDir, f)); } catch { /* best effort */ }
      }
      if (extended) {
        if (lockBackup === null) {
          try { unlinkSync(lockPath); } catch { /* best effort */ }
        } else writeFileSync(lockPath, lockBackup);
      }
      const message = String(err?.message ?? err).slice(0, 300);
      store?.recordEvent('packages_install_failed', `${spec.name}: ${message}`);
      job = { ...job, phase: 'error', error: message, doneTs: Date.now() };
    }
  }

  return { install, status, readPending };
}
