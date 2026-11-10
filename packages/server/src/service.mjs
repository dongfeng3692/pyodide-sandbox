// service.mjs — HTTP front. Node builtins only.
// Public: POST /exec (x-sbx-token), GET /health.
// API tokens are stored in SQLite (hashed) and managed from the admin UI —
// create several, enable/disable, delete. No token in env/config anymore;
// with zero enabled tokens /exec answers 401 unless server.allowNoToken.
// Admin (first visit to /admin initializes the account, or env-pinned):
//   GET  /admin, /admin/logs, /admin/settings — pages (inline HTML, no assets)
//   POST /admin/api/login|logout|setup        — cookie session (single account)
//   GET  /admin/api/metrics|logs[/:id]        — dashboard data (session required)
//   GET/POST /admin/api/tokens, PATCH/DELETE /admin/api/tokens/:id
// Every execution and pool event is recorded to embedded SQLite (node:sqlite).
import { createServer } from 'node:http';
import os from 'node:os';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  resolveConfig, resolvePolicy, describeEnvironment, validatePackages,
  STDLIB_SAFE_ALLOWLIST, BUILTIN_HINTS,
} from '@pyodide-sandbox/core';
import { Pool } from './pool.mjs';
import { openStore, sha256 } from './store.mjs';
import { createMcpGateway } from './mcp.mjs';
import { createInstaller } from './installer.mjs';
import { readBody, parseJson, isPlainObject } from './http-util.mjs';
import { dashboardPage, logsPage, settingsPage, apiPage, mcpPage } from './admin/pages.mjs';

const SESSION_TTL_MS = 12 * 3600_000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCKOUT_MS = 5 * 60_000;
const ADMIN_BODY_MAX_BYTES = 4096;

// Admin API body: null when the transport failed (oversize/abort — nobody is
// listening, stop), otherwise the parsed object ({} for malformed/non-object
// JSON, so field validation below answers 422 as before).
async function readAdminJson(req) {
  const { ok, text } = await readBody(req, ADMIN_BODY_MAX_BYTES);
  if (!ok) return null;
  const body = parseJson(text);
  return isPlainObject(body) ? body : {};
}

function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// constant-length compare via sha256 (avoids length/timing leaks on passwords)
function secretMatches(provided, expected) {
  return timingSafeEqual(Buffer.from(sha256(provided)), Buffer.from(sha256(expected)));
}

function scryptVerify(password, saltHex, hashHex) {
  const derived = scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
  return timingSafeEqual(derived, Buffer.from(hashHex, 'hex'));
}

const STATUS_BY_CODE = {
  queue_full: [429, true],
  execution_timeout: [408, false],
  pool_degraded: [503, false],
  shutting_down: [503, false],
};

// Actionable next steps for infrastructure-level failures (the Python wrapper
// attaches its own hints to code-level errors).
const INFRA_HINTS = {
  queue_full: 'the sandbox is busy — retry the same call after a short delay',
  execution_timeout: (cfg) => `the code ran longer than ${Math.round(cfg.pool.execTimeoutMs / 1000)}s and was killed — `
    + 'avoid Python-level loops over rows (use vectorized pandas/numpy), or process less data per call',
  pool_degraded: 'the sandbox cannot start its runtime — an operator must fix the server; do not retry',
  shutting_down: 'the server is restarting — retry in a few seconds',
};

/** Validate + normalize the request files into fresh {name, b64} strings. */
function normalizeFiles(files, limits) {
  const list = Array.isArray(files) ? files : []; // non-array → [] (frozen: VAL-005)
  if (list.length > limits.maxCount) {
    return { error: ['too_many_files', `at most ${limits.maxCount} files per call (got ${list.length})`] };
  }
  const out = [];
  for (const [i, f] of list.entries()) {
    if (!isPlainObject(f)) {
      return { error: ['invalid_files', `files[${i}] must be an object {"name": "...", "b64": "..."}`] };
    }
    const entry = { name: String(f.name ?? 'file'), b64: String(f.b64 ?? '') };
    const bytes = Buffer.from(entry.b64, 'base64').length; // exact, lenient decode (frozen: VAL-008)
    if (bytes > limits.maxBytesPerFile) {
      return { error: ['file_too_large', `${entry.name} is ${bytes} bytes decoded; the limit is ${limits.maxBytesPerFile} bytes per file`] };
    }
    out.push(entry);
  }
  return { files: out };
}

