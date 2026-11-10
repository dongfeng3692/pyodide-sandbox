# Admin UI (monitoring · logs · API · MCP · settings)

Five pages under `/admin`, served inline with zero external assets — bilingual
(zh/en, auto-detected, switchable), light/dark theme, responsive down to phone
width, motion that respects `prefers-reduced-motion`.

- `/admin` — monitoring: a status hero (healthy / at capacity / degraded /
  unreachable, worker slots, idle / in-flight / queued) next to the last 24h
  of calls, success rate (headline keeps the ok/total semantics; the hint
  adds the rate excluding by-design blocks), p95 and failures split by class
  (blocked / model / system — policy rejections are working-as-designed, only
  infrastructure failures turn red); CPU% and memory charts with a 15m/1h/24h
  range, hover read-out and current values; per-worker table (calls, heap,
  event-loop utilization); a top-errors leaderboard grouped by error type and
  code; a severity-coloured pool event feed; auto-refreshes every 5s (paused
  while the tab is hidden).
- `/admin/logs` — execution log viewer: 24h summary, filter chips with counts
  (all / failed / blocked / model / system / timeout), debounced search,
  URL-persisted filter/search/page, keyboard-navigable rows, optional
  auto-refresh; a row opens a side drawer with the full metadata, code and
  stdout (↑/↓ steps through records).
- `/admin/api-doc` — API reference: curl / Python / JavaScript quick start,
  endpoints, authentication, request fields and response examples, request
  limits read from the running config, error codes with HTTP status and
  retryability, and the `PolicyError` code list.
- `/admin/mcp` — MCP gateway switch (persisted; confirms before disabling),
  endpoint with copy, client config snippets (config JSON / Claude Code /
  curl), the `execute_code` tool schema, connected sessions with disconnect.
- `/admin/settings` — API tokens (create, one-time reveal with ready-made
  snippets, enable/disable switch, delete with confirmation), the admin
  account (change password; read-only when credentials are env-pinned), and
  the packages manifest with online install.

## Auth

First visit to `/admin` initializes the admin account (user name + password,
scrypt-hashed in SQLite); pin credentials ahead of time with
`SBX_ADMIN_USER`/`SBX_ADMIN_PASSWORD` if you prefer config. The password can
be changed in Settings (verifies the current one, signs out other sessions).
HttpOnly SameSite=Strict cookie session (12h), timing-safe comparisons,
10-failure lockout for 5 minutes. Keep it loopback-only or behind your edge
auth.

## API tokens

Created/named/toggled/deleted in Settings, stored as sha256 hashes in SQLite
(plaintext shown exactly once at creation). Multiple tokens are supported —
one per consumer; disable one to cut it off without touching the others.
`last used` is tracked per token.

## Storage

Built-in `node:sqlite` (Node ≥ 23.4 unflagged), file at `server.dbPath`
(default `./data/sbx.db`, env `SBX_DB_PATH`), WAL mode, retention sweep every
hour (`server.dbRetentionHours`, default 72). If `node:sqlite` is unavailable
the sandbox degrades gracefully — serving continues (with `--allow-no-token`),
admin API reports `store_unavailable`.

**Recorded per execution**: ok/error(type, code, class), duration, code size,
file count, result size, timeout flag, code text (≤24KB) and stdout preview
(≤2KB) — plus pool events (timeout retire, RSS recycle, boot errors,
degraded). Treat the DB file and the admin session like the secrets they
protect (see [threat-model.md](threat-model.md) §7).
