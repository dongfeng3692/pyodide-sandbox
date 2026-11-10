// VAL — request validation on the tight profile (raw preset, tiny limits:
// maxCodeBytes 1000, files.maxCount 2, files.maxBytesPerFile 64).
import assert from 'node:assert/strict';

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

export default [
  {
    id: 'VAL-001', profile: 'tight', title: '非法 JSON 体 → 422 invalid_json 且落库真实类型行(D12)',
    run: async (c) => {
      const r = await c.fetch('/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sbx-token': c.state.token },
        body: '{"code": "result = {"',
      });
      assert.equal(r.status, 422);
      assert.equal((await r.json()).error.type, 'invalid_json');
      const logs = await c.admin('GET', '/admin/api/logs?filter=failed');
      // D12: pre-check rejections record their real type (was blanket 'validation')
      assert.ok(logs.body.rows.some((row) => row.error_type === 'invalid_json'), 'invalid_json row recorded');
      assert.ok(logs.body.rows.some((row) => row.error_type === 'invalid_json' && row.fail_class === 'blocked'),
        'classifies as blocked');
    },
  },
  {
    id: 'VAL-002', profile: 'tight', title: 'code 缺失/非串 → 422 invalid_code',
    run: async (c) => {
      for (const body of [{}, { code: null }, { code: 42 }]) {
        const r = await c.exec(body);
        assert.equal(r.status, 422, JSON.stringify(body));
        assert.equal(r.body.error.type, 'invalid_code');
      }
    },
  },
  {
    id: 'VAL-003', profile: 'tight', title: 'code 纯空白 → 422 invalid_code',
    run: async (c) => {
      const r = await c.exec({ code: '   \n\t  ' });
      assert.equal(r.status, 422);
      assert.equal(r.body.error.type, 'invalid_code');
    },
  },
  {
    id: 'VAL-004', profile: 'tight', title: 'code 超 maxCodeBytes → policy 层 code_too_large(HTTP 200)',
    run: async (c) => {
      const r = await c.exec({ code: `# ${'a'.repeat(1100)}\nresult = {}` });
      assert.equal(r.status, 200, 'size check lives in the policy engine, not the route');
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.code, 'code_too_large');
    },
  },
  {
    id: 'VAL-005', profile: 'tight', title: 'files 非数组 → 按 [] 处理',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"n": len(files)}', files: 'not-an-array' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.result, { n: 0 });
    },
  },
  {
    id: 'VAL-006', profile: 'tight', title: '文件数 > maxCount → 422 too_many_files',
    run: async (c) => {
      const files = [1, 2, 3].map((i) => ({ name: `f${i}.csv`, b64: b64(`${i}\n`) }));
      const r = await c.exec({ code: 'result = {}', files });
      assert.equal(r.status, 422);
      assert.equal(r.body.error.type, 'too_many_files');
    },
  },
  {
    id: 'VAL-007', profile: 'tight', title: '单文件解码后 > maxBytesPerFile → 422 file_too_large',
    run: async (c) => {
      const r = await c.exec({
        code: 'result = {}',
        files: [{ name: 'big.bin', b64: Buffer.from('z'.repeat(100)).toString('base64') }],
      });
      assert.equal(r.status, 422);
      assert.equal(r.body.error.type, 'file_too_large');
    },
  },
  {
    id: 'VAL-008', profile: 'tight', title: '非法 b64 不被 422(宽松解码,行为冻结)',
    run: async (c) => {
      const r = await c.exec({
        code: 'result = {"seen": sorted(files.keys())}',
        files: [{ name: 'weird.bin', b64: '!!!not-base64!!!' }],
      });
      assert.equal(r.status, 200, 'b64 is decoded leniently, never 422');
      assert.deepEqual(r.body.result, { seen: ['weird.bin'] });
    },
  },
  {
    id: 'VAL-009', profile: 'tight', title: '文件名路径穿越被净化为 basename',
    run: async (c) => {
      const r = await c.exec({
        code: 'result = {"seen": sorted(files.keys())}',
        files: [{ name: '../../evil.txt', b64: b64('x') }],
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.result, { seen: ['evil.txt'] }, 'path components stripped');
    },
  },
  {
    id: 'VAL-010', profile: 'tight', title: '空文件数组 + 有效 code → 正常执行',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"ok": True}', files: [] });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.result, { ok: true });
    },
  },
  {
    id: 'VAL-011', profile: 'tight', title: '重名文件 → 后写覆盖先写',
    run: async (c) => {
      const r = await c.exec({
        code: 'result = {"v": files["a.csv"].read().decode()}',
        files: [
          { name: 'a.csv', b64: b64('a,1\n') },
          { name: 'a.csv', b64: b64('b,2\n') },
        ],
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.result, { v: 'b,2\n' });
    },
  },
  {
    id: 'VAL-012', profile: 'tight', title: 'JSON 体非对象(null/数组/串/数)→ 422 invalid_json,服务存活',
    run: async (c) => {
      // regression: a bare `null` body used to crash the whole process
      for (const raw of ['null', '[]', '"code"', '42']) {
        const r = await c.fetch('/exec', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sbx-token': c.state.token },
          body: raw,
        });
        assert.equal(r.status, 422, raw);
        const b = await r.json();
        assert.equal(b.error.type, 'invalid_json', raw);
        assert.match(b.error.message, /JSON object/, raw);
      }
      const health = await c.fetch('/health');
      assert.equal(health.status, 200, 'server still alive');
    },
  },
  {
    id: 'VAL-013', profile: 'tight', title: 'files 含非对象项 → 422 invalid_files(不崩溃)',
    run: async (c) => {
      for (const files of [[null], [1], ['a.csv']]) {
        const r = await c.exec({ code: 'result = {}', files });
        assert.equal(r.status, 422, JSON.stringify(files));
        assert.equal(r.body.error.type, 'invalid_files');
        assert.match(r.body.error.message, /files\[0\]/);
      }
      assert.equal((await c.fetch('/health')).status, 200);
    },
  },
  {
    id: 'VAL-014', profile: 'tight', title: '422 预检错误带可读 message(limits 写明)',
    run: async (c) => {
      const tooMany = await c.exec({ code: 'result = {}', files: [1, 2, 3].map((i) => ({ name: `f${i}`, b64: b64('x') })) });
      assert.match(tooMany.body.error.message, /at most 2 files/);
      const big = await c.exec({ code: 'result = {}', files: [{ name: 'big.bin', b64: b64('z'.repeat(100)) }] });
      assert.match(big.body.error.message, /big\.bin is 100 bytes.*64 bytes/);
      const empty = await c.exec({ code: '' });
      assert.match(empty.body.error.message, /non-empty string/);
    },
  },
];
