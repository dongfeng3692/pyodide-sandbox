# Threat Model

This document is the trust contract of pyodide-sandbox. Read it before deploying
with untrusted input. If reality differs from what is written here, that is a
bug — please report it (see SECURITY.md).

## 0. Plain-language summary

- This is **not** container-grade isolation. It defends against
  **model-generated code** (prompt injection), not kernel 0-days.
- Pyodide alone is not a sandbox; we remove its JS bridge and its import
  finder, and freeze the import machinery (`sys.meta_path` becomes an
  immutable tuple).
- Running the server **without** the process-capability layer (Node
  `--permission` + no egress) is unsupported for untrusted input — layer 6 is
  mandatory, not optional.
- Multi-tenant separation between callers of one instance does not exist.

## 1. What this project is for

Executing **model-generated Python** (or other semi-trusted code) on a server
without containers or microVMs, when:

- running it in-process is unacceptable (import filtering is formally
  discredited — CERT VU#148244: `__import__`/`eval` bypass static import
  checks);
- a container/microVM tier (Docker+gVisor, Firecracker) is operationally
  too heavy for your scale.

Pyodide itself states it is **not a sandbox**: the `js` module has host-process
equivalent privileges in Node. pyodide-sandbox answers for that with the layer
stack below. The boundary quality depends on ALL layers being present.

## 2. Adversary

Prompt-injected model code: arbitrary Python text crafted to escape, exfiltrate,
or exhaust resources. Assume the code is **actively hostile** but delivered by
your own pipeline (no remote code execution on the host prior to execution).

NOT in scope (explicit non-goals):

- Spectre-class WASM side channels;
- a 0-day in V8/Node itself (the process capability layer mitigates blast
  radius, see §4.6);
- multi-tenant isolation between callers of one server instance — a server
  trusts its authenticated caller; run one instance per trust domain.

## 3. Assets and invariants

| Asset | Invariant |
|---|---|
| Host filesystem / credentials | Model code never sees a file API; env of the Node process may hold secrets — defense: bridge removal + `--permission` |
| Cross-session data | **Zero persistence**: fresh globals + scratch wiped before AND after each call; files arrive per-call via the request envelope |
| Result channel | Output is a size-capped JSON envelope; no side channels (stdout capped) |
| Availability | Per-call wall clock kill (worker terminate), per-worker RSS recycle, pool cap, queue cap |

## 4. Defense layers (outside → in)

1. **Session/logical isolation (design)** — zero persistence; nothing survives
   a call; workers are interchangeable.
2. **WASM memory safety** — no syscalls, no native code; a memory-corruption
   bug in a WASM package stays inside the linear memory of that runtime.
3. **Bridge removal (trusted bootstrap, `harden.py`)** — three steps:
   (a) delete `js`/`pyodide`/`micropip` from `sys.modules`; (b) **remove
   pyodide's import finder (`JsFinder`) from `sys.meta_path`** — without a
   finder, `import js` raises `ModuleNotFoundError` even if the deny finder
   is gone; (c) prepend a deny finder for denied names and **freeze
   `sys.meta_path` as a tuple** — it cannot be popped/spliced in place, and
   a wholesale reassignment is an attribute STORE (policy-banned in every
   preset except `raw`). This design is the direct answer to the escape
   chain `pd.compat.sys.meta_path.pop(0)` +
   `importlib.import_module("js")` — a model can reach `sys` through
   non-underscore attribute paths in exposed modules, so the wall must not
   depend on being the first entry of a mutable list. Regression-tested in
   `packages/server/test/e2e.test.mjs` ("bridge escape chain is blocked").
4. **AST policy engine (`policy.py`)** — ban-by-node-type, ban-by-name
   (underscore/dunder + dangerous builtins), attribute mode, attribute-STORE
   ban (anti-monkeypatch). Errors are structured (`code/symbol/line`) so the
   model can self-correct within its call budget. **Known limitation:** the
   engine sees syntax, not object graphs — a non-underscore attribute path
   through an exposed module (e.g. `pd.compat.sys`) is invisible to it.
   That is precisely why layer 3 does not rely on layer 4.
5. **Builtins replacement** — the exec environment contains a whitelist dict,
   not real `__builtins__`. The only importer present is a caged
   `_warm_import`: it resolves names against `sys.modules` and refuses
   anything not already loaded — it can never load new code, and the bridge
   modules were deleted from `sys.modules` by layer 3, so they stay
   unreachable through it. It exists because library internals (numpy's
   `_methods` &co) execute deferred imports at call time; user code cannot
   name `__import__` (layer 4 bans it outside `raw`). A missed name in
   layer 4 simply isn't reachable.
