// harness.mjs — profile boot, HTTP clients, teardown for the regression suite.
//
// A "profile" is one real service instance (pyodide pool + HTTP + own SQLite in
// an OS temp dir, OS-assigned port). Cases never touch the developer's 8787
// server or data/sbx.db. Profiles boot lazily on first use and are reused for
// every later case; `restart()` reuses the same dbPath (persistence cases).
//
// State hand-off between cases happens via `p.state` (per profile): the
// bootstrap stores `adminCookie` / `token` there. The `account` profile is
// intentionally NOT bootstrapped — its cases exercise first-run setup, login,
// lockout and password change themselves, and the lockout test intentionally
// leaves its admin locked (the profile is retired after that).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@pyodide-sandbox/core';
import { startService } from '../../src/service.mjs';

export const ADMIN_USER = 'ops';
export const ADMIN_PASS = 'reg-strong-pass-1';
export const ADMIN_PASS_2 = 'reg-rotated-pass-2';

// Profile-specific config patches, deep-merged over the common base.
// `tight` uses the raw preset on purpose: its tiny limits (stdout 64 chars,
// 1KB result) exercise truncation paths that general's defaults never hit.
export const PATCHES = {
  main: {},
  tight: {
    policy: { preset: 'raw', maxCodeBytes: 1000 },
    pool: { size: 1, execTimeoutMs: 1500, maxQueue: 1 },
    output: { resultMaxBytes: 1024, stdoutMaxChars: 64 },
    files: { maxCount: 2, maxBytesPerFile: 64 },
    server: { maxBodyBytes: 65536, sampleIntervalMs: 1000 },
  },
  strict: { policy: { preset: 'strict-data' }, pool: { size: 1 } },
  minimal: { policy: { preset: 'minimal' }, pool: { size: 1 } },
  // recycleAfter lives on its own profile: with it on `tight`, every second
  // exec retires the worker and the next case pays a ~6.5s respawn — LIM-001's
  // queue math cannot survive that.
  recycle: { policy: { preset: 'raw' }, pool: { size: 1, recycleAfter: 2 } },
  account: { pool: { size: 1 } },
  mcp: { pool: { size: 1 } },
  // PKG group: the manifest across all three channels — two stdlib aliases
  // and the repo's vendored openpyxl wheel (wheels/ is locked, unlike the
  // './no-wheels' default the other profiles use).
  packages: {
    pool: { size: 1 },
    runtime: { wheelsDir: './wheels', wheelsLockPath: './wheels/wheels-lock.json' },
    packages: [
      { name: 'json', aliases: { json: 'json' } },
      { name: 're' },
      { name: 'openpyxl', wheel: 'openpyxl-3.1.5-py2.py3-none-any.whl', version: '3.1.5' },
    ],
  },
};

const TOKEN_PROFILES = new Set(['main', 'tight', 'strict', 'minimal', 'recycle', 'mcp', 'packages']);

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const b = base[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
      ? deepMerge(b, v)
      : v;
  }
  return out;
}

const live = new Map();

async function jsonRes(res) {
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON response */ }
  return { status: res.status, headers: res.headers, body, text };
}

async function rawFetch(p, method, path, { body, headers = {} } = {}) {
  return fetch(p.base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body,
  });
}

