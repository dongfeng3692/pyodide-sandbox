# API reference

The HTTP and MCP surface of pyodide-sandbox. Interactive copies of all of
this (with your live config values and ready-made tokens) are served at
`/admin/api-doc`.

## `POST /exec`

Header `x-sbx-token: <token>`; body:

```json
{
  "code": "result = {\"n\": 6*7}",
  "files": [{ "name": "demo.csv", "b64": "YSxiCjEsMgozLDQK" }]
}
```

`files` is optional (`{name, b64}` for binaries, `{name, text}` for text);
each entry surfaces in model code as `files["demo.csv"]` — a fresh stream on
every access, so `pd.read_csv(files["demo.csv"])` works any number of times.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ok:true, result, warnings, stdout}` | executed |
| 200 | `{ok:false, warnings, error:{type,code,symbol,line,message,hint,retryable}, stdout}` | sandbox-level error (policy violation / runtime error) — the model can self-correct from `code`/`line`/`symbol` and the one-line `hint` (what to change) |
| 401 | `{ok:false, error:{type:"unauthorized"}}` | bad/disabled token |
| 401 | `{ok:false, error:{type:"no_tokens_configured"}}` | no enabled tokens yet — create one in the admin UI |
| 408 | `{ok:false, error:{type:"execution_timeout", retryable:false}}` | hard timeout, worker was terminated |
| 422 | `invalid_json` / `invalid_code` / `invalid_files` / `too_many_files` / `file_too_large` (with a `message` naming the limit) | request rejected before execution |
| 429 | `{ok:false, error:{type:"queue_full", retryable:true}}` | pool queue full — back off and retry |
| 500 | `execution_unavailable` | unexpected worker/pool failure |
| 503 | `pool_degraded` / `shutting_down` | repeated boot failures / stopping |

The error envelope never leaks stack traces; failures carry
`{type, code?, line, symbol, message, hint?, retryable}`. Code-level errors
are HTTP 200 on purpose — the request itself succeeded, the sandbox reported
a structured, fixable failure.

## `GET /health`

`{ok, pool, live, idle, waiting, pending, degraded}` — `ok:false` when the
boot circuit breaker latched. No auth.

## MCP endpoint (`POST /mcp`)

JSON-RPC 2.0 over the Streamable HTTP transport: `initialize` →
`Mcp-Session-Id` header, `tools/list`, `tools/call` with a single
`execute_code` tool that runs through the same pool, policy engine and
recording as `/exec` (log rows are tagged `source=mcp`). Clients authenticate
with the same API tokens (`Authorization: Bearer <token>` or `x-sbx-token`).

The endpoint is **disabled by default** — enable it in the admin UI
(`/admin/mcp`), where connected sessions are listed and can be dropped.
Disabling answers `404` to everything immediately. Server-initiated SSE is
not implemented (`GET /mcp` → 405); request/response clients work as-is.

Client configuration (generic `mcpServers` shape):

```json
{
  "mcpServers": {
    "pyodide-sandbox": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

What the model gets:

- **Generated environment docs** — the tool description and the `initialize`
  `instructions` are built from the *active* policy and config (preset,
  pre-bound modules with live versions, available builtins, rejected syntax,
  limits), so they never drift from what the workers enforce.
- **Text or binary files** — `files: [{name, text}]` for CSV/JSON, `{name, b64}`
  for binaries. `files[name]` hands out a fresh stream on every access.
- **Structured results** — `structuredContent` (+ `outputSchema`) and the same
  JSON as text; code-level errors carry a `hint` and drop `retryable` (to a
  model it reads as "resend as-is", which fails identically).

Sessions are bookkeeping only (every call is stateless): requests without
`Mcp-Session-Id` are served statelessly, unknown ids (server restart, idle
expiry) are resumed transparently, and only ids an admin dropped — or reused
with a different token — get `404`, the signal for clients to re-initialize.
Also supported: `ping`, protocol version negotiation (`2025-06-18`,
`2025-03-26`, `2024-11-05`), batches.