6. **Process capability (deployment)** — run the server with
   `node --permission --allow-worker --allow-fs-read=<appdir>` (Node ≥ 20) and
   an egress rule for its UID. If layers 3–5 are all bypassed, the escapee
   lands in a Node process that cannot write files, spawn children, or reach
   the network. Under `--permission`, the runtime installs a narrow shim for
   pyodide's single `process.binding("constants")` call (Node denies it
   outright; `fs.constants` is the identical, legitimately readable object —
   every other binding name stays refused).

Layer 6 is **mandatory for untrusted input**. Layers 3–5 are code, and code
can have bugs; layer 6 is what converts "our trusted bootstrap is correct"
into "even if it is wrong, the box is small". Deployments that skip it are
out of this threat model's support envelope. The Docker image packages this
layer by default (non-root, permission flags, offline-first serving; see
Dockerfile / docker-compose.yml — the build is the only networked step).

## 5. Residual risks (accepted, documented)

- **Format-string repr channel**: `"{0.__class__}".format(obj)` reads
  repr-style information through format specs, which the AST engine does not
  inspect (whitelist attribute-mode blocks `format` entirely). It leaks
  type/lineage strings, not callable objects — not an escape, but deny-
  underscore does not cover it.
- **Partial host environment mirror**: Pyodide mirrors a small set of real
  host env vars into `os.environ` inside the sandbox (observed: `LANG`,
  process path). The service token is NOT in the worker environment (the
  pool strips the `server` config section before spawning workers), but
  assume host-path/locale info is readable.
- **`raw` preset**: no policy AND no underscore-name ban; the layer-3 wall
  can be reassigned via an attribute STORE, which raw permits. Raw is for
  fully trusted code only — `removeBridge` does not make raw safe.
- **Shared-kernel with layer 6 absent**: without `--permission` + egress rule,
  a full stack bypass yields host-process code execution. State this plainly
  in your deployment docs; do not claim container-grade isolation.
- **Module-level residue within one worker**: imported library modules are
  shared by every call a warm worker serves, and the attribute-STORE ban does not
  cover ordinary API calls (`pd.set_option`, `np.seterr`,
  `warnings.simplefilter`, edits to the module registry). After every call
  the wrapper restores the known process-global state (module registry,
  `sys.path`, recursion limit, warning filters, numpy error/print state,
  the legacy `numpy.random` MT19937 state, pandas options, pandas
  `register_*_accessor` registrations — only `CachedAccessor` attributes
  that differ from the boot snapshot are reverted, so pandas' own lazily
  added internals survive) and runs a numpy/pandas canary; a failed canary
  recycles the worker (`state_recycle` event; restores appear as
  `state_restored`). A trailing partial stdout line
  (`print(..., end="")`) is flushed to its own call before the payload is
  read (two-layer: `sys.stdout.flush()` + `os.fsync`) — pyodide's batched
  handler only fires on complete lines, and an unflushed remainder would
  otherwise surface in the NEXT call's stdout. State outside that list is
  capped by `recycleAfter`. Treat as correctness risk, not escape risk.
- **Supply chain**: wheels in `wheels/` are verified against
  `wheels-lock.json` (sha256, fail-closed: missing lock or lock-external
  wheels abort boot) — write access to the wheels directory is a trust
  boundary. **Runtime** package installation from the network does not exist:
  pool workers boot fully offline.
- **Injectable dependency manifest** (`config.packages`): the declarative list
  of what the sandbox pre-binds for model code (aliases like `pd`/`np`, plus
  pyodide packages, locked wheels, allowlisted stdlib modules). It compiles
  into the existing boot primitives — no new import surface. Gates: a
  hard-deny module list (os/sys/io/js/pyodide/micropip/importlib/ctypes/…)
  rejects at resolve time; the stdlib channel is allowlist-only
  (`STDLIB_SAFE_ALLOWLIST`, code-level curated); alias names must not collide
  with the preset, safe builtins, or the `files`/`result` contract; wheel
  entries must exist and match the lock; `version` pins are re-checked against
  the loaded module's `__version__` at every boot. The manifest is data —
  hand-writing `policy.exposeModules` keeps its softer UNSAFE-warning path,
  but the manifest (the first-class entry point) fails fast instead.
