// ADM — admin API. Cases that depend on stored traffic SELF-SEED their rows
// so `--filter ADM` works standalone (profiles may have no history without
// the EXEC/POL/LIM groups having run).
import assert from 'node:assert/strict';

export default [
  {
    id: 'ADM-001', profile: 'main', title: '/admin/api/config 形状冻结(默认档)',
    run: async (c) => {
      const r = await c.admin('GET', '/admin/api/config');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        ok: true,
        preset: 'general',
        // rssLimitMb reflects the harness override (2048, see harness.mjs);
        // everything else is the documented default. execTimeoutMs stays
        // below the ~30s MCP client timeout (see config.mjs).
        pool: { size: 2, execTimeoutMs: 25_000, maxQueue: 32, recycleAfter: 50, rssLimitMb: 2048 },
        files: { maxCount: 5, maxBytesPerFile: 26_214_400 },
        output: { resultMaxBytes: 24_576, stdoutMode: 'capture', stdoutMaxChars: 4096 },
        policy: { maxCodeBytes: 24_000 },
        packages: { active: [], restartRequired: false }, // main profile: no manifest
        mcp: { enabled: false },
        allowNoToken: false,
      });
    },
  },
  {
    id: 'ADM-002', profile: 'main', title: 'metrics 口径:total=ok+fail · failClasses 分类 · errors 榜(带码) · buckets · events',
    run: async (c) => {
      // self-seed: one success + one policy failure + one runtime failure
      await c.exec({ code: 'result = {"seed": 1}' });
      await c.exec({ code: 'import os\nresult = {}' });
      await c.exec({ code: 'x = 1 / 0\nresult = {}' });
      const m = (await c.admin('GET', '/admin/api/metrics?window=600')).body;
      assert.ok(m.ok);
      assert.ok(m.total >= 3);
      assert.equal(m.okCount + m.failCount, m.total, 'counts add up');
      assert.ok(m.errors.some((e) => e.type === 'PolicyError' && e.n >= 1));
      assert.ok(Array.isArray(m.buckets) && m.buckets.length >= 1);
      assert.ok('avg_ms' in m.buckets[0], 'buckets carry avg latency');
      assert.ok(Array.isArray(m.events) && m.events.length >= 1, 'event feed always populated');
      assert.equal(typeof m.successRate, 'number');
      assert.equal(m.mcpCalls, 0, 'no MCP traffic on main');
      // D12: failures split into blocked / model / system, derived at read time
      assert.ok(m.failClasses, 'failClasses present');
      assert.ok(m.failClasses.blocked >= 1, 'policy seed counted as blocked');
      assert.ok(m.failClasses.model >= 1, 'ZeroDivision seed counted as model');
      assert.equal(m.failClasses.blocked + m.failClasses.model + m.failClasses.system, m.failCount,
        'classes partition every failure');
      assert.equal(typeof m.successRateExBlocked, 'number');
      assert.ok(m.successRateExBlocked >= m.successRate, 'excluding blocks can only raise the rate');
      // errors leaderboard: type+code grouping, each row carries its class.
      // Shape-only asserts — the leaderboard is a top-N slice and earlier
      // cases seed more than N groups, so specific rows are not guaranteed.
      assert.ok(m.errors.every((e) => 'cls' in e && 'code' in e), 'leaderboard rows carry code + cls');
      assert.ok(m.errors.every((e) => ['blocked', 'model', 'system'].includes(e.cls)));
    },
  },
  {
    id: 'ADM-003', profile: 'tight', title: 'metrics:超时计数累积(自播种一次超时)',
    run: async (c) => {
      await c.exec({ code: 'import time\ntime.sleep(5)\nresult = {}' });
      const m = (await c.admin('GET', '/admin/api/metrics?window=600')).body;
      assert.ok(m.timeouts >= 1, 'timeout recorded');
    },
  },
  {
    id: 'ADM-004', profile: 'main', title: 'logs filters(含 D12 分类) + q 搜索(code/error 命中) + 行级 fail_class',
    run: async (c) => {
      // self-seed: success / policy failure / runtime failure / validation rejection
      await c.exec({ code: 'result = {"seed": "adm4"}' });
      await c.exec({ code: 'import os\nresult = {}' });
      await c.exec({ code: 'x = 1 / 0' });
      const sixFiles = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, text: 'x' }));
      await c.exec({ code: 'result = {}', files: sixFiles }); // → 422 too_many_files
      const all = await c.admin('GET', '/admin/api/logs?filter=all');
      assert.ok(all.body.total >= 4);
      assert.ok(all.body.rows.every((row) => 'fail_class' in row), 'rows carry fail_class');
      assert.ok(all.body.rows.some((row) => row.fail_class === null), 'successes classify as null');
      const failed = await c.admin('GET', '/admin/api/logs?filter=failed');
      assert.ok(failed.body.total >= 3);
      assert.ok(failed.body.rows.every((row) => row.ok === 0));
      const policy = await c.admin('GET', '/admin/api/logs?filter=policy');
      assert.ok(policy.body.total >= 1);
      assert.ok(policy.body.rows.every((row) => row.error_type === 'PolicyError'));
      // D12 class filters: blocked ⊃ policy + validation, model = ran & failed
      const blocked = await c.admin('GET', '/admin/api/logs?filter=blocked');
      assert.ok(blocked.body.total >= 2, 'policy + too_many_files seeds');
      assert.ok(blocked.body.rows.every((row) => row.fail_class === 'blocked'));
      assert.ok(blocked.body.rows.some((row) => row.error_type === 'too_many_files'),
        'pre-check rejections record their real type now');
      const model = await c.admin('GET', '/admin/api/logs?filter=model');
      assert.ok(model.body.total >= 1);
      assert.ok(model.body.rows.every((row) => row.fail_class === 'model'));
      assert.ok(model.body.rows.some((row) => row.error_type === 'ZeroDivisionError'));
      const system = await c.admin('GET', '/admin/api/logs?filter=system');
      assert.equal(system.body.total, 0, 'main profile never hits infrastructure failures');
      const timeout = await c.admin('GET', '/admin/api/logs?filter=timeout');
      assert.equal(timeout.body.total, 0, 'main profile never times out (frozen expectation)');
      // q over code text, scoped by filter
      const byCode = await c.admin('GET', `/admin/api/logs?filter=policy&q=${encodeURIComponent('import os')}`);
      assert.ok(byCode.body.total >= 1);
      assert.match(byCode.body.rows[0].code_preview, /import os/);
      // q over error_type
      const byType = await c.admin('GET', '/admin/api/logs?filter=failed&q=ZeroDivisionError');
      assert.ok(byType.body.total >= 1);
    },
  },
  {
    id: 'ADM-005', profile: 'main', title: 'logs 分页:limit/offset · 倒序',
    run: async (c) => {
      for (let i = 0; i < 5; i++) await c.exec({ code: `result = {"i": ${i}}` });
      const p1 = await c.admin('GET', '/admin/api/logs?limit=2&offset=0');
      const p2 = await c.admin('GET', '/admin/api/logs?limit=2&offset=2');
      assert.equal(p1.body.rows.length, 2);
      assert.equal(p2.body.rows.length, 2);
      assert.ok(p1.body.total >= 5);
      assert.ok(p1.body.rows[0].id > p1.body.rows[1].id, 'newest first');
      assert.ok(p2.body.rows.every((r2) => !p1.body.rows.some((r1) => r1.id === r2.id)), 'no overlap');
    },
  },
  {
    id: 'ADM-006', profile: 'main', title: 'executionDetail:全量 code + stdout_preview;未知 id 404',
    run: async (c) => {
      await c.exec({ code: 'import os\nresult = {}' }); // self-seed
      const list = await c.admin('GET', '/admin/api/logs?filter=policy&limit=1');
      const id = list.body.rows[0].id;
      const d = await c.admin('GET', `/admin/api/logs/${id}`);
      assert.equal(d.status, 200);
      assert.ok(d.body.code.includes('import os'), 'detail carries the full code');
      assert.ok('stdout_preview' in d.body);
      assert.equal((await c.admin('GET', '/admin/api/logs/999999')).status, 404);
    },
  },
  {
    id: 'ADM-007', profile: 'main', title: '未知 /admin/api 路由 → 404',
    run: async (c) => {
      const r = await c.admin('GET', '/admin/api/nope');
      assert.equal(r.status, 404);
      assert.equal(r.body.error.type, 'not_found');
    },
  },
  {
    id: 'ADM-008', profile: 'main', title: 'MCP 开关:默认关 · 切换持久 · 非法体 422 · 事件留痕',
    run: async (c) => {
      const before = await c.admin('GET', '/admin/api/mcp');
      assert.equal(before.body.enabled, false);
      assert.deepEqual(before.body.sessions, []);
      const on = await c.admin('POST', '/admin/api/mcp', { enabled: true });
      assert.equal(on.status, 200);
      assert.equal(on.body.enabled, true);
      assert.equal((await c.admin('GET', '/admin/api/mcp')).body.enabled, true);
      const off = await c.admin('POST', '/admin/api/mcp', { enabled: false });
      assert.equal(off.body.enabled, false);
      const bad = await c.admin('POST', '/admin/api/mcp', { enabled: 1 });
      assert.equal(bad.status, 422);
      assert.equal(bad.body.error.type, 'invalid_body');
      const m = (await c.admin('GET', '/admin/api/metrics')).body;
      assert.ok(m.events.some((e) => e.kind === 'mcp_enabled'), 'toggle recorded as event');
    },
  },
  {
    id: 'ADM-009', profile: 'tight', title: '资源采样:points 累积且带 rssMb/live',
    run: async (c) => {
      await c.sleep(1300); // sampleIntervalMs=1000 (service clamps to >=1000)
      const s = await c.admin('GET', '/admin/api/samples?window=600');
      assert.equal(s.status, 200);
      assert.ok(s.body.points.length >= 1, 'sampler ticked');
      assert.ok(s.body.points[0].rssMb > 0);
      assert.ok(s.body.points[0].live >= 1);
      assert.ok(Number.isFinite(s.body.points[0].cpu));
    },
  },
];
