// INFRA — process-level surface: health, unknown routes, admin pages, body cap.
import assert from 'node:assert/strict';

export default [
  {
    id: 'INFRA-001', profile: 'main', title: 'GET /health 报告就绪池(main 池 2)',
    run: async (c) => {
      const r = await c.fetch('/health');
      assert.equal(r.status, 200);
      const h = await r.json();
      assert.equal(h.ok, true);
      assert.equal(h.live, 2, 'main profile boots pool.size=2');
      assert.equal(h.idle, 2);
      assert.equal(h.pending, 0);
      assert.equal(h.degraded, false);
    },
  },
  {
    id: 'INFRA-002', profile: 'main', title: '未知路径 → 404 not_found 信封',
    run: async (c) => {
      const r = await c.fetch('/nope');
      assert.equal(r.status, 404);
      const b = await r.json();
      assert.deepEqual(b, { ok: false, error: { type: 'not_found', retryable: false } });
    },
  },
  {
    id: 'INFRA-003', profile: 'main', title: 'GET /exec → 404(仅接受 POST)',
    run: async (c) => {
      const r = await c.fetch('/exec');
      assert.equal(r.status, 404);
      assert.equal((await r.json()).error.type, 'not_found');
    },
  },
  {
    id: 'INFRA-004', profile: 'main', title: '五个管理页 200 · text/html · no-store',
    run: async (c) => {
      for (const p of ['/admin', '/admin/logs', '/admin/api-doc', '/admin/mcp', '/admin/settings']) {
        const r = await c.fetch(p);
        assert.equal(r.status, 200, p);
        assert.match(r.headers.get('content-type') ?? '', /text\/html/);
        assert.equal(r.headers.get('cache-control'), 'no-store', p);
      }
    },
  },
  {
    id: 'INFRA-005', profile: 'main', title: '/admin/api/status 未认证不泄露用户名',
    run: async (c) => {
      const r = await c.fetch('/admin/api/status');
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.ok, true);
      assert.equal(b.admin, 'ready', 'main is bootstrapped');
      assert.equal(b.user, null, 'username must not leak unauthenticated');
      // with the session the username IS shown
      const authed = await c.admin('GET', '/admin/api/status');
      assert.equal(authed.body.user, 'ops');
    },
  },
  {
    id: 'INFRA-006', profile: 'tight', title: 'body 超 maxBodyBytes → 连接被断(fetch 拒绝)',
    run: async (c) => {
      const payload = JSON.stringify({ code: 'result = {"x": 1}', pad: 'x'.repeat(70_000) });
      assert.ok(payload.length > 65_536);
      await assert.rejects(
        () => c.fetch('/exec', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sbx-token': c.state.token },
          body: payload,
        }),
        undefined,
        'server destroys the socket instead of answering JSON',
      );
    },
  },
];