export async function startService(config) {
  // Server-process CPU% sampler for the admin dashboard: deltas between
  // consecutive /admin/api/metrics calls (% of one core, user+system).
  let lastCpu = process.cpuUsage();
  let lastCpuTs = Date.now();
  const hostSnapshot = () => {
    const now = Date.now();
    const cur = process.cpuUsage();
    const elapsedMs = Math.max(1, now - lastCpuTs);
    const cpuPct = Math.round((((cur.user - lastCpu.user) + (cur.system - lastCpu.system)) / (elapsedMs * 1000)) * 1000) / 10;
    lastCpu = cur;
    lastCpuTs = now;
    const mem = process.memoryUsage();
    return {
      pid: process.pid,
      rssMb: Math.round((mem.rss / 1048576) * 10) / 10,
      cpuPct,
      sysTotalMb: Math.round(os.totalmem() / 1048576),
      sysFreeMb: Math.round(os.freemem() / 1048576),
      uptimeS: Math.round(process.uptime()),
    };
  };

  const { store, reason: storeReason } = await openStore(config.server.dbPath);
  if (store) store.sweep(config.server.dbRetentionHours);
  const sweepTimer = store
    ? setInterval(() => store.sweep(config.server.dbRetentionHours), 3600_000)
    : null;
  if (sweepTimer) sweepTimer.unref();

  // --- injectable dependency manifest (packages) ---
  // The config file's `packages` is the DEFAULT baseline: seeded into the DB
  // on first boot; afterwards the DB (admin edits / online installs) is
  // authoritative and applies on restart. `POST /admin/api/packages/reset`
  // re-seeds. Serving never reads the network here — the installer does, on
  // admin demand only.
  const seedJson = JSON.stringify(config.packages ?? []);
  let pendingManifest = JSON.parse(seedJson);
  // Manifest validation must run against the PRISTINE exposeModules (preset +
  // operator's explicit config), never the compiled map — the manifest's own
  // aliases would otherwise collide with themselves. null is a LEGAL pristine
  // value ("preset supplies"), so this is an explicit undefined check.
  const pristineExpose = config._pristine && 'policyExposeModules' in config._pristine
    ? config._pristine.policyExposeModules
    : config.policy.exposeModules;
  const policyView = { ...config.policy, exposeModules: pristineExpose };
  if (store) {
    let raw = store.getSetting('packages_manifest');
    if (raw == null) {
      store.setSetting('packages_manifest', seedJson);
      raw = seedJson;
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) pendingManifest = parsed;
      else throw new Error('not an array');
    } catch {
      store.recordEvent('packages_manifest_corrupt', 'falling back to the config-file manifest');
      pendingManifest = JSON.parse(seedJson);
    }
  }
  const pendingNorm = validatePackages(pendingManifest, {
    policyConfig: policyView,
    denyModules: config.runtime.denyModules,
  });
  // Re-resolve with the pending manifest; resolveConfig is idempotent over an
  // already-resolved base (it strips the previous manifest's compiled
  // contributions first). An invalid pending manifest keeps the seed config.
  if (!pendingNorm.errors.length && JSON.stringify(pendingNorm.entries) !== JSON.stringify(config.packages ?? [])) {
    config = resolveConfig({ packages: pendingManifest }, config).config;
  }
  const activeManifest = config.packages ?? [];
  const installer = createInstaller({ config, store, seed: JSON.parse(seedJson), policyView });
  // Pending state is always recomputed from the DB (the installer and the
  // save route both write it) — no cached flag can go stale.
  const pendingState = () => {
    const pending = installer.readPending();
    const norm = validatePackages(pending, { policyConfig: policyView, denyModules: config.runtime.denyModules });
    return {
      pending,
      norm,
      restartRequired: norm.errors.length > 0 || JSON.stringify(norm.entries) !== JSON.stringify(activeManifest),
    };
  };

  const pool = new Pool(config, {
    onEvent: (kind, detail) => store?.recordEvent(kind, detail),
  });

  // --- MCP gateway (enable/disable persisted in the DB settings table) ---
  const mcpEnabled = () => store?.getSetting('mcp_enabled') === '1';

  // --- resource sampler for the dashboard time series (host + pool) ---
  let lastSampleCpu = process.cpuUsage();
  let lastSampleTs = Date.now();
  const sampleTimer = store
    ? setInterval(() => {
      const now = Date.now();
      const cur = process.cpuUsage();
      const elapsedMs = Math.max(1, now - lastSampleTs);
      const cpu = ((cur.user - lastSampleCpu.user) + (cur.system - lastSampleCpu.system)) / (elapsedMs * 1000) * 100;
      lastSampleCpu = cur;
      lastSampleTs = now;
      const detail = pool.detail();
      store.recordSample({
        cpu: +cpu.toFixed(1),
        rss: process.memoryUsage().rss / 1048576,
        wRss: detail.workers.reduce((sum, w) => sum + (w.rssMb ?? 0), 0),
        live: detail.live,
        idle: detail.idle,
        waiting: detail.waiting,
      });
    }, Math.max(1000, config.server.sampleIntervalMs ?? 10_000))
    : null;
  if (sampleTimer) sampleTimer.unref();

  // --- token auth: match the provided secret against every ENABLED token
  // hash (constant-length sha256 compare, no early exit). Returns the matched
  // id, or why the request is refused.
  const matchToken = (provided) => {
    const providedHash = sha256(String(provided ?? ''));
    const enabled = store?.enabledTokenHashes() ?? [];
    let matchedId = null;
    for (const { id, token_hash: h } of enabled) {
      if (tokenMatches(providedHash, h)) matchedId = id;
    }
    if (matchedId !== null) return { ok: true, tokenId: matchedId };
    if (enabled.length === 0 && config.server.allowNoToken) return { ok: true, tokenId: null };
    return { ok: false, reason: enabled.length === 0 ? 'no_tokens' : 'unauthorized' };
  };
  const authenticateExec = (req) => matchToken(req.headers['x-sbx-token']);
  // MCP clients traditionally send Authorization: Bearer — accept both there.
  const authenticateMcp = (req) => {
    const auth = String(req.headers.authorization ?? '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    return matchToken(bearer ?? req.headers['x-sbx-token']);
  };

  // --- admin account: env-pinned > stored (first-run setup) > not initialized
  const adminStatus = () => {
    if (config.server.adminPassword) {
      return { mode: 'ready', source: 'config', user: config.server.adminUser };
    }
    const acct = store?.getAdminAccount();
    if (acct) return { mode: 'ready', source: 'stored', user: acct.user };
    return { mode: 'setup', source: 'none', user: config.server.adminUser };
  };

  // --- admin session state (single account, in-memory sessions) ---
  const sessions = new Map(); // token -> expires
  const loginFailures = { count: 0, lockedUntil: 0 };
  const cleanSessions = () => {
    const now = Date.now();
    for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  };
  const issueSession = (res) => {
    cleanSessions();
    const t = randomBytes(32).toString('hex');
    sessions.set(t, Date.now() + SESSION_TTL_MS);
    res.setHeader('set-cookie', `sbx_admin=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  };
  const sessionCookie = (req) => {
    const raw = req.headers.cookie ?? '';
    const m = /(?:^|;\s*)sbx_admin=([a-f0-9]{64})/.exec(raw);
    if (m && sessions.has(m[1]) && sessions.get(m[1]) > Date.now()) return m[1];
    const auth = req.headers.authorization ?? '';
    if (auth.startsWith('Bearer ')) {
      const t = auth.slice(7).trim();
      if (sessions.has(t) && sessions.get(t) > Date.now()) return t;
    }
    return null;
  };
  const requireSession = (req, res) => {
    if (!sessionCookie(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { type: 'unauthorized', retryable: false } }));
      return false;
    }
    return true;
  };
  const verifyAdmin = (user, password) => {
    const st = adminStatus();
    if (st.mode !== 'ready') return false;
    if (st.source === 'config') {
      return secretMatches(user, config.server.adminUser) && secretMatches(password, config.server.adminPassword);
    }
    const acct = store.getAdminAccount();
    return secretMatches(user, acct.user) && scryptVerify(password, acct.salt, acct.hash);
  };

  const recordExec = (rec) => {
    if (!store) return;
    try { store.recordExecution(rec); } catch { /* storage must never break serving */ }
  };

  // --- shared execution pipeline for /exec and MCP tools/call: validate →
  // pool.exec → record. Returns {status, payload} without HTTP concerns.
  const executeJob = async ({ code, files: rawFiles, source = 'http' }) => {
    const t0 = Date.now();
    const precheckFail = (type, message, filesCount) => {
      recordExec({
        // the real type (invalid_code / too_many_files / ...) — the legacy
        // blanket 'validation' hid which rule fired; classify.mjs maps both
        ts: t0, ok: false, errorType: type, durationMs: 0, source,
        codeBytes: typeof code === 'string' ? Buffer.byteLength(code) : 0, filesCount,
      });
      return { status: 422, payload: { ok: false, error: { type, message, retryable: false } } };
    };
    const rawCount = Array.isArray(rawFiles) ? rawFiles.length : 0;
    if (typeof code !== 'string' || !code.trim()) {
      return precheckFail('invalid_code', '`code` must be a non-empty string of Python source', rawCount);
    }
    const normalized = normalizeFiles(rawFiles, config.files);
    if (normalized.error) return precheckFail(...normalized.error, rawCount);
    const { files } = normalized;
    try {
      const payload = await pool.exec({ code, files });
      recordExec({
        ts: t0, ok: Boolean(payload.ok), preset: config.policy.preset,
        errorType: payload.ok ? null : (payload.error?.type ?? null),
        errorCode: payload.ok ? null : (payload.error?.code ?? null),
        durationMs: Date.now() - t0,
        codeBytes: Buffer.byteLength(code), filesCount: files.length,
        resultBytes: JSON.stringify(payload).length,
        timeout: false, code: code.slice(0, 24_000),
        stdoutPreview: typeof payload.stdout === 'string' ? payload.stdout.slice(0, 2048) : null,
        source,
      });
      return { status: 200, payload };
    } catch (exc) {
      const timedOut = exc.code === 'execution_timeout';
      recordExec({
        ts: t0, ok: false, preset: config.policy.preset,
        errorType: exc.code ?? 'execution_unavailable',
        durationMs: Date.now() - t0,
        codeBytes: Buffer.byteLength(code), filesCount: files.length,
        timeout: timedOut, code: code.slice(0, 24_000), source,
      });
      const coded = exc.code && STATUS_BY_CODE[exc.code] ? exc.code : null;
      if (coded) {
        const [status, retryable] = STATUS_BY_CODE[coded];
        const hint = typeof INFRA_HINTS[coded] === 'function' ? INFRA_HINTS[coded](config) : INFRA_HINTS[coded];
        return { status, payload: { ok: false, error: { type: coded, message: exc.message.slice(0, 200), hint, retryable } } };
      }
      return { status: 500, payload: { ok: false, error: { type: 'execution_unavailable', message: String(exc).slice(0, 200), retryable: true } } };
    }
  };

  // Resolved once: the policy the workers enforce, described for model-facing
  // surfaces (MCP tool description / initialize instructions).
  const { policy: activePolicy } = resolvePolicy(config.policy);
  const mcpGateway = createMcpGateway({
    execute: executeJob,
    isEnabled: mcpEnabled,
    maxBodyBytes: config.server.maxBodyBytes,
    describe: () => describeEnvironment({ policy: activePolicy, config, runtime: pool.runtimeInfo }),
  });

  const server = createServer(async (req, res) => {
    const json = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(body));
    };
    // A bug in any route (e.g. a SQLite error) must answer 500, never crash
    // the process — recording already follows "storage must never break
    // serving", and reads get the same guarantee here.
    const handler = async () => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // ---------- pages & admin API ----------
    const PAGES = {
      '/admin': [dashboardPage, 'monitoring'],
      '/admin/logs': [logsPage, 'logs'],
      '/admin/api-doc': [apiPage, 'api'],
      '/admin/mcp': [mcpPage, 'mcp'],
      '/admin/settings': [settingsPage, 'settings'],
    };
    if (PAGES[path]) {
      if (adminStatus().mode === 'setup' && !store) {
        return json(503, { ok: false, error: { type: 'store_unavailable', message: storeReason } });
      }
      const [page] = PAGES[path];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page());
    }
    if (path === '/admin/api/status' && req.method === 'GET') {
      const st = adminStatus();
      // don't leak the username to unauthenticated callers
      const authed = Boolean(sessionCookie(req));
      return json(200, {
        ok: true, admin: st.mode,
        user: authed && st.mode === 'ready' ? st.user : null,
        source: st.source, store: store ? 'ok' : 'unavailable',
      });
    }
    if (path === '/admin/api/setup' && req.method === 'POST') {
      if (Date.now() < loginFailures.lockedUntil) {
        return json(429, { ok: false, error: { type: 'setup_locked', retryable: false } });
      }
      const st = adminStatus();
      if (st.mode !== 'setup') {
        return json(409, { ok: false, error: { type: 'already_initialized', retryable: false } });
      }
      if (!store) {
        return json(503, { ok: false, error: { type: 'store_unavailable', message: storeReason } });
      }
      const body = await readAdminJson(req);
      if (!body) return undefined; // oversize/abort: nobody is listening
      const { user, password } = body;
      if (
        typeof user !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(user)
        || typeof password !== 'string' || password.length < 8 || password.length > 200
      ) {
        return json(422, { ok: false, error: { type: 'invalid_credentials', message: 'user: 1-64 [A-Za-z0-9_.-]; password: 8-200 chars', retryable: false } });
      }
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex');
      store.setAdminAccount({ user, salt, hash });
      store.recordEvent('admin_initialized', `user=${user}`);
      issueSession(res);
      return json(200, { ok: true, user });
    }
    if (path === '/admin/api/login' && req.method === 'POST') {
      if (adminStatus().mode !== 'ready') {
        return json(409, { ok: false, error: { type: 'not_initialized', retryable: false } });
      }
      if (Date.now() < loginFailures.lockedUntil) {
        return json(429, { ok: false, error: { type: 'login_locked', retryable: false } });
      }
      const body = await readAdminJson(req);
      if (!body) return undefined; // oversize/abort: nobody is listening
      const { user, password } = body;
      if (typeof user === 'string' && typeof password === 'string' && verifyAdmin(user, password)) {
        loginFailures.count = 0;
        issueSession(res);
        return json(200, { ok: true });
      }
      loginFailures.count += 1;
      if (loginFailures.count >= LOGIN_MAX_FAILURES) {
        loginFailures.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
        loginFailures.count = 0;
        store?.recordEvent('admin_login_lockout', `${LOGIN_MAX_FAILURES} failed logins`);
      }
      await new Promise((r) => setTimeout(r, 250)); // constant-ish response time
      return json(401, { ok: false, error: { type: 'unauthorized', retryable: false } });
    }
    if (path === '/admin/api/logout' && req.method === 'POST') {
      const t = sessionCookie(req);
      if (t) sessions.delete(t);
      return json(200, { ok: true }, { 'set-cookie': 'sbx_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (path.startsWith('/admin/api/')) {
      if (!requireSession(req, res)) return undefined;
      if (!store) {
        return json(503, { ok: false, error: { type: 'store_unavailable', message: storeReason, retryable: false } });
      }
      // ----- account: change password (stored credentials only) -----
      if (path === '/admin/api/password' && req.method === 'POST') {
        const st = adminStatus();
        if (st.mode !== 'ready') {
          return json(409, { ok: false, error: { type: 'not_initialized', retryable: false } });
        }
        if (st.source === 'config') {
          return json(409, {
            ok: false,
            error: {
              type: 'config_pinned',
              message: 'credentials are pinned via SBX_ADMIN_USER/SBX_ADMIN_PASSWORD; change them in your environment, or unset them to manage the account here',
              retryable: false,
            },
          });
        }
        const body = await readAdminJson(req);
        if (!body) return undefined; // oversize/abort: nobody is listening
        const { current, next } = body;
        const acct = store.getAdminAccount();
        const currentOk = typeof current === 'string' && scryptVerify(current, acct.salt, acct.hash);
        if (!currentOk) {
          await new Promise((r) => setTimeout(r, 250)); // constant-ish response time, like login
          return json(401, { ok: false, error: { type: 'unauthorized', message: 'current password is incorrect', retryable: false } });
        }
        if (typeof next !== 'string' || next.length < 8 || next.length > 200) {
          return json(422, { ok: false, error: { type: 'invalid_password', message: 'password: 8-200 chars', retryable: false } });
        }
        const salt = randomBytes(16).toString('hex');
        const hash = scryptSync(next, Buffer.from(salt, 'hex'), 32).toString('hex');
        store.setAdminAccount({ user: acct.user, salt, hash });
        store.recordEvent('admin_password_changed', `user=${acct.user}`);
        // keep the current session, sign out everywhere else
        const sess = sessionCookie(req);
        for (const t of [...sessions.keys()]) if (t !== sess) sessions.delete(t);
        return json(200, { ok: true });
      }
      // ----- token management (multi-token, hashed at rest, toggleable) -----
      if (path === '/admin/api/tokens' && req.method === 'GET') {
        return json(200, { ok: true, tokens: store.listTokens() });
      }
      if (path === '/admin/api/tokens' && req.method === 'POST') {
        const body = await readAdminJson(req);
        if (!body) return undefined; // oversize/abort: nobody is listening
        const { name } = body;
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
          return json(422, { ok: false, error: { type: 'invalid_name', message: 'name: 1-64 chars', retryable: false } });
        }
        const token = randomBytes(24).toString('hex');
        const id = store.createToken({ name: name.trim(), hash: sha256(token), prefix: token.slice(0, 8) });
        store.recordEvent('token_created', `id=${id} name=${name.trim()}`);
        return json(201, { ok: true, id, token }); // plaintext returned exactly once
      }
      const tokId = /^\/admin\/api\/tokens\/(\d+)$/.exec(path);
      if (tokId && req.method === 'PATCH') {
        const body = await readAdminJson(req);
        if (!body) return undefined; // oversize/abort: nobody is listening
        const { enabled } = body;
        if (typeof enabled !== 'boolean') {
          return json(422, { ok: false, error: { type: 'invalid_body', message: 'enabled: boolean required', retryable: false } });
        }
        if (!store.setTokenEnabled(Number(tokId[1]), enabled)) return json(404, { ok: false, error: { type: 'not_found' } });
        store.recordEvent(enabled ? 'token_enabled' : 'token_disabled', `id=${tokId[1]}`);
        return json(200, { ok: true });
      }
      if (tokId && req.method === 'DELETE') {
        if (!store.deleteToken(Number(tokId[1]))) return json(404, { ok: false, error: { type: 'not_found' } });
        store.recordEvent('token_deleted', `id=${tokId[1]}`);
        return json(200, { ok: true });
      }
      if (path === '/admin/api/mcp' && req.method === 'GET') {
        return json(200, { ok: true, enabled: mcpEnabled(), sessions: mcpGateway.listSessions() });
      }
      if (path === '/admin/api/mcp' && req.method === 'POST') {
        const body = await readAdminJson(req);
        if (!body) return undefined; // oversize/abort: nobody is listening
        const { enabled } = body;
        if (typeof enabled !== 'boolean') {
          return json(422, { ok: false, error: { type: 'invalid_body', message: 'enabled: boolean required', retryable: false } });
        }
        store.setSetting('mcp_enabled', enabled ? '1' : '0');
        store.recordEvent(enabled ? 'mcp_enabled' : 'mcp_disabled', '');
        return json(200, { ok: true, enabled: mcpEnabled() });
      }
      const mcpSess = /^\/admin\/api\/mcp\/sessions\/([a-f0-9-]+)$/.exec(path);
      if (mcpSess && req.method === 'DELETE') {
        return json(200, { ok: mcpGateway.dropSession(mcpSess[1]) });
      }
      // ----- injectable dependency manifest (applies on restart) -----
      if (path === '/admin/api/packages' && req.method === 'GET') {
        const st = pendingState();
        return json(200, {
          ok: true,
          active: activeManifest,
          pending: st.pending,
          restartRequired: st.restartRequired,
          pendingIssues: st.norm.errors,
          stdlibAllowlist: STDLIB_SAFE_ALLOWLIST,
          builtinHints: Object.keys(BUILTIN_HINTS),
          install: installer.status(),
        });
      }
      if (path === '/admin/api/packages' && req.method === 'POST') {
        const body = await readAdminJson(req);
        if (!body) return undefined; // oversize/abort: nobody is listening
        if (!Array.isArray(body.packages)) {
          return json(422, { ok: false, error: { type: 'invalid_body', message: 'packages: array of entries required', retryable: false } });
        }
        const norm = validatePackages(body.packages, { policyConfig: policyView, denyModules: config.runtime.denyModules });
        if (norm.errors.length) {
          return json(422, { ok: false, error: { type: 'invalid_packages', message: 'manifest rejected', issues: norm.errors, retryable: false } });
        }
        store.setSetting('packages_manifest', JSON.stringify(body.packages));
        store.recordEvent('packages_saved', `${body.packages.length} entries`);
        return json(200, { ok: true, restartRequired: pendingState().restartRequired });
      }
      if (path === '/admin/api/packages/install' && req.method === 'POST') {
        const body = await readAdminJson(req);
        if (!body) return undefined; // oversize/abort: nobody is listening
        try {
          const { status } = installer.install(String(body.spec ?? ''));
          return json(202, { ok: true, job: status() });
        } catch (err) {
          if (err.code === 'install_busy') return json(409, { ok: false, error: { type: 'install_busy', message: err.message, retryable: true } });
          return json(422, { ok: false, error: { type: err.code ?? 'invalid_spec', message: err.message, retryable: false } });
        }
      }
      if (path === '/admin/api/packages/install' && req.method === 'GET') {
        return json(200, { ok: true, job: installer.status() });
      }
      if (path === '/admin/api/packages/reset' && req.method === 'POST') {
        store.setSetting('packages_manifest', seedJson);
        store.recordEvent('packages_reset', 're-seeded from the config file');
        return json(200, { ok: true, restartRequired: pendingState().restartRequired });
      }
      if (path === '/admin/api/samples' && req.method === 'GET') {
        const windowSeconds = Math.min(86_400, Math.max(600, Number(url.searchParams.get('window') ?? 3600)));
        return json(200, { ok: true, ...store.samplesSeries(windowSeconds) });
      }
      if (path === '/admin/api/config' && req.method === 'GET') {
        return json(200, {
          ok: true,
          preset: config.policy.preset,
          pool: { size: config.pool.size, execTimeoutMs: config.pool.execTimeoutMs, maxQueue: config.pool.maxQueue, recycleAfter: config.pool.recycleAfter, rssLimitMb: config.pool.rssLimitMb },
          files: config.files,
          output: config.output,
          policy: { maxCodeBytes: config.policy.maxCodeBytes },
          packages: {
            active: activeManifest.map((e) => ({ name: e.name, source: e.source, aliases: e.aliases, version: e.version ?? null })),
            restartRequired: pendingState().restartRequired,
          },
          mcp: { enabled: mcpEnabled() },
          allowNoToken: config.server.allowNoToken,
        });
      }
      if (path === '/admin/api/metrics' && req.method === 'GET') {
        const windowSeconds = Math.min(86_400, Math.max(60, Number(url.searchParams.get('window') ?? 3600)));
        return json(200, { ok: true, ...store.metrics(windowSeconds), pool: pool.detail(), host: hostSnapshot() });
      }
      if (path === '/admin/api/logs' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
        const filter = String(url.searchParams.get('filter') ?? 'all');
        const q = String(url.searchParams.get('q') ?? '').slice(0, 200);
        return json(200, { ok: true, ...store.logs({ limit, offset, filter, q }) });
      }
      const detail = /^\/admin\/api\/logs\/(\d+)$/.exec(path);
      if (detail && req.method === 'GET') {
        const row = store.executionDetail(Number(detail[1]));
        return row ? json(200, { ok: true, ...row }) : json(404, { ok: false, error: { type: 'not_found' } });
      }
      return json(404, { ok: false, error: { type: 'not_found' } });
    }

    // ---------- public surface ----------
    if (req.method === 'GET' && path === '/health') {
      const s = pool.stats;
      return json(200, { ok: !s.degraded, ...s });
    }
    if (req.method === 'POST' && path === '/exec') {
      const auth = authenticateExec(req);
      if (!auth.ok) {
        return json(401, {
          ok: false,
          error: {
            type: auth.reason === 'no_tokens'
              ? 'no_tokens_configured'
              : 'unauthorized',
            message: auth.reason === 'no_tokens'
              ? 'no API tokens exist yet — create one in the admin UI (Settings), or start with --allow-no-token for loopback dev'
              : 'missing or invalid x-sbx-token header',
            retryable: false,
          },
        });
      }
      if (auth.tokenId !== null) { try { store.touchToken(auth.tokenId); } catch { /* metrics only */ } }
      // Awaited inside the guarded handler: any throw becomes a 500, never an
      // unhandled rejection (a bare `null` body used to kill the process).
      const { ok, text } = await readBody(req, config.server.maxBodyBytes);
      if (!ok) return undefined; // oversize: socket destroyed (frozen: INFRA-006)
      const body = parseJson(text);
      if (!isPlainObject(body)) {
        recordExec({ ts: Date.now(), ok: false, errorType: 'invalid_json', durationMs: 0, source: 'http' });
        return json(422, {
          ok: false,
          error: {
            type: 'invalid_json',
            message: body === undefined
              ? 'request body is not valid JSON'
              : 'request body must be a JSON object: {"code": "...", "files": [{"name": "...", "b64": "..."}]}',
            retryable: false,
          },
        });
      }
      const { status, payload } = await executeJob({ code: body.code, files: body.files, source: 'http' });
      return json(status, payload);
    }
    if (path === '/mcp') {
      const auth = authenticateMcp(req);
      if (!auth.ok) {
        return json(401, {
          ok: false,
          error: {
            type: auth.reason === 'no_tokens' ? 'no_tokens_configured' : 'unauthorized',
            message: auth.reason === 'no_tokens'
              ? 'no API tokens exist yet — create one in the admin UI (Settings)'
              : 'send an API token as "Authorization: Bearer <token>" (or x-sbx-token)',
            retryable: false,
          },
        });
      }
      if (auth.tokenId !== null) { try { store.touchToken(auth.tokenId); } catch { /* metrics only */ } }
      const handled = await mcpGateway.handle(req, res, auth);
      return handled ? undefined : json(404, { ok: false, error: { type: 'not_found' } });
    }
    return json(404, { ok: false, error: { type: 'not_found', retryable: false } });
    };
    try {
      await handler();
    } catch (err) {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { type: 'internal', message: String(err?.message ?? err).slice(0, 200), retryable: true } }));
      } catch { /* headers already sent — nothing more we can do */ }
    }
  });

  await new Promise((resolveListening) => server.listen(config.server.port, config.server.host, resolveListening));
  server.on('close', () => {
    if (sweepTimer) clearInterval(sweepTimer);
    if (sampleTimer) clearInterval(sampleTimer);
    mcpGateway.close();
    store?.close();
  });
  return { server, pool, store, storeReason, adminStatus };
}
