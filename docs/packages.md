# Injectable dependencies (the packages manifest)

Model code can **never `import`** — every capability comes from boot-time
pre-binding. `config.packages` is the single declarative manifest; it
compiles into the existing preload/preimport/exposeModules machinery. Three
channels, each with its own gate:

| Channel | Example | Gate |
|---|---|---|
| `pyodide` official packages | `scipy` | must exist in the pinned pyodide release's package lock |
| `wheel` (local / PyPI) | `openpyxl` | file must sit in `wheels/` and match the sha256 lock; optional `version` pins are checked against `__version__` at every boot |
| `stdlib` | `json`, `re`, `math` | code-level allowlist only (`STDLIB_SAFE_ALLOWLIST` — extending it is a PR + tests, not a config edit) |

A hard-deny list (os/sys/io/js/pyodide/micropip/importlib/ctypes/socket/
pickle/… bridge/host/interpreter modules) rejects at resolve time with an
error, not a warning; aliases must not collide with the preset (`pd`/`np`),
safe builtins, or the `files`/`result` contract variables.

```js
resolveConfig({
  packages: [
    { name: 'numpy', aliases: { np: 'numpy' } },   // channel A
    { name: 'openpyxl', wheel: 'openpyxl-3.1.5-py2.py3-none-any.whl',
      version: '3.1.5' },                          // channel B
    { name: 're' },                                 // channel C: default alias `re`
  ],
});
```

The manifest also drives the **MCP tool description**: every entry is
rendered as "alias = module version — usage hint" inside `execute_code`'s
description (a per-entry `hint` overrides the built-in hints), so what the
agent reads is exactly what the workers enforce.

## Admin online install

Admin UI → Settings → Packages, or CLI:

```bash
npm run add:pkg -w @pyodide-sandbox/server -- openpyxl==3.1.5
```

Type a package name and the channel routes itself — stdlib binds directly,
official pyodide packages warm the cache, everything else goes through PyPI:
a throwaway runtime resolves the exact dependency closure via micropip → only
pure-Python wheels are accepted (C-extension builds are refused) → sha256 is
reconciled against the PyPI metadata → the lock file is extended → a
**verification boot** (a full hardened runtime with the candidate manifest)
must succeed before the manifest is touched; failures roll everything back.

Changes apply **on restart**; serving workers never touch the network (see
[threat-model.md](threat-model.md) §5 and DECISIONS D10).

## Storage semantics

The config file is the **default baseline** seeded into SQLite on first boot;
afterwards the DB manifest (admin edits / installs) is authoritative, and
"reset to defaults" re-seeds from the config file.
