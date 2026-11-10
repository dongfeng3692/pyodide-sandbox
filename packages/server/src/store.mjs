// store.mjs — embedded SQLite persistence for execution logs + pool events
// and on-demand metrics aggregation. Uses the built-in `node:sqlite`
// (Node >= 23.4 unflagged; Node 22 needs --experimental-sqlite). If the
// module is unavailable, the store degrades to a no-op and the admin UI
// reports it — the sandbox itself never depends on storage.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { classifyFailure, classWhere } from './classify.mjs';

const require = createRequire(import.meta.url);

export class Store {
  constructor(dbPath) {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        preset TEXT,
        error_type TEXT,
        error_code TEXT,
        duration_ms INTEGER,
        code_bytes INTEGER,
        files_count INTEGER,
        result_bytes INTEGER,
        timeout INTEGER DEFAULT 0,
        code TEXT,
        stdout_preview TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_exec_ts ON executions(ts);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, -- sha256 hex of the plaintext (never stored)
        prefix TEXT NOT NULL,            -- first 8 chars, for display only
        enabled INTEGER NOT NULL DEFAULT 1,
        created_ts INTEGER NOT NULL,
        last_used_ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS samples (
        ts INTEGER PRIMARY KEY,          -- one resource snapshot per sampler tick
        data TEXT NOT NULL               -- JSON: host rss/cpu + pool counters
      );
    `);
    // migration for DBs created before the `source` column existed
    try { this.db.exec('ALTER TABLE executions ADD COLUMN source TEXT'); } catch { /* exists */ }
    this.insExec = this.db.prepare(
      `INSERT INTO executions (ts, ok, preset, error_type, error_code, duration_ms,
        code_bytes, files_count, result_bytes, timeout, code, stdout_preview, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insEvent = this.db.prepare('INSERT INTO events (ts, kind, detail) VALUES (?, ?, ?)');
    this.insSample = this.db.prepare(
      'INSERT OR REPLACE INTO samples (ts, data) VALUES (?, ?)',
    );
    // one-time migration: pre-1.0 single managed token (settings.api_token) → tokens table
    const legacy = this.getSetting('api_token');
    if (legacy) {
      this.db.prepare(
        'INSERT OR IGNORE INTO tokens (name, token_hash, prefix, enabled, created_ts) VALUES (?, ?, ?, 1, ?)',
      ).run('migrated', sha256(legacy), legacy.slice(0, 8), Date.now());
      this.db.prepare("DELETE FROM settings WHERE key = 'api_token'").run();
    }
  }

  recordExecution(rec) {
    this.insExec.run(
      rec.ts, rec.ok ? 1 : 0, rec.preset ?? null, rec.errorType ?? null,
      rec.errorCode ?? null, rec.durationMs ?? null, rec.codeBytes ?? null,
      rec.filesCount ?? null, rec.resultBytes ?? null, rec.timeout ? 1 : 0,
      rec.code ?? null, rec.stdoutPreview ?? null, rec.source ?? 'http',
    );
  }

  recordEvent(kind, detail = '') {
    this.insEvent.run(Date.now(), kind, String(detail).slice(0, 500));
  }

  /** Aggregates for the dashboard over the last `windowSeconds`. */
  metrics(windowSeconds = 3600) {
    const since = Date.now() - windowSeconds * 1000;
    const totals = this.db.prepare(
      `SELECT COUNT(*) total, SUM(ok) ok, AVG(duration_ms) avg_ms,
              SUM(timeout) timeouts, SUM(files_count) files
         FROM executions WHERE ts >= ?`,
    ).get(since);
    // failures grouped by type+code (code splits PolicyError into its rules,
    // result-contract ValueErrors apart from plain ones) → classified in JS
    // from the same source of truth the logs filters use (classify.mjs).
    const failRows = this.db.prepare(
      `SELECT COALESCE(error_type, '?') type, COALESCE(error_code, '') code, COUNT(*) n
         FROM executions WHERE ts >= ? AND ok = 0 GROUP BY type, code ORDER BY n DESC`,
    ).all(since);
    const failClasses = { blocked: 0, model: 0, system: 0 };
    // '?' is the SQL placeholder for a NULL error_type — restore it so the
    // classifier's null → system fail-safe applies
    const typeOf = (r) => (r.type === '?' ? null : r.type);
    for (const r of failRows) {
      failClasses[classifyFailure({ ok: false, errorType: typeOf(r) })] += r.n;
    }
    const errors = failRows.slice(0, 10).map((r) => ({
      type: r.type, code: r.code || null, n: r.n, cls: classifyFailure({ ok: false, errorType: typeOf(r) }),
    }));
    const mcpCalls = this.db.prepare(
      "SELECT COUNT(*) n FROM executions WHERE ts >= ? AND source = 'mcp'",
    ).get(since)?.n ?? 0;
    // p95 via ordered scan (fine at sandbox volumes)
    const count = totals?.total ?? 0;
    let p95 = null;
    if (count > 0) {
      const rows = this.db.prepare(
        'SELECT duration_ms FROM executions WHERE ts >= ? AND duration_ms IS NOT NULL ORDER BY duration_ms',
      ).all(since);
      if (rows.length) p95 = rows[Math.min(rows.length - 1, Math.floor(rows.length * 0.95))].duration_ms;
    }
    const bucketMs = Math.max(60_000, Math.round((windowSeconds * 1000) / 60));
    const buckets = this.db.prepare(
      `SELECT (ts / ${bucketMs}) * ${bucketMs} b, COUNT(*) total, SUM(ok) ok,
              AVG(duration_ms) avg_ms
         FROM executions WHERE ts >= ? GROUP BY b ORDER BY b`,
    ).all(since);
    // latest events regardless of window — the feed should always show life
    const events = this.db.prepare(
      'SELECT ts, kind, detail FROM events ORDER BY ts DESC LIMIT 20',
    ).all();
    return {
      windowSeconds,
      total: totals?.total ?? 0,
      okCount: totals?.ok ?? 0,
      failCount: (totals?.total ?? 0) - (totals?.ok ?? 0),
      successRate: count ? +(totals.ok / count).toFixed(4) : null,
      // same numbers, failures split by class; headline rate keeps the
      // historical ok/total semantics, the ex-blocked rate tells the real story
      failClasses,
      successRateExBlocked: (() => {
        const exTotal = (totals?.total ?? 0) - failClasses.blocked;
        return exTotal > 0 ? +((totals?.ok ?? 0) / exTotal).toFixed(4) : null;
      })(),
      avgMs: totals?.avg_ms != null ? Math.round(totals.avg_ms) : null,
      p95Ms: p95,
      timeouts: totals?.timeouts ?? 0,
      filesProcessed: totals?.files ?? 0,
      mcpCalls,
      errors,
      bucketMs,
      buckets,
      events,
    };
  }

  // ---------- resource samples (admin dashboard time series) ----------

  recordSample(data) {
    try { this.insSample.run(Date.now(), JSON.stringify(data)); } catch { /* never break serving */ }
  }

  /** Downsampled series (~120 points) for the dashboard line charts. */
  samplesSeries(windowSeconds = 3600) {
    const since = Date.now() - windowSeconds * 1000;
    const rows = this.db.prepare('SELECT ts, data FROM samples WHERE ts >= ? ORDER BY ts').all(since);
    const bucketMs = Math.max(10_000, Math.round((windowSeconds * 1000) / 120));
    const acc = new Map();
    for (const { ts, data } of rows) {
      let d; try { d = JSON.parse(data); } catch { continue; }
      const b = Math.floor(ts / bucketMs) * bucketMs;
      const cur = acc.get(b) ?? { n: 0, cpu: 0, rss: 0, wRss: 0, live: 0, idle: 0, waiting: 0 };
      cur.n += 1;
      cur.cpu += d.cpu ?? 0;
      cur.rss += d.rss ?? 0;
      cur.wRss += d.wRss ?? 0;
      cur.live += d.live ?? 0;
      cur.idle += d.idle ?? 0;
      cur.waiting += d.waiting ?? 0;
      acc.set(b, cur);
    }
    const points = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([ts, v]) => ({
      ts,
      cpu: +(v.cpu / v.n).toFixed(1),
      rssMb: +(v.rss / v.n).toFixed(1),
      workersRssMb: +(v.wRss / v.n).toFixed(1),
      live: Math.round(v.live / v.n),
      idle: Math.round(v.idle / v.n),
      waiting: Math.round(v.waiting / v.n),
    }));
    return { bucketMs, points };
  }

