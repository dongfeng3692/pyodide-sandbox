// SEC — security regressions. These IDs are the ones to watch in CI: if one
// flips, an isolation layer regressed. Payloads migrate the original e2e
// chain from the retired server.test.mjs.
import assert from 'node:assert/strict';

export default [
  {
    id: 'SEC-001', profile: 'main',
    title: '桥逃逸链:meta_path.pop(0) + importlib 导入 js 被拦',
    run: async (c) => {
      const r = await c.exec({
        code: 's = pd.compat.sys\ns.meta_path.pop(0)\nj = s.modules["importlib"].import_module("js")\nresult = {"ua": str(j.navigator.userAgent)}',
      });
      assert.equal(r.body.ok, false, 'the classic escape chain must never succeed');
    },
  },
  {
    id: 'SEC-002', profile: 'main',
    title: '桥逃逸变体:不走 meta_path 直接 importlib 导入 js 被拦',
    run: async (c) => {
      const r = await c.exec({
        code: 's = pd.compat.sys\nj = s.modules["importlib"].import_module("js")\nresult = {"ua": str(j.navigator.userAgent)}',
      });
      assert.equal(r.body.ok, false);
    },
  },
  {
    id: 'SEC-003', profile: 'main',
    title: 'meta_path 整体重赋值 → forbidden_store(元组冻结)',
    run: async (c) => {
      const r = await c.exec({ code: 's = pd.compat.sys\ns.meta_path = ()\nresult = {}' });
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.code, 'forbidden_store');
    },
  },
  {
    id: 'SEC-004', profile: 'main',
    title: 'scratch 擦除:上一调用的文件不残留',
    run: async (c) => {
      const withFile = await c.exec({
        code: 'result = {"n": len(files)}',
        files: [{ name: 'left.csv', b64: Buffer.from('x\n', 'utf-8').toString('base64') }],
      });
      assert.deepEqual(withFile.body.result, { n: 1 });
      const after = await c.exec({ code: 'result = {"seen": list(files.keys())}' });
      assert.deepEqual(after.body.result, { seen: [] }, 'files dict starts empty on every call');
    },
  },
  {
    id: 'SEC-005', profile: 'main',
    title: '桥模块不在 sys.modules:笼子 __import__ 永远拿不到 js/pyodide/micropip',
    run: async (c) => {
      const r = await c.exec({
        code: 's = pd.compat.sys\nresult = {"js": "js" in s.modules, "pyodide": "pyodide" in s.modules, "micropip": "micropip" in s.modules}',
      });
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.result, { js: false, pyodide: false, micropip: false });
    },
  },
  {
    id: 'SEC-006', profile: 'mcp',
    title: '共享库状态每次调用后复原:pd.set_option / np.seterr 不泄漏到下一调用',
    // mcp profile = pool size 1, so the second call is guaranteed to land on
    // the same warm worker that the first call changed.
    run: async (c) => {
      const change = await c.exec({
        code: 'pd.set_option("display.max_rows", 2)\nnp.seterr(all="raise")\nresult = {"set": True}',
      });
      assert.equal(change.body.ok, true, JSON.stringify(change.body.error));
      const after = await c.exec({
        code: 'result = {"max_rows": pd.get_option("display.max_rows"), "divide": np.geterr()["divide"], '
          + '"inf": float(np.float64(1.0) / np.float64(0.0)) > 0}',
      });
      assert.equal(after.body.ok, true, JSON.stringify(after.body.error));
      assert.deepEqual(after.body.result, { max_rows: 60, divide: 'warn', inf: true });
      const ev = await c.admin('GET', '/admin/api/metrics?window=600');
      assert.ok(ev.body.events.some((e) => e.kind === 'state_restored'), 'restore is visible in the event feed');
    },
  },
  {
    id: 'SEC-007', profile: 'mcp',
    title: '未换行的 stdout 不串到下一调用(print(..., end=""))',
    run: async (c) => {
      const a = await c.exec({ code: 'print("CALLER-A-DATA", end="")\nresult = {}' });
      assert.equal(a.body.stdout, 'CALLER-A-DATA\n', 'a trailing partial line belongs to its own call');
      const b = await c.exec({ code: 'print("hello")\nresult = {}' });
      assert.equal(b.body.stdout, 'hello\n');
    },
  },
  {
    id: 'SEC-008', profile: 'mcp',
    title: 'np.random 全局种子 / pandas accessor 注册不泄漏到下一调用',
    run: async (c) => {
      await c.exec({ code: 'np.random.seed(123)\nresult = {}' });
      const r1 = await c.exec({ code: 'result = {"v": float(np.random.rand())}' });
      assert.notEqual(r1.body.result.v, 0.6964691855978616, 'first draw after seed(123) must not be predictable');
      const reg = await c.exec({
        code: 'pd.api.extensions.register_series_accessor("zz")(lambda s: 42)\nresult = {"v": pd.Series([1]).zz}',
      });
      assert.equal(reg.body.result.v, 42, 'registration works within its own call');
      const leak = await c.exec({ code: 'result = {"v": pd.Series([1]).zz}' });
      assert.equal(leak.body.ok, false, 'accessor registration must not leak to the next call');
    },
  },
];
