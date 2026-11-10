// mcp.mjs — Model Context Protocol gateway over Streamable HTTP (JSON-RPC 2.0
// on POST /mcp), zero dependencies. Exposes one tool (execute_code, see
// mcp-tool.mjs) that runs through the same pool/policy/recording path as
// POST /exec. Enable/disable is a persisted admin setting; clients
// authenticate with the same API tokens as /exec.
//
// Sessions are bookkeeping only — every tool call is stateless — so the
// gateway never strands a client:
//  - no Mcp-Session-Id header      → served statelessly
//  - unknown id (server restarted, idle-expired) → transparently resumed
//  - id an admin revoked, or used with a different token → HTTP 404, which
//    tells spec-compliant clients to re-initialize
import { randomUUID } from 'node:crypto';
import { readBody, parseJson, isPlainObject } from './http-util.mjs';
import { TOOL_NAME, toolDefinition, toJob, toolResult } from './mcp-tool.mjs';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']; // newest first
const SESSION_TTL_MS = 30 * 60_000;
const REVOKED_TTL_MS = 24 * 3600_000;
const SWEEP_INTERVAL_MS = 60_000;
const SERVER_INFO = { name: 'pyodide-sandbox', version: '0.1.0' };

const INSTRUCTIONS_LEAD = 'This server runs Python for data analysis through the `execute_code` tool. '
  + 'Every call is independent: put the full computation (including reading files) in one call and '
  + 'return the answer via `result`.\n\n';

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export function negotiateVersion(requested) {
  return SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
}

export function createMcpGateway({ execute, isEnabled, maxBodyBytes, describe }) {
  const sessions = new Map(); // id → {client, version, protocol, created, lastSeen, calls, tokenId, resumed}
  const revoked = new Map();  // id → revokedAt (admin drop) — answered with 404

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(id);
    for (const [id, ts] of revoked) if (now - ts > REVOKED_TTL_MS) revoked.delete(id);
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  // → {session} | {session: null} (stateless) | {reject: message}
  function resolveSession(sid, tokenId) {
    if (!sid) return { session: null };
    if (revoked.has(sid)) return { reject: 'session was terminated — send initialize to start a new one' };
    const existing = sessions.get(sid);
    if (existing) {
      if (existing.tokenId !== tokenId) return { reject: 'session belongs to a different API token — send initialize' };
      return { session: existing };
    }
    const now = Date.now();
    const resumed = {
      client: 'unknown', version: '', protocol: '', created: now, lastSeen: now, calls: 0, tokenId, resumed: true,
    };
    sessions.set(sid, resumed);
    return { session: resumed };
  }

  async function callTool(id, params, session) {
    if (params?.name !== TOOL_NAME) return rpcError(id, -32602, `Unknown tool "${params?.name}" (available: ${TOOL_NAME})`);
    if (session) session.calls += 1;
    const mapped = toJob(params.arguments ?? {});
    if (mapped.error) return rpcResult(id, toolResult(200, mapped.error));
    const { status, payload } = await execute({ ...mapped.job, source: 'mcp' });
    return rpcResult(id, toolResult(status, payload));
  }

  function initialize(id, params, tokenId) {
    const sid = randomUUID();
    const now = Date.now();
    const protocol = negotiateVersion(params?.protocolVersion);
    sessions.set(sid, {
      client: String(params?.clientInfo?.name ?? 'unknown').slice(0, 100),
      version: String(params?.clientInfo?.version ?? '').slice(0, 50),
      protocol,
      created: now,
      lastSeen: now,
      calls: 0,
      tokenId,
      resumed: false,
    });
    const reply = rpcResult(id, {
      protocolVersion: protocol,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS_LEAD + describe(),
    });
    return { sid, reply };
  }

  // One JSON-RPC message → reply object, or null (notification/response: no reply).
  async function dispatch(m, session) {
    // `jsonrpc: "2.0"` is not enforced: the previous gateway accepted bare
    // objects and hand-rolled clients rely on that.
    if (!isPlainObject(m)) return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC 2.0 object');
    if (typeof m.method !== 'string') return null; // a response to us (we never send requests) — ignore
    const isNotification = !('id' in m);
    if (isNotification) return null; // notifications/initialized, cancelled, … — nothing to answer
    const { id, method, params } = m;
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: [toolDefinition(describe())] });
    if (method === 'tools/call') return callTool(id, params, session);
    return rpcError(id, -32601, `Method not found: ${method}`);
  }

  async function handle(req, res, auth = { tokenId: null }) {
    const json = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
      return true;
    };
    const sid = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : null;

    if (req.method === 'DELETE') {
      if (sid) sessions.delete(sid);
      res.writeHead(200);
      res.end();
      return true;
    }
    if (req.method === 'GET') {
      // Server-initiated SSE streams are optional in Streamable HTTP; we are
      // request/response only.
      return json(405, rpcError(null, -32000, 'GET (SSE) not supported — POST JSON-RPC to /mcp'), { allow: 'POST, DELETE' });
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, DELETE' }).end();
      return true;
    }
    if (!isEnabled()) {
      return json(404, rpcError(null, -32601, 'MCP is disabled — enable it in the admin UI (/admin/mcp)'));
    }

    const { ok, text } = await readBody(req, maxBodyBytes);
    if (!ok) return true; // oversize/abort: socket already destroyed, nobody to answer
    const msg = parseJson(text);
    if (msg === undefined) return json(400, rpcError(null, -32700, 'Parse error: body is not valid JSON'));
    const batch = Array.isArray(msg) ? msg : [msg];
    if (!batch.length) return json(400, rpcError(null, -32600, 'Invalid Request: empty batch'));

    const replies = [];
    const headers = {};
    let session = null;
    const hasInitialize = batch.some((m) => m?.method === 'initialize');
    if (!hasInitialize) {
      const resolved = resolveSession(sid, auth.tokenId);
      if (resolved.reject) return json(404, rpcError(null, -32000, `Unknown session: ${resolved.reject}`));
      session = resolved.session;
      if (session) session.lastSeen = Date.now();
    }

    for (const m of batch) {
      if (m?.method === 'initialize' && 'id' in m) {
        const init = initialize(m.id, m.params, auth.tokenId);
        headers['mcp-session-id'] = init.sid;
        session = sessions.get(init.sid);
        replies.push(init.reply);
        continue;
      }
      const reply = await dispatch(m, session);
      if (reply) replies.push(reply);
    }

    if (!replies.length) {
      res.writeHead(202, headers);
      res.end();
      return true;
    }
    return json(200, Array.isArray(msg) ? replies : replies[0], headers);
  }

  return {
    handle,
    listSessions: () => [...sessions.entries()].map(([id, { tokenId, ...s }]) => ({ id, ...s })),
    dropSession: (id) => {
      revoked.set(id, Date.now());
      return sessions.delete(id);
    },
    close: () => clearInterval(sweep),
  };
}
