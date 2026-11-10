# Configuration

Everything is config; nothing is hardcoded; dangerous overrides warn loudly.

## Presets

| Preset | Surface |
|---|---|
| `general` (default) | `pd` + `np` pre-bound, safe builtins, `def`/`class`/`lambda` allowed, no imports |
| `strict-data` | pandas-only, no defs — narrowest data-crunching surface |
| `minimal` | pure computation, no modules at all |
| `raw` | **unsafe**, trusted code only |

## Config file / API

```js
import { resolveConfig } from '@pyodide-sandbox/core';
const { config, warnings } = resolveConfig({
  policy: { preset: 'strict-data', extraBanNames: ['float'] },
  pool:   { size: 4, execTimeoutMs: 30_000, recycleAfter: 50 },
  output: { stdoutMode: 'capture', stdoutMaxChars: 4096 },
});
```

Unknown keys are rejected with a warning; weakening overrides (e.g.
`attributeMode: 'off'`, `allowNoToken`) emit `UNSAFE` warnings. Default
values and the full key list: `packages/core/src/runtime/config.mjs`
(boot keys like `bootTimeoutMs`, `maxQueue`, `maxBodyBytes`, `files.*`,
`output.*`, `dbRetentionHours`, `indexURL` are set via the config file only).

## Environment variables (win over `--config file.json`)

| Variable | Meaning (default) |
|---|---|
| `SBX_HOST` / `SBX_PORT` | bind address (`127.0.0.1`) / port (`8787`) |
| `SBX_ALLOW_NO_TOKEN` | `1` = unauthenticated `/exec` while no tokens exist — loopback dev only |
| `SBX_POOL` | worker pool size (`2`) |
| `SBX_TIMEOUT_MS` | per-call execution timeout (`25000`; keep under the ~30s MCP client timeout) |
| `SBX_RECYCLE_EVERY` | recycle a worker after N calls (`50`) |
| `SBX_RSS_LIMIT_MB` | per-worker RSS recycle threshold; `0` disables (`512`) |
| `SBX_CACHE_DIR` / `SBX_WHEELS_DIR` | pyodide package cache (`./pkg-cache`) / vendored wheels (`./wheels`) |
| `SBX_PRESET` | policy preset (`general`) |
| `SBX_WITH_PANDAS` | `0` = drop pandas/numpy from preload |
| `SBX_ADMIN_USER` / `SBX_ADMIN_PASSWORD` | pin admin credentials (otherwise first `/admin` visit initializes the account) |
| `SBX_DB_PATH` | SQLite path (`./data/sbx.db`) |

CLI flags: `--allow-no-token`, `--config <file>`.

> API tokens are deliberately **not** configurable via env/config — they live
> in the DB so they can be rotated without a restart.

> Relative paths (`cacheDir`, `wheelsDir`) resolve against the working
> directory — prefer absolute paths or `SBX_CACHE_DIR` when in doubt.

## Offline vendored wheels

`wheels/` ships two pure-Python wheels (MIT; their licenses travel inside
each wheel) used by the offline regression suite and as seed examples for the
[packages manifest](packages.md). To vendor more:

```bash
python -m pip download openpyxl et_xmlfile \
  --no-deps -d wheels/
npm run lock:wheels -w @pyodide-sandbox/server   # sha256 lock, verified at boot
```

Only pure-Python wheels are accepted (C-extension builds are refused by the
install path), and every file must match the sha256 lock.
