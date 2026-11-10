// LIM — resource limits on tight (size 1, execTimeoutMs 1500, maxQueue 1,
// recycleAfter 2, maxBodyBytes 64KB, files 2/64B, maxCodeBytes 1000).
// Boundary cases freeze the "strictly greater" semantics of each cap.
import assert from 'node:assert/strict';

// The queue test must fit TWO runs of the job inside execTimeoutMs: the
// timeout clock starts at submit, so the queued job pays the first job's
// runtime too (0.5s + 0.5s < 1.5s with wide margin).
const SLOW = 'import time\ntime.sleep(0.5)\nresult = {}';
const QUICK = 'result = {"ok": True}';

export default [
  {
    id: 'LIM-001', profile: 'tight', title: '并发 3 任务(池 1 + maxQueue 1)→ 第 3 个 429 queue_full',
    run: async (c) => {
      // warm the single worker first — a fresh boot would eat the wall-clock budget
      assert.equal((await c.exec({ code: QUICK })).body.ok, true);
      const rs = await Promise.all([1, 2, 3].map(() => c.exec({ code: SLOW })));
      const byStatus = {};
      for (const r of rs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      assert.equal(byStatus[200], 2, 'worker + 1 queued both complete');
      assert.equal(byStatus[429], 1, 'third request overflows the queue');
      const rejected = rs.find((r) => r.status === 429);
      assert.equal(rejected.body.error.type, 'queue_full');
      assert.equal(rejected.body.error.retryable, true);
    },
  },
  {
    id: 'LIM-002', profile: 'tight', title: '慢任务超 execTimeoutMs → 408 execution_timeout',
    run: async (c) => {
      const r = await c.exec({ code: 'import time\ntime.sleep(5)\nresult = {}' });
      assert.equal(r.status, 408);
      assert.equal(r.body.error.type, 'execution_timeout');
      assert.equal(r.body.error.retryable, false);
    },
  },
  {
    id: 'LIM-003', profile: 'tight', title: '超时后池自愈:替补 worker 继续服务',
    run: async (c) => {
      await c.pool.waitReady();
      const r = await c.exec({ code: QUICK });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    },
  },
  {
    id: 'LIM-004', profile: 'recycle', title: 'recycleAfter=2:两次调用后 worker 被换新',
    run: async (c) => {
      const m0 = await c.admin('GET', '/admin/api/metrics');
      const before = new Set(m0.body.pool.workers.map((w) => w.id));
      assert.equal((await c.exec({ code: QUICK })).body.ok, true);
      assert.equal((await c.exec({ code: QUICK })).body.ok, true);
      // retire + respawn is asynchronous — poll until a fresh worker id appears
      let after = null;
      for (let i = 0; i < 40; i++) {
        await c.sleep(500);
        const m = await c.admin('GET', '/admin/api/metrics');
        after = new Set(m.body.pool.workers.map((w) => w.id));
        if ([...after].some((id) => !before.has(id))) break;
      }
      assert.ok(after && [...after].some((id) => !before.has(id)), 'worker recycled after recycleAfter calls');
      assert.equal((await c.exec({ code: QUICK })).status, 200, 'recycled pool still serves');
    },
  },
  {
    id: 'LIM-005', profile: 'tight', title: '边界:恰好 maxCount=2 个文件通过',
    run: async (c) => {
      const r = await c.exec({
        code: 'result = {"n": len(files)}',
        files: [
          { name: 'a.csv', b64: Buffer.from('1\n', 'utf-8').toString('base64') },
          { name: 'b.csv', b64: Buffer.from('2\n', 'utf-8').toString('base64') },
        ],
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.result, { n: 2 });
    },
  },
  {
    id: 'LIM-006', profile: 'tight', title: '边界:恰好 64B 文件通过(上限为严格大于)',
    run: async (c) => {
      const r = await c.exec({
        code: 'result = {"n": len(files["f.bin"].read())}',
        files: [{ name: 'f.bin', b64: Buffer.from('z'.repeat(64)).toString('base64') }],
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.result, { n: 64 });
    },
  },
  {
    id: 'LIM-007', profile: 'tight', title: '边界:恰好 maxCodeBytes=1000 的 code 通过',
    run: async (c) => {
      const code = `result = {}\n#${'a'.repeat(987)}`;
      assert.equal(Buffer.byteLength(code, 'utf-8'), 1000, 'case builds exactly 1000 bytes');
      const r = await c.exec({ code });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    },
  },
  {
    id: 'LIM-008', profile: 'tight', title: '池/主机遥测:workers 与 host 快照字段可用',
    run: async (c) => {
      // LIM-004's recycle can leave the workers array briefly empty while the
      // replacement boots — poll for a live view instead of grabbing [0].
      let w = null;
      for (let i = 0; i < 40 && !w; i++) {
        const m = await c.admin('GET', '/admin/api/metrics');
        w = m.body.pool.workers.find((x) => x.state !== 'stopping') ?? null;
        if (!w) await c.sleep(500);
      }
      assert.ok(w, 'a live worker reported');
      assert.ok(w.id >= 1, 'worker id (threadId) present');
      assert.equal(typeof w.state, 'string');
      assert.ok(w.rssMb > 0, 'worker RSS reported');
      const m = await c.admin('GET', '/admin/api/metrics');
      assert.equal(m.body.host.pid, process.pid, 'host snapshot is this process');
      assert.ok(m.body.host.rssMb > 0);
    },
  },
];