// POST /admin/api/setup or /admin/api/login — whatever the DB state needs —
// and cache the session cookie on the profile. Idempotent (also used after
// restart, where the stored account survives but in-memory sessions do not).
async function ensureAdmin(p) {
  const st = await (await rawFetch(p, 'GET', '/admin/api/status')).json();
  const route = st.admin === 'setup' ? '/admin/api/setup' : '/admin/api/login';
  const res = await rawFetch(p, 'POST', route, { body: JSON.stringify({ user: ADMIN_USER, password: ADMIN_PASS }) });
  const out = await jsonRes(res);
  if (out.status !== 200) throw new Error(`bootstrap ${route} failed: ${out.status} ${out.text}`);
  p.state.adminCookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function ensureToken(p) {
  const res = await rawFetch(p, 'POST', '/admin/api/tokens', {
    body: JSON.stringify({ name: 'regression' }),
    headers: { cookie: p.state.adminCookie },
  });
  const out = await jsonRes(res);
  if (out.status !== 201) throw new Error(`bootstrap token create failed: ${out.status} ${out.text}`);
  p.state.token = out.body.token;
  p.state.tokenId = out.body.id;
}

export async function boot(name) {
  const cached = live.get(name);
  if (cached) return cached;
  const patch = PATCHES[name];
  if (!patch) throw new Error(`unknown profile: ${name}`);
  const dir = mkdtempSync(join(tmpdir(), `sbx-reg-${name}-`));
  const cfg = deepMerge(
    {
      server: { host: '127.0.0.1', port: 0, dbPath: join(dir, 'sbx.db') },
      // rssLimitMb is raised far above a pandas worker's real footprint —
      // otherwise RSS-triggered recycles respawn workers mid-suite and every
      // other case pays a ~10s pyodide boot, ruining determinism.
      pool: { bootTimeoutMs: 120_000, rssLimitMb: 2048 },
      // './no-wheels' does not exist → no offline wheels, no lock to violate.
      runtime: {
        cacheDir: process.env.SBX_CACHE_DIR ?? './pkg-cache',
        wheelsDir: './no-wheels',
        wheelsLockPath: './no-wheels/wheels-lock.json',
      },
    },
    patch,
  );
  const { config, warnings } = resolveConfig(cfg);
  if (warnings.length) console.log(`[boot:${name}] ${warnings.map((w) => w.message ?? w).join('; ')}`);
  const t0 = performance.now();
  let started = null;
  try {
    started = await startService(config);
    await started.pool.waitReady();
    const p = { name, dir, config, server: started.server, pool: started.pool, base: `http://127.0.0.1:${started.server.address().port}`, state: {} };
    live.set(name, p);
    if (name !== 'account') {
      await ensureAdmin(p);
      if (TOKEN_PROFILES.has(name)) await ensureToken(p);
    }
    console.log(`[boot] ${name} ready in ${Math.round(performance.now() - t0)}ms`);
    return p;
  } catch (err) {
    // close what opened, or the open DB files make the temp dir undeletable
    if (started) {
      try { await started.pool.stop(); } catch { /* best effort */ }
      try { await new Promise((resolve) => started.server.close(resolve)); } catch { /* best effort */ }
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch {
      console.log(`[boot] could not remove temp dir (busy?): ${dir}`);
    }
    throw err;
  }
}

// Stop and re-create the service with the SAME config (same dbPath). Used by
// the persistence group. Mutates the profile object in place so already-built
// case contexts stay valid.
export async function restart(name) {
  const p = live.get(name);
  if (!p) throw new Error(`profile ${name} is not booted`);
  await p.pool.stop();
  await new Promise((resolve) => p.server.close(resolve));
  const { server, pool } = await startService(p.config);
  await pool.waitReady();
  p.server = server;
  p.pool = pool;
  p.base = `http://127.0.0.1:${server.address().port}`;
  await ensureAdmin(p); // in-memory sessions died with the old instance
  return p;
}

export async function teardown() {
  for (const p of live.values()) {
    try { await p.pool.stop(); } catch { /* already stopped */ }
    try { await new Promise((resolve) => p.server.close(resolve)); } catch { /* already closed */ }
    try { rmSync(p.dir, { recursive: true, force: true }); } catch {
      console.log(`[teardown] could not remove temp dir (busy?): ${p.dir}`);
    }
  }
  live.clear();
}

// ---- case context -----------------------------------------------------------

export function makeCtx(p, c) {
  return {
    id: c.id,
    profile: c.profile,
    // live views: restart() swaps server/pool/base under the same profile
    get base() { return p.base; },
    get pool() { return p.pool; },
    state: p.state,
    restart: () => restart(p.name),
    // POST /exec. token: undefined → profile bootstrap token, null → no header.
    async exec(body, token) {
      const t = token === undefined ? p.state.token : token;
      const res = await rawFetch(p, 'POST', '/exec', {
        body: JSON.stringify(body),
        headers: t ? { 'x-sbx-token': t } : {},
      });
      return jsonRes(res);
    },
    // /admin/api/* JSON call. cookie: undefined → bootstrap session, null → none.
    async admin(method, path, body, { cookie, headers = {} } = {}) {
      const c = cookie === undefined ? p.state.adminCookie : cookie;
      const res = await rawFetch(p, method, path, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { ...(c ? { cookie: c } : {}), ...headers },
      });
      return jsonRes(res);
    },
    // escape hatch: plain fetch against the profile base URL
    fetch: (path, opts) => fetch(p.base + path, opts),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
