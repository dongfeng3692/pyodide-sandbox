// MCP — Streamable HTTP gateway (mcp profile). Migrated from the retired
// server.test.mjs so the original coverage is not lost; the /mcp protocol
// surface is exercised only here, not in the other groups.
import assert from 'node:assert/strict';

const rpc = (c, body, extra = {}) => c.fetch('/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${c.state.token}`, ...extra },
  body: JSON.stringify(body),
});

export default [
  {
    id: 'MCP-001', profile: 'mcp', title: '默认关闭 → initialize 404(即使鉴权有效)',
    run: async (c) => {
      const r = await rpc(c, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      assert.equal(r.status, 404);
    },
  },
  {
    id: 'MCP-002', profile: 'mcp', title: '开启后未鉴权 → 401',
    run: async (c) => {
      const on = await c.admin('POST', '/admin/api/mcp', { enabled: true });
      assert.equal(on.body.enabled, true);
      const r = await c.fetch('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      assert.equal(r.status, 401);
    },
  },
  {
    id: 'MCP-003', profile: 'mcp', title: 'initialize → 200 + Mcp-Session-Id + serverInfo',
    run: async (c) => {
      const r = await rpc(c, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', clientInfo: { name: 'e2e-client', version: '1.0' } },
      });
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.result.serverInfo.name, 'pyodide-sandbox');
      assert.equal(b.result.protocolVersion, '2025-06-18');
      c.state.sid = r.headers.get('mcp-session-id');
      assert.ok(c.state.sid, 'session id header returned');
    },
  },
  {
    id: 'MCP-004', profile: 'mcp', title: 'tools/list + tools/call 成功路径',
    run: async (c) => {
      const list = await rpc(c, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': c.state.sid });
      const lb = await list.json();
      assert.equal(lb.result.tools[0].name, 'execute_code');
      const call = await rpc(c, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'execute_code', arguments: { code: 'result = {"n": 6*7}' } },
      }, { 'mcp-session-id': c.state.sid });
      const cb = await call.json();
      assert.equal(cb.result.isError, false);
      assert.deepEqual(JSON.parse(cb.result.content[0].text).result, { n: 42 });
    },
  },
  {
    id: 'MCP-005', profile: 'mcp', title: '策略违规 → 工具级 isError(非传输错误)',
    run: async (c) => {
      const r = await rpc(c, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'execute_code', arguments: { code: 'import os\nresult = {}' } },
      }, { 'mcp-session-id': c.state.sid });
      const b = await r.json();
      assert.equal(b.result.isError, true);
      assert.equal(JSON.parse(b.result.content[0].text).error.type, 'PolicyError');
    },
  },
  {
    id: 'MCP-006', profile: 'mcp', title: 'admin 可见会话;断开后该 sid 报 -32000',
    run: async (c) => {
      const view = await c.admin('GET', '/admin/api/mcp');
      const sess = view.body.sessions.find((s) => s.id === c.state.sid);
      assert.equal(sess.client, 'e2e-client');
      assert.ok(sess.calls >= 2);
      const drop = await c.admin('DELETE', `/admin/api/mcp/sessions/${c.state.sid}`);
      assert.equal(drop.body.ok, true);
      const gone = await rpc(c, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { 'mcp-session-id': c.state.sid });
      assert.equal(gone.status, 404, 'revoked session → 404 so clients re-initialize');
      assert.equal((await gone.json()).error.code, -32000);
    },
  },
  {
    id: 'MCP-008', profile: 'mcp', title: '无 session header → 无状态服务(不再报 Unknown session)',
    run: async (c) => {
      const r = await rpc(c, { jsonrpc: '2.0', id: 10, method: 'tools/list' });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).result.tools[0].name, 'execute_code');
    },
  },
  {
    id: 'MCP-009', profile: 'mcp', title: '未知/过期 sid(如服务重启后)→ 透明续接,调用成功',
    run: async (c) => {
      const r = await rpc(c, {
        jsonrpc: '2.0', id: 11, method: 'tools/call',
        params: { name: 'execute_code', arguments: { code: 'result = {"v": 1}' } },
      }, { 'mcp-session-id': '0b6f7f4e-0000-4000-8000-000000000001' });
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.result.isError, false);
      const view = await c.admin('GET', '/admin/api/mcp');
      const s = view.body.sessions.find((x) => x.id === '0b6f7f4e-0000-4000-8000-000000000001');
      assert.equal(s.resumed, true);
      assert.ok(!('tokenId' in s), 'token ids are not exposed');
    },
  },
  {
    id: 'MCP-010', profile: 'mcp', title: 'sid 换令牌使用 → 404',
    run: async (c) => {
      const init = await rpc(c, { jsonrpc: '2.0', id: 12, method: 'initialize', params: {} });
      const sid = init.headers.get('mcp-session-id');
      const other = await c.admin('POST', '/admin/api/tokens', { name: 'mcp-other' });
      const r = await rpc(c, { jsonrpc: '2.0', id: 13, method: 'tools/list' }, {
        'mcp-session-id': sid, authorization: `Bearer ${other.body.token}`,
      });
      assert.equal(r.status, 404);
    },
  },
  {
    id: 'MCP-011', profile: 'mcp', title: 'ping → 空 result;仅通知 → 202;空批 → 400;批量 → 数组',
    run: async (c) => {
      const ping = await (await rpc(c, { jsonrpc: '2.0', id: 14, method: 'ping' })).json();
      assert.deepEqual(ping.result, {});
      const note = await rpc(c, { jsonrpc: '2.0', method: 'notifications/initialized' });
      assert.equal(note.status, 202);
      const empty = await rpc(c, []);
      assert.equal(empty.status, 400);
      const batch = await (await rpc(c, [
        { jsonrpc: '2.0', id: 15, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/cancelled' },
        { jsonrpc: '2.0', id: 16, method: 'nope' },
      ])).json();
      assert.ok(Array.isArray(batch));
      assert.deepEqual(batch.map((x) => x.id), [15, 16]);
      assert.equal(batch[1].error.code, -32601);
    },
  },
  {
    id: 'MCP-012', profile: 'mcp', title: '版本协商:支持的版本原样回显,未知版本回最新',
    run: async (c) => {
      const old = await (await rpc(c, { jsonrpc: '2.0', id: 17, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json();
      assert.equal(old.result.protocolVersion, '2025-03-26');
      const future = await (await rpc(c, { jsonrpc: '2.0', id: 18, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).json();
      assert.equal(future.result.protocolVersion, '2025-06-18');
    },
  },
  {
    id: 'MCP-013', profile: 'mcp', title: 'initialize instructions + 工具描述由生效策略生成(含版本/限制/规则)',
    run: async (c) => {
      const init = await (await rpc(c, { jsonrpc: '2.0', id: 19, method: 'initialize', params: {} })).json();
      const instr = init.result.instructions;
      assert.match(instr, /preset "general"/);
      assert.match(instr, /`pd` = pandas \d/, 'module versions come from the live runtime');
      assert.match(instr, /Timeout 25s/, 'default stays under the ~30s MCP client timeout');
      const tool = (await (await rpc(c, { jsonrpc: '2.0', id: 20, method: 'tools/list' })).json()).result.tools[0];
      for (const needle of [/do NOT write import/, /files\["data\.csv"\]/, /Stateless/, /df\.columns = \[\.\.\.\]/, /print\(\) output/]) {
        assert.match(tool.description, needle);
      }
      assert.doesNotMatch(tool.description, /assignments are forbidden/, 'the old misleading claim is gone');
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.outputSchema.required[0], 'ok');
      assert.ok(tool.inputSchema.properties.files.items.properties.text, 'text files accepted');
    },
  },
  {
    id: 'MCP-014', profile: 'mcp', title: 'tools/call:text 文件 + structuredContent 与 text 一致',
    run: async (c) => {
      const b = await (await rpc(c, {
        jsonrpc: '2.0', id: 21, method: 'tools/call',
        params: {
          name: 'execute_code',
          arguments: {
            code: 'df = pd.read_csv(files["s.csv"])\nprint(len(df))\nresult = {"total": df["v"].sum()}',
            files: [{ name: 's.csv', text: 'v\n1\n2\n3\n' }],
          },
        },
      })).json();
      assert.equal(b.result.isError, false);
      assert.deepEqual(b.result.structuredContent.result, { total: 6 });
      assert.equal(b.result.structuredContent.stdout, '3\n');
      assert.deepEqual(JSON.parse(b.result.content[0].text), b.result.structuredContent);
    },
  },
  {
    id: 'MCP-015', profile: 'mcp', title: '代码级错误:带 hint、去掉 retryable(避免模型原样重发)',
    run: async (c) => {
      const b = await (await rpc(c, {
        jsonrpc: '2.0', id: 22, method: 'tools/call',
        params: { name: 'execute_code', arguments: { code: 'import json\nresult = {}' } },
      })).json();
      assert.equal(b.result.isError, true);
      const err = b.result.structuredContent.error;
      assert.equal(err.code, 'forbidden_syntax');
      assert.match(err.hint, /pre-bound globals/);
      assert.ok(!('retryable' in err));
    },
  },
  {
    id: 'MCP-016', profile: 'mcp', title: '非法 files 参数 → 工具级 invalid_arguments(isError,非 500)',
    run: async (c) => {
      for (const files of [[null], [{ name: 'a.csv' }], [{ name: 'a.csv', text: 'x', b64: 'eA==' }], 'a.csv']) {
        const r = await rpc(c, {
          jsonrpc: '2.0', id: 23, method: 'tools/call',
          params: { name: 'execute_code', arguments: { code: 'result = {}', files } },
        });
        assert.equal(r.status, 200, JSON.stringify(files));
        const b = await r.json();
        assert.equal(b.result.isError, true);
        assert.equal(b.result.structuredContent.error.type, 'invalid_arguments');
        assert.ok(b.result.structuredContent.error.hint);
      }
    },
  },
  {
    id: 'MCP-017', profile: 'mcp', title: '非法 JSON → 400 -32700;未知工具 → -32602',
    run: async (c) => {
      const bad = await c.fetch('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.state.token}` },
        body: '{"jsonrpc":',
      });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error.code, -32700);
      const unknown = await (await rpc(c, { jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'rm_rf' } })).json();
      assert.equal(unknown.error.code, -32602);
    },
  },
  {
    id: 'MCP-007', profile: 'mcp', title: '再关闭 → 404;mcpCalls 计入 metrics',
    run: async (c) => {
      await c.admin('POST', '/admin/api/mcp', { enabled: false });
      assert.equal((await rpc(c, { jsonrpc: '2.0', id: 6, method: 'tools/list' })).status, 404);
      const m = (await c.admin('GET', '/admin/api/metrics?window=600')).body;
      assert.ok(m.mcpCalls >= 2, 'source=mcp executions counted');
    },
  },
];
