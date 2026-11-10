// PERS — stop the main service and boot a fresh one on the SAME dbPath.
// Tokens, executions, events and settings must survive; in-memory sessions
// must not. (restart() re-logins via the harness and refreshes state.)
import assert from 'node:assert/strict';

export default [
  {
    id: 'PERS-001', profile: 'main',
    title: '重启同库:令牌仍有效 · 旧会话失效 · 执行/事件记录保留',
    run: async (c) => {
      await c.exec({ code: 'result = {"before": "restart"}' }); // leave a row behind
      const oldCookie = c.state.adminCookie;
      const oldBase = c.base;
      await c.restart();
      assert.notEqual(c.base, oldBase, 'restart binds a new port');
      // in-memory sessions died with the old instance
      assert.equal((await c.admin('GET', '/admin/api/tokens', undefined, { cookie: oldCookie })).status, 401);
      // harness re-login works against the stored account
      assert.equal((await c.admin('GET', '/admin/api/tokens')).status, 200);
      // the pre-restart token still authenticates /exec
      const r = await c.exec({ code: 'result = {"after": "restart"}' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      // execution history survived
      const logs = await c.admin('GET', '/admin/api/logs?limit=200');
      assert.ok(logs.body.rows.some((row) => row.code_preview.includes('before')));
      // events survived
      const m = (await c.admin('GET', '/admin/api/metrics')).body;
      assert.ok(m.events.length >= 1);
    },
  },
  {
    id: 'PERS-002', profile: 'main', title: '重启后令牌 id/启用状态保留',
    run: async (c) => {
      const list = await c.admin('GET', '/admin/api/tokens');
      const t = list.body.tokens.find((row) => row.id === c.state.tokenId);
      assert.ok(t, 'bootstrap token row survived the restart');
      assert.equal(t.name, 'regression');
      assert.equal(t.enabled, true);
    },
  },
];