- **Online install (admin-triggered, install-time-only)**: the admin UI / CLI
  may install a package by name. This is the ONLY network path for packages
  and it never touches a serving worker: a throwaway Pyodide instance (which
  never runs model code) resolves the exact dependency closure via micropip;
  pure-Python wheels (py3-none-any — compiled wheels are refused) are
  downloaded from PyPI and sha256-verified against the PyPI metadata before
  touching disk; the lock is extended atomically; and a **verification boot**
  (a full hardened runtime with the candidate manifest) must succeed before
  anything is committed to the manifest. Failure rolls back downloads and
  lock changes. The manifest applies on restart only — no hot reload. The
  "runtime micropip.install from PyPI" anti-pattern below refers to the
  serving path; the installer runs outside it, on an admin session, exactly
  once per install.

## 6. Anti-patterns we deliberately reject (observed in the wild)

| Observed | Where | Why rejected |
|---|---|---|
| No policy at all, `js` bridge open | browser Pyodide code interpreters | Contained for free in a browser opaque origin; fatal server-side |
| Copying untrusted request fields into runtime globals | ditto | Any input reflected into the exec environment widens the surface |
| Unbounded stdout accumulation | ditto | `print` loops OOM the runtime |
| In-process exec + import blacklist | pandas-ai (CERT VU#148244) | Static import filtering is not a boundary |
| Runtime `micropip.install` from PyPI | several projects | Supply chain + nondeterminism |
| Shared namespace across calls | notebook-style interpreters | Agent-facing use: stale variables are a hallucination source |
| Timeout that cannot kill (or skips shared workers) | observed in the wild | A wedged runtime must always be terminable |

## 7. Admin surface

The admin UI (monitoring · logs · tokens) is a **separate trust boundary from
the execution API**. The admin account is initialized on first visit (scrypt,
stored in SQLite) or pinned via `SBX_ADMIN_USER`/`SBX_ADMIN_PASSWORD`; its
cookie session uses timing-safe compares and a lockout after 10 failed logins.
Password changes go through the same route only with the current password
(fresh scrypt salt, all other sessions invalidated); config-pinned credentials
refuse UI changes by design.
It exposes stored execution records **including model code text** and the API
token manager — treat the database file (`data/sbx.db`) and the admin session
like the secrets they protect.

API tokens are DB-resident (sha256 at rest, plaintext shown once at creation,
enable/disable without restart, `last used` tracked). There is deliberately no
env/config token path anymore, so a leaked `ps`/compose environment cannot
leak a live credential, and rotation never requires a process restart. With
zero enabled tokens `/exec` answers `401 no_tokens_configured`; the only
opt-out is `--allow-no-token`, which must stay loopback-only.

The MCP gateway (`POST /mcp`) sits inside the same execution boundary: it
authenticates with the same tokens, routes tools through the identical
policy/pool/recording path (`source=mcp` in the log), is disabled until an
admin flips the persisted toggle, and its in-memory session table (client
name, last-seen, call counts) is admin-visible and droppable.

The **dependency manifest admin routes** (`/admin/api/packages*`) extend this
boundary: admins may edit the manifest, install packages online (see §5), and
reset to the config-file defaults — all session-gated and event-logged
(`packages_saved` / `packages_installed` / `packages_install_failed` /
`packages_reset`). API tokens cannot reach these routes. Every change is
pending until a restart; the running pool keeps enforcing the manifest it
booted with. The admin session therefore controls what model code can call
tomorrow — treat it accordingly (and prefer `SBX_ADMIN_PASSWORD` rotation
over long-lived sessions).

Keep the whole server loopback-only or behind an authenticating edge; the
admin UI inherits that perimeter rather than replacing it. Recording degrades
gracefully: if `node:sqlite` is unavailable, serving continues (requires
`--allow-no-token`) and no storage is attempted.

## 8. Verification

Every claim above that can be tested, is — see `packages/core/test/`
(NFKC full-width evasion, lambda-nested names, attribute-store, dunder access,
manifest validation/compilation/description in `packages.test.mjs`),
`packages/server/test/installer.test.mjs` (spec parsing, channel routing,
pure-wheel selection, lock extension/rollback) and the regression suite's
PKG group (all three injection channels end-to-end, admin validation 422s,
save → restart → apply, tool-description sync). New layers or policy changes
must extend these suites in the same PR.
