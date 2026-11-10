// AGENT — model-facing ergonomics on the default (general) preset: the code
// LLMs actually write must either work or fail with an actionable `hint`.
// Each case is a pattern observed to send models into retry loops before
// the fix (numpy scalars as placeholders, BytesIO read-once, banned print,
// missing builtins, hint-less policy errors).
import assert from 'node:assert/strict';

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');
const SALES = 'date,region,sales\n2026-01-01,east,10\n2026-01-02,west,20\n2026-01-03,east,30\n';
const files = [{ name: 'sales.csv', b64: b64(SALES) }];

export default [
  {
    id: 'AGENT-001', profile: 'main', title: 'numpy 标量 / Timestamp / Series / DataFrame 原生转 JSON',
    run: async (c) => {
      const r = await c.exec({
        files,
        code: [
          'df = pd.read_csv(files["sales.csv"], parse_dates=["date"])',
          'result = {',
          '  "total": df["sales"].sum(), "mean": df["sales"].mean(), "big": df["sales"].max() > 25,',
          '  "first": df["date"].min(), "by_region": df.groupby("region")["sales"].sum(),',
          '  "rows": df.head(2), "arr": np.arange(3), "missing": pd.NaT,',
          '}',
        ].join('\n'),
      });
      assert.equal(r.body.ok, true, JSON.stringify(r.body.error));
      assert.deepEqual(r.body.warnings, []);
      assert.deepEqual(r.body.result, {
        total: 60, mean: 20, big: true,
        first: '2026-01-01T00:00:00',
        by_region: { east: 40, west: 20 },
        rows: [
          { date: '2026-01-01T00:00:00', region: 'east', sales: 10 },
          { date: '2026-01-02T00:00:00', region: 'west', sales: 20 },
        ],
        arr: [0, 1, 2],
        missing: null,
      });
    },
  },
  {
    id: 'AGENT-002', profile: 'main', title: 'files[name] 每次取到新流:同一文件可读两次',
    run: async (c) => {
      const r = await c.exec({
        files,
        code: 'a = pd.read_csv(files["sales.csv"])\nb = pd.read_csv(files["sales.csv"])\nresult = {"a": len(a), "b": len(b)}',
      });
      assert.equal(r.body.ok, true, JSON.stringify(r.body.error));
      assert.deepEqual(r.body.result, { a: 3, b: 3 });
    },
  },
  {
    id: 'AGENT-003', profile: 'main', title: 'general 放开 print:输出进 stdout',
    run: async (c) => {
      const r = await c.exec({ code: 'print("rows", 3)\nresult = {"ok": True}' });
      assert.equal(r.body.ok, true, JSON.stringify(r.body.error));
      assert.equal(r.body.stdout, 'rows 3\n');
    },
  },
  {
    id: 'AGENT-004', profile: 'main', title: '扩充的安全内置可用(divmod/pow/chr/ord/RuntimeError)',
    run: async (c) => {
      const r = await c.exec({
        code: 'try:\n    raise RuntimeError("x")\nexcept RuntimeError:\n    caught = True\n'
          + 'result = {"d": divmod(7, 2), "p": pow(2, 5), "c": chr(ord("a") + 1), "caught": caught}',
      });
      assert.equal(r.body.ok, true, JSON.stringify(r.body.error));
      assert.deepEqual(r.body.result, { d: [3, 1], p: 32, c: 'b', caught: true });
    },
  },
  {
    id: 'AGENT-005', profile: 'main', title: '策略错误带 hint:import / 属性赋值 / 下划线名 / 语法错误',
    run: async (c) => {
      const imp = (await c.exec({ code: 'import math\nresult = {}' })).body.error;
      assert.equal(imp.code, 'forbidden_syntax');
      assert.match(imp.hint, /pd \(pandas\)/);
      assert.match(imp.hint, /np\.sqrt/, 'module-specific alternative for math');

      const store = (await c.exec({ code: 'df = pd.DataFrame({"a": [1]})\ndf.columns = ["b"]\nresult = {}' })).body.error;
      assert.equal(store.code, 'forbidden_store');
      assert.match(store.hint, /set_axis/);

      const under = (await c.exec({ code: '_tmp = 1\nresult = {}' })).body.error;
      assert.match(under.hint, /rename `_tmp`/);

      const syn = (await c.exec({ code: 'result = {"a": (1, 2}' })).body.error;
      assert.equal(syn.code, 'syntax_error', 'frozen code/message stay');
      assert.equal(syn.message, 'syntax_error');
      assert.match(syn.hint, /line 1, column \d+/);
    },
  },
  {
    id: 'AGENT-006', profile: 'main', title: '运行时错误带 hint:缺 result / 文件名错 / 路径读文件 / 未提供的模块',
    run: async (c) => {
      const none = (await c.exec({ code: 'x = 1' })).body.error;
      assert.equal(none.type, 'ValueError');
      assert.equal(none.code, 'result_must_be_dict');
      assert.match(none.hint, /top-level variable named `result`/);

      const wrongFile = (await c.exec({ files, code: 'df = pd.read_csv(files["data.csv"])\nresult = {}' })).body.error;
      assert.equal(wrongFile.type, 'KeyError');
      assert.match(wrongFile.hint, /available files: 'sales\.csv'/);

      const path = (await c.exec({ files, code: 'df = pd.read_csv("sales.csv")\nresult = {}' })).body.error;
      assert.match(path.hint, /`files` dict/);

      const mod = (await c.exec({ code: 'result = {"s": json.dumps({})}' })).body.error;
      assert.equal(mod.type, 'NameError');
      assert.match(mod.hint, /module `json` is not available/);
    },
  },
  {
    id: 'AGENT-007', profile: 'main', title: '超大 DataFrame result → 提前 result_too_large + 行数 hint',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"df": pd.DataFrame({"a": range(5000)})}' });
      assert.equal(r.body.ok, false);
      assert.match(r.body.error.message, /result_too_large/, 'frozen message');
      assert.match(r.body.error.hint, /5000 rows/);
    },
  },
];
