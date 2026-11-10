// EXEC — execution semantics. Envelope shape, error mapping, files, warnings,
// zero persistence. stdout truncation cases live on tight (tiny stdoutMaxChars).
import assert from 'node:assert/strict';

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

export default [
  {
    id: 'EXEC-001', profile: 'main', title: 'happy path 全信封 deepEqual',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"n": 6 * 7}' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true, result: { n: 42 }, warnings: [], stdout: '' });
    },
  },
  {
    id: 'EXEC-002', profile: 'main', title: 'result 缺失 → ValueError result_must_be_dict',
    run: async (c) => {
      const r = await c.exec({ code: 'x = 1' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.type, 'ValueError');
      assert.match(r.body.error.message, /result_must_be_dict/);
    },
  },
  {
    id: 'EXEC-003', profile: 'main', title: 'result 非 dict(general)→ ValueError',
    run: async (c) => {
      const r = await c.exec({ code: 'result = [1, 2, 3]' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.type, 'ValueError');
    },
  },
  {
    id: 'EXEC-004', profile: 'main', title: '运行时错误映射:ZeroDivisionError + line',
    run: async (c) => {
      const r = await c.exec({ code: 'x = 1\ny = x / 0\nresult = {}' });
      assert.equal(r.status, 200, 'sandbox-level errors stay HTTP 200');
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.type, 'ZeroDivisionError');
      assert.equal(r.body.error.line, 2);
      assert.equal(r.body.error.retryable, true);
    },
  },
  {
    id: 'EXEC-005', profile: 'main', title: '语法错误 → syntax_error + line',
    run: async (c) => {
      const r = await c.exec({ code: 'def f(:\n    pass' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.code, 'syntax_error');
      assert.equal(r.body.error.line, 1);
    },
  },
  {
    id: 'EXEC-006', profile: 'main', title: 'numpy 以 np 暴露(general)',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"s": int(np.arange(5).sum())}' });
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.result, { s: 10 });
    },
  },
  {
    id: 'EXEC-007', profile: 'main', title: '未暴露名 → NameError(而非 ImportError)',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"v": os.getcwd()}' });
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.type, 'NameError');
    },
  },
  {
    id: 'EXEC-008', profile: 'main', title: 'CSV 文件往返 read_csv',
    run: async (c) => {
      const r = await c.exec({
        code: 'df = pd.read_csv(files["demo.csv"])\nresult = {"rows": len(df), "total": int(df["a"].sum())}',
        files: [{ name: 'demo.csv', b64: b64('a,b\n1,2\n3,4\n') }],
      });
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.result, { rows: 2, total: 4 });
    },
  },
  {
    id: 'EXEC-009', profile: 'main', title: 'bytes 值 → b64 编码 + warning',
    run: async (c) => {
      const r = await c.exec({
        code: 'b = files["bin.dat"].read()\nresult = {"b": b, "n": len(b)}',
        files: [{ name: 'bin.dat', b64: Buffer.from([0, 1, 2]).toString('base64') }],
      });
      assert.equal(r.body.ok, true);
      assert.equal(r.body.result.n, 3);
      assert.equal(typeof r.body.result.b, 'string', 'bytes leaves as b64 text');
      assert.ok(r.body.warnings.some((w) => w.includes('bytes_value_b64')), String(r.body.warnings));
    },
  },
  {
    id: 'EXEC-010', profile: 'main', title: 'NaN → null + non_finite_value warning',
    run: async (c) => {
      const r = await c.exec({ code: 'v = float("nan")\nresult = {"v": v}' });
      assert.equal(r.body.ok, true);
      assert.equal(r.body.result.v, null);
      assert.ok(r.body.warnings.includes('non_finite_value'), String(r.body.warnings));
    },
  },
  {
    id: 'EXEC-011', profile: 'main', title: '嵌套超 24 层 → truncated 占位 + warning',
    run: async (c) => {
      const r = await c.exec({
        code: 'd = {}\ncur = d\nfor i in range(30):\n    cur["n"] = {}\n    cur = cur["n"]\ncur["leaf"] = 1\nresult = d',
      });
      assert.equal(r.body.ok, true);
      assert.ok(r.body.warnings.includes('result_nesting_too_deep'), String(r.body.warnings));
      assert.ok(JSON.stringify(r.body.result).includes('<truncated>'));
    },
  },
  {
    id: 'EXEC-012', profile: 'main', title: '不可序列化对象 → 占位 + unserializable warning',
    run: async (c) => {
      const r = await c.exec({ code: 'class Foo:\n    pass\nresult = {"o": Foo()}' });
      assert.equal(r.body.ok, true);
      assert.ok(r.body.warnings.some((w) => w.startsWith('unserializable')), String(r.body.warnings));
    },
  },
  {
    id: 'EXEC-013', profile: 'main', title: '零持久化:上一调用的变量在下一调用 NameError',
    run: async (c) => {
      const first = await c.exec({ code: 'marker = 123\nresult = {"set": True}' });
      assert.equal(first.body.ok, true);
      const second = await c.exec({ code: 'result = {"v": marker}' });
      assert.equal(second.body.ok, false);
      assert.equal(second.body.error.type, 'NameError');
    },
  },
  {
    id: 'EXEC-020', profile: 'tight', title: 'result 超 resultMaxBytes → ValueError result_too_large(带 code)',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"x": "A" * 100000}' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.type, 'ValueError');
      assert.equal(r.body.error.code, 'result_too_large', 'code distinguishes size failures from generic ValueErrors');
      assert.match(r.body.error.message, /result_too_large/);
    },
  },
  {
    id: 'EXEC-021', profile: 'tight', title: 'stdout 捕获:print 输出进 stdout 字段',
    run: async (c) => {
      const r = await c.exec({ code: 'print("hello")\nresult = {"n": 1}' });
      assert.equal(r.body.ok, true);
      assert.equal(r.body.stdout, 'hello\n');
      assert.deepEqual(r.body.warnings, []);
    },
  },
  {
    id: 'EXEC-022', profile: 'tight', title: 'stdout 截断:超 stdoutMaxChars → 截断 + warning',
    run: async (c) => {
      const r = await c.exec({ code: 'print("x" * 200)\nresult = {}' });
      assert.equal(r.body.ok, true);
      assert.equal(r.body.stdout.length, 64, 'capped at stdoutMaxChars=64');
      assert.ok(r.body.warnings.includes('stdout_truncated'), String(r.body.warnings));
    },
  },
  {
    id: 'EXEC-023', profile: 'tight', title: '组合:文件 + stdout + result 同请求',
    run: async (c) => {
      const r = await c.exec({
        code: 'print(files["d.csv"].read().decode().strip())\nresult = {"n": len(files)}',
        files: [{ name: 'd.csv', b64: b64('v\n1\n2\n') }],
      });
      assert.equal(r.body.ok, true);
      assert.equal(r.body.stdout, 'v\n1\n2\n');
      assert.deepEqual(r.body.result, { n: 1 });
    },
  },
];
