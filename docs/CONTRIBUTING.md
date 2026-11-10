# Contributing

Thanks for improving pyodide-sandbox. This is a **security-sensitive** repo:
the trust contract lives in [docs/threat-model.md](threat-model.md) — read it
before touching anything under `packages/core/src/policy/` or
`packages/core/src/runtime/`.

## Prerequisites

- **Node ≥ 22** (`node:sqlite` needs ≥ 23.4 unflagged, or Node 22 with
  `--experimental-sqlite`; CI also runs Node 24 — recommend 24)
- **Python 3 on PATH** — the AST policy engine is dual-use and its unit tests
  run it under your local CPython
- npm (workspaces; no other toolchain — there is deliberately no build step)

```bash
git clone https://github.com/dongfeng3692/pyodide-sandbox && cd pyodide-sandbox
npm install                 # installs both workspaces (core, server)
npm run warm -w @pyodide-sandbox/server   # optional: pre-download pyodide packages (~8MB)
```

## Commands

<!-- AUTO-GENERATED: scripts table — source: package.json (root + server workspace) -->
| Command | Description |
|---------|-------------|
| `npm start` | Start the sandbox server (bin/sbx-server.mjs) |
| `npm run test:unit` | Core unit tests: policy engine (CPython dual-use) + packages manifest validation/compilation |
| `npm run test:installer` | Online-install pipeline unit tests (spec parsing, channel routing, wheel selection, lock extension) — offline, no network |
| `npm run test:admin` | Admin pages render + inline client parses + i18n key parity |
| `npm run test:server` | Full HTTP regression suite: real service instances, pyodide pool, 140 contract-frozen cases |
| `npm test` | All of the above, in order |
| `npm run warm -w @pyodide-sandbox/server` | Pre-populate the pyodide package cache for offline boots |
| `npm run lock:wheels -w @pyodide-sandbox/server` | Regenerate the sha256 lock for vendored `wheels/` (after adding pure-Python wheels) |
| `npm run add:pkg -w @pyodide-sandbox/server -- <name[==ver]>` | Admin-equivalent CLI install of a package into the manifest (network at install time; applies on restart) |
<!-- /AUTO-GENERATED -->

Targeted runs: `node packages/server/test/regression/run.mjs --filter PKG`
(one group or ID prefix) · `--list` to enumerate case IDs.

## Writing tests

The regression suite is **contract-frozen**; see
[packages/server/test/regression/README.md](../packages/server/test/regression/README.md)
for the full conventions. The non-negotiables:

- Case IDs are `GROUP-NNN` (e.g. `PKG-007`) and **never reused** — deleting a
  case leaves a gap; references always go by ID.
- New behavior needs a profile? Add it to `PATCHES` in `harness.mjs` (an
  unregistered profile fails the runner's registry validation).
- The suite never goes online: network paths (PyPI download, micropip oracle)
  are covered by unit tests against pure functions/mocks in
  `packages/server/test/installer.test.mjs`.
- **Threat-model §8 rule**: any change to policy layers, hardening, or the
  dependency manifest gates must extend the corresponding suites **in the same
  PR**.

## Code style

- Plain ESM JavaScript + JSDoc, no TypeScript, no build step
  ([DECISIONS.md](../DECISIONS.md) D1). Policy is data + one Python engine (D2).
- Python side (`packages/core/src/policy/python/`): stdlib only; the same
  engine must stay importable under CPython.
- Match the surrounding code's comment density and idiom; comments explain
  *why*, especially around security invariants.
- Keep the two READMEs (en/zh-CN) in sync for user-facing changes.

## PR checklist

- [ ] `npm test` green locally (full regression included)
- [ ] Tests extended in the same PR for any policy/hardening/manifest change
- [ ] [docs/threat-model.md](threat-model.md) updated when touching layers 3–6
- [ ] New config keys: rejected-when-unknown + fail-fast validation (see
      `packages/core/src/runtime/config.mjs`); documented in both READMEs
- [ ] New vendored wheels: sha256-locked (`npm run lock:wheels`) and pure-Python
- [ ] UI changes: i18n keys added to **both** `zh` and `en` dictionaries
