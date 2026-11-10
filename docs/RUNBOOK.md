# Runbook

Operating guide for a pyodide-sandbox deployment. Trust contract and
hardening rationale: [threat-model.md](threat-model.md). UI screenshots-free,
API-first.

## Deployment

### Docker (recommended)

```bash
docker compose up -d --build        # hardened baseline from docker-compose.yml
curl http://127.0.0.1:8787/health   # expect {"ok":true,...}
```

The image is offline-first: `npm ci` + pyodide cache warm happen at **build**
time; serving never touches the network and runs under
`node --permission --allow-worker --allow-fs-read=/app --allow-fs-write=/app/data`
as a non-root user. Adding dependencies = rebuild (bake cache/manifest), not
runtime install.

### Bare metal

systemd unit with `node --permission --allow-worker --allow-fs-read=<appdir>`,
`MemoryMax`, egress deny for the service UID (threat-model §4.6). Cold boots
download pyodide packages once into `SBX_CACHE_DIR` — pre-warm with
`npm run warm` for fully offline start.

## Environment variables

Precedence: CLI flag > env > `--config <file>` > defaults. Everything else is
config-file only (full schema: `packages/core/src/runtime/config.mjs`).
API tokens are **deliberately not** env/config-settable — they live in SQLite,
managed via the admin UI.

<!-- AUTO-GENERATED: env table — source: overridesFromEnv() in packages/core/src/runtime/config.mjs -->
| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SBX_HOST` | No | Bind address (default `127.0.0.1`; containers set `0.0.0.0`) | `0.0.0.0` |
| `SBX_PORT` | No | HTTP port (default `8787`) | `9000` |
| `SBX_ALLOW_NO_TOKEN` | No | `1` = `/exec` works unauthenticated while no tokens exist — loopback dev only | `1` |
| `SBX_POOL` | No | Worker pool size (default `2`) | `4` |
| `SBX_TIMEOUT_MS` | No | Per-call execution timeout (default `25000`; keep under the ~30s MCP client timeout so the structured timeout error reaches the model) | `60000` |
| `SBX_RECYCLE_EVERY` | No | Recycle a worker after N calls (default `50`) | `100` |
| `SBX_RSS_LIMIT_MB` | No | Per-worker RSS recycle threshold; `0`/empty disables (default `512`) | `1024` |
| `SBX_CACHE_DIR` | No | Pyodide package cache dir (default `./pkg-cache`) | `/app/pkg-cache` |
| `SBX_WHEELS_DIR` | No | Vendored wheels dir (default `./wheels`) | `/app/wheels` |
| `SBX_ADMIN_USER` | No | Pins the admin username (with `SBX_ADMIN_PASSWORD` disables UI account management) | `ops` |
| `SBX_ADMIN_PASSWORD` | No | Pins the admin password; unset = first `/admin` visit initializes the account (stored, scrypt) | (8+ chars) |
| `SBX_DB_PATH` | No | SQLite path: tokens, admin account, logs (default `./data/sbx.db`) | `/app/data/sbx.db` |
| `SBX_PRESET` | No | Policy preset: `general` (default) \| `strict-data` \| `minimal` \| `raw` (unsafe) | `strict-data` |
| `SBX_WITH_PANDAS` | No | `0` = drop pandas/numpy from preload (preset exposure must be adjusted too) | `0` |
<!-- /AUTO-GENERATED -->

## Endpoints

<!-- AUTO-GENERATED: endpoint table — source: packages/server/src/service.mjs -->
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/exec` | `x-sbx-token` | Execute Python (`{code, files[]}` → `{ok, result, stdout, warnings, error}`) |
| GET | `/health` | none | Liveness + pool shape `{ok, pool, live, idle, waiting, degraded}` |
| POST | `/mcp` | `Bearer`/`x-sbx-token` | MCP Streamable HTTP gateway (JSON-RPC 2.0; disabled until enabled in admin) |
| GET | `/admin` (+4 pages) | admin session | Monitoring · logs · API docs · MCP · settings |
| GET/POST | `/admin/api/status` `/setup` `/login` `/logout` | mixed | First-run setup, cookie session (10-fail lockout × 5 min) |
| POST | `/admin/api/password` | admin session | Change the stored admin password |
| GET/POST | `/admin/api/tokens` | admin session | List / create API tokens (plaintext shown once) |
| PATCH/DELETE | `/admin/api/tokens/:id` | admin session | Enable/disable / delete a token |
| GET/POST | `/admin/api/mcp` | admin session | Gateway status / enable-disable |
| DELETE | `/admin/api/mcp/sessions/:id` | admin session | Drop an MCP client session |
| GET/POST | `/admin/api/packages` | admin session | Dependency manifest: active/pending/issues (applies on restart) |
| POST/GET | `/admin/api/packages/install` | admin session | Online install job (single slot; network at install time only) |
| POST | `/admin/api/packages/reset` | admin session | Re-seed the manifest from the config file |
| GET | `/admin/api/config` | admin session | Effective config echo |
| GET | `/admin/api/metrics` | admin session | Windowed aggregates + pool detail + host snapshot |
| GET | `/admin/api/samples` | admin session | Downsampled resource time series |
| GET | `/admin/api/logs` `/logs/:id` | admin session | Execution log (filter/q/paging; includes code text) |
<!-- /AUTO-GENERATED -->