  logs({ limit = 50, offset = 0, filter = 'all', q = '' } = {}) {
    const where = ['1=1'];
    const params = [];
    if (filter === 'failed') where.push('ok = 0');
    if (filter === 'timeout') where.push('timeout = 1');
    if (filter === 'policy') where.push("error_type = 'PolicyError'"); // legacy alias of blocked
    if (filter === 'blocked' || filter === 'model' || filter === 'system') where.push(classWhere(filter));
    if (q) {
      where.push("(code LIKE ? OR COALESCE(error_type, '') LIKE ? OR COALESCE(error_code, '') LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const base = `FROM executions WHERE ${where.join(' AND ')}`;
    const total = this.db.prepare(`SELECT COUNT(*) n ${base}`).get(...params).n;
    const rows = this.db.prepare(
      `SELECT id, ts, ok, preset, error_type, error_code, duration_ms, code_bytes,
              files_count, result_bytes, timeout, source, substr(code, 1, 120) code_preview
       ${base} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...params, Math.min(limit, 200), offset)
      .map((r) => ({ ...r, fail_class: classifyFailure(r) }));
    return { total, rows };
  }

  executionDetail(id) {
    const row = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id);
    return row ? { ...row, fail_class: classifyFailure(row) } : null;
  }

  sweep(retentionHours) {
    const cutoff = Date.now() - retentionHours * 3600_000;
    this.db.prepare('DELETE FROM executions WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
  }

  // ---------- settings & admin account ----------

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  /** First-run admin initialization: {user, salt, hash} (scrypt, hex). */
  getAdminAccount() {
    const raw = this.getSetting('admin_account');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  setAdminAccount({ user, salt, hash }) {
    this.setSetting('admin_account', JSON.stringify({ user, salt, hash }));
  }

  // ---------- API tokens (multiple, toggleable, stored hashed) ----------

  createToken({ name, hash, prefix }) {
    const info = this.db.prepare(
      'INSERT INTO tokens (name, token_hash, prefix, enabled, created_ts) VALUES (?, ?, ?, 1, ?)',
    ).run(name, hash, prefix, Date.now());
    return Number(info.lastInsertRowid);
  }

  /** Display list — no hashes. */
  listTokens() {
    return this.db.prepare(
      'SELECT id, name, prefix, enabled, created_ts, last_used_ts FROM tokens ORDER BY id',
    ).all().map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
  }

  /** Hashes of enabled tokens for constant-time auth matching. */
  enabledTokenHashes() {
    return this.db.prepare('SELECT id, token_hash FROM tokens WHERE enabled = 1').all();
  }

  countEnabledTokens() {
    return this.db.prepare('SELECT COUNT(*) n FROM tokens WHERE enabled = 1').get().n;
  }

  setTokenEnabled(id, enabled) {
    return this.db.prepare('UPDATE tokens SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
  }

  deleteToken(id) {
    return this.db.prepare('DELETE FROM tokens WHERE id = ?').run(id).changes > 0;
  }

  touchToken(id) {
    this.db.prepare('UPDATE tokens SET last_used_ts = ? WHERE id = ?').run(Date.now(), id);
  }

  close() {
    try { this.db.close(); } catch { /* best effort */ }
  }
}

/** Open the store, or return null with a reason (graceful degradation). */
export async function openStore(dbPath) {
  try {
    return { store: new Store(dbPath), reason: null };
  } catch (err) {
    return {
      store: null,
      reason: `storage unavailable: ${String(err?.message ?? err).slice(0, 200)} `
        + '(node:sqlite needs Node >= 23.4, or Node 22 with --experimental-sqlite)',
    };
  }
}

export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
