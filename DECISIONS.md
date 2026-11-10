# DECISIONS

Architecture Decision Records (condensed). Each entry: decision, why, revisit
trigger.

## D1 — Plain ESM JavaScript + JSDoc, not TypeScript (for now)

Zero build step, zero dev-tool churn, and the critical logic (policy) is
Python anyway. **Revisit** when the first external contributor ships a type
regression or the API surface exceeds ~3 packages.

## D2 — Policy is data + one Python engine

Presets and overrides are JSON; `policy.py` is the single engine, executed
inside Pyodide AND importable under CPython for host-side pre-checks. Adding
a rule never forks an engine. **Revisit** if a rule needs non-AST signals
(e.g. runtime taint tracking), which would become a second engine.

## D3 — Bridge removal is default-on and load-bearing

Pyodide is not a sandbox by itself (`import js` reaches the Node host). We
remove the bridge modules and deny re-import via `sys.meta_path` AFTER wheel
installation (which needs micropip) and BEFORE user code. Documented as layer
3 of the threat model; disabling it emits an UNSAFE warning. **Never**
revisit silently: any change here requires a threat-model update.

## D4 — Zero persistence between calls (state via caller round-trip)

Fresh globals + scratch wipe before/after every call. Sticky sessions are
deliberately rejected for v1: model-facing stale state is a hallucination
source (observed in notebook-style interpreters). Cross-call state, when it
ships, will be named staged artifacts pickled by the wrapper and stored by
the CALLER (the staged-artifact pattern is proven elsewhere; we keep the
sandbox stateless). **Revisit** when an interactive-analysis product surface appears.

## D5 — Terminate is the only kill switch

WASM has no preemption; a runaway loop is stopped by terminating the worker
thread and respawning. Every worker must be terminable unconditionally —
no "shared" worker exempt from timeout (anti-pattern observed in the wild).

## D6 — Offline-only packages, sha256-locked

`preload` uses Pyodide's package cache; extra wheels come from a vendored
`wheels/` dir verified against `wheels-lock.json` at boot. Runtime installs
from the network do not exist as a feature. Supply-chain determinism over
convenience. (This is the SERVING-path invariant — D10's admin-triggered
online install happens at install time only and leaves it intact.)

## D7 — One server instance per trust domain

Auth is a single shared token; there is no multi-tenant account model.
Session isolation is logical (zero persistence), not account isolation.
**Revisit** only with a concrete multi-tenant requirement and a threat-model
amendment.

## D8 — Apache-2.0

Security tooling benefits from the explicit patent grant; permissive enough
for enterprise adoption. (Contrast: several adjacent projects shipped with
custom/absent licenses — that ambiguity is a real adoption blocker.)

## D9 — Name: "pyodide-sandbox" (working title)

npm/GitHub availability to be verified before first publish; keep the scoped
package names (`@pyodide-sandbox/*`) so a rename is mechanical.

## D10 — Injectable dependencies: one manifest, three gated channels, admin online install, restart to apply

What model code can use is a **declarative manifest** (`config.packages`,
DB-backed after first boot, admin-editable) that compiles into the existing
boot primitives — `runtime.preload`/`preimport`, `policy.exposeModules`, the
sha256-locked wheels dir. No new import surface: model code still cannot
`import`; it gets pre-bound aliases (the `pd`/`np` mechanism, generalized).

Channels and gates differ by source: **pyodide** official packages (version
pinned by the npm-pinned pyodide lock), **wheels** (must exist + match
`wheels-lock.json`, plus optional boot-time `version` pins checked against
`__version__`), **stdlib** (code-level allowlist only — extending it is a PR,
not a config change). A hard-deny module list (os/sys/io/js/ctypes/…)
rejects at resolve time, fail-fast — the manifest is a first-class entry
point and gets errors, not the softer UNSAFE warnings that hand-written
`exposeModules` keeps for compatibility.

**Online install** is admin-session-only and install-time-only: a throwaway
Pyodide (never runs model code) resolves deps via micropip, pure wheels are
sha256-verified against PyPI metadata, and a **verification boot** of the
full candidate environment must succeed before the manifest is touched.
Failure rolls back. Everything applies on **restart** — no hot reload, no
`listChanged` churn; the MCP tool description (`describeEnvironment`) is
generated from the active policy+manifest, so what the agent reads is what
the workers enforce. Offline deployments keep the manual
wheels/ + `npm run lock:wheels` flow. **Revisit** if a multi-environment
(per-request dependency selection) requirement appears — that needs separate
pools and per-environment tools, and a fresh threat-model pass.

## D11 — Policy & error-surface fixes from live agent testing (2026-11-10)

Four fixes from a live MCP test session (20 probe executions against a real
agent conversation):

1. **`self`/`cls` attribute stores are legal inside class bodies.** The
   `class` syntax was already allowed, but `forbidAttributeStore` rejected
   `self.x = ...`, so no class could hold state — the feature was unusable.
   `policy.py` now exempts Store-context attribute chains *rooted at*
   `self`/`cls` when lexically inside a `ClassDef`; a bare
   `def f(self): self.x = 1` at module level stays forbidden, so the
   exemption is not a monkeypatch hole for `pd`/`np`/`files`.
2. **Network errors say the rule.** URL fetches fail deterministically, but
   surfaced as `Remote end closed connection` / `TLS not supported` —
   transport-flavored messages that invite the model to retry other URLs.
   `runtime_hint` now maps them to "network access is disabled … do not
   retry".
3. **`execTimeoutMs` default 60s → 25s.** Common MCP clients cut the call at
   ~30s, so a 60s budget meant the model got a bare client timeout and never
   saw the structured `execution_timeout` error. 25s keeps the structured
   error reachable; long-lived HTTP users override via `SBX_TIMEOUT_MS`.
4. **Dunder `forbidden_name` hints stop suggesting renames** (`__import__`
   gets the import-disabled hint), `dir()` gets a NameError hint, and
   `describeEnvironment`'s "Not available" line names the builtins models
   habitually reach for (`dir`, `vars`, `globals`, `locals`, `id`, …) — the
   "(nothing else)" whitelist alone did not stop first-attempt `dir()`
   failures in practice.

## D12 — Failure classes derived at read time; success rate keeps its denominator (2026-11-10)

The dashboard's ok/fail binary made policy blocks look like outages: a
test session of deliberate `forbidden_*` probes dragged 24h success to
42% with every "failure" being the sandbox working as designed.

**Three classes** (`server/src/classify.mjs`, single source of truth):
`blocked` (rejected before execution — PolicyError + pre-check validation,
including the legacy blanket `validation` rows), `model` (the code ran and
failed — runtime exceptions, result-contract violations, timeouts), and
`system` (infrastructure: pool/worker/boot; unknown failure shapes also
land here so they surface instead of hiding as "normal").

**Derived at read time** from persisted `error_type`/`error_code` — no
schema change, no backfill: rows written before the feature classify
exactly like new ones, so dashboards never show a semantics gap. The logs
SQL filters are generated from the same exported constants as the
classifier (parity-locked by `classify.test.mjs`).

**Success rate keeps the historical ok/total semantics** as the headline
(alert thresholds and history curves stay comparable); the fail-KPI hint adds the ex-blocked rate and a
per-class breakdown, and the KPI only turns red for `system`. Recording
fixes that make the classes meaningful: pre-check rejections persist their
real type (`invalid_code`/`too_many_files`/…, was blanket `validation`),
`ResultTooLarge` carries `code: result_too_large`, and the metrics errors
leaderboard groups by type+code (PolicyError splits per rule). The legacy
`filter=policy` logs parameter stays as an alias of `blocked`.