## Health & monitoring

- **`GET /health`** — `"ok": false` or `"degraded": true` means the pool
  cannot boot workers; every exec returns `503 pool_degraded`. Check logs.
- **Admin → Monitoring** — success rate, p95, timeouts, per-worker RSS/heap,
  and the event feed. Sample cadence: `server.sampleIntervalMs`.
- **Events worth alerting on**: `pool_degraded`, `boot_error`,
  `rss_recycle`, `timeout_retire`, `state_recycle` (canary failed — worker
  state could not be restored), `admin_login_lockout`,
  `packages_install_failed`.

## Common issues → fixes

| Symptom | Cause → Fix |
|---|---|
| `pool_degraded` + `wheels-lock: sha256 mismatch / not in the lock file` | A wheel in `wheels/` differs from the lock. **Treat as supply-chain signal first** — verify provenance before re-running `npm run lock:wheels`. |
| `wheels present but lock file is missing` | Someone added wheels without locking → run `npm run lock:wheels` (fail-closed by design). |
| Worker boot hangs / `pool_boot_timeout` | Disk full (pyodide needs to write cache metadata — observed as a silent hang) or a cold `pkg-cache` with no egress → free space / run `npm run warm`. |
| `store_unavailable` in logs, admin disabled | `node:sqlite` unavailable: use Node ≥ 23.4, or Node 22 with `--experimental-sqlite`. Serving continues with `--allow-no-token`. |
| `/exec` → `401 no_tokens_configured` | Create a token in Admin → Settings (or dev-only `SBX_ALLOW_NO_TOKEN=1`). |
| Admin login → `429 login_locked` | 10 failed logins = 5-minute lockout (by design). Wait or restart. |
| `408 execution_timeout` | Code ran past `SBX_TIMEOUT_MS` — the hint in the payload tells the model to vectorize; do not raise the timeout first. |
| Online install fails (`no pure-Python wheel` / network error) | The package ships C extensions (Pyodide can't run it) or the host has no egress — install-time network is required; containers must bake deps at build. |
| `PERM0006` warning about `--allow-worker` in logs | Expected noise when running under `node --permission`. |
| Package installed but tool description unchanged | Manifest changes apply on **restart** — Admin → Settings shows the "pending restart" badge. |

## Rollback

- **Docker**: redeploy the previous image tag; `sandbox-data` volume keeps
  tokens/logs. `docker compose` builds are immutable per tag.
- **Dependency manifest**: `POST /admin/api/packages/reset` re-seeds from the
  config file, then restart. Worst case, delete the `packages_manifest` row
  (SQLite `settings` table) — boot re-seeds.
- **Credentials**: tokens rotate/delete via admin UI **without restart**;
  admin password change invalidates all other sessions immediately.

## Escalation

Security issues: [SECURITY.md](SECURITY.md) (private reporting, do not open
public issues). Trust-contract questions start from
[threat-model.md](threat-model.md) §0 — this sandbox is **not** container-grade
isolation; layer 6 (permission model + egress deny) is mandatory for
untrusted input.
