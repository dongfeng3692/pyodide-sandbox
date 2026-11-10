// PRESET — preset differentiation. strict-data and minimal boot their own
// profiles; raw differences are checked on tight (raw + tiny limits).
// Not covered here: strict-data `nonlocal` (module-level `nonlocal` is a
// SyntaxError before policy, and every wrapping def/class is banned first).
import assert from 'node:assert/strict';

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

export default [
  {
    id: 'PRESET-001', profile: 'strict', title: 'strict-data: def → forbidden_syntax/functiondef',
    run: async (c) => {
      const r = await c.exec({ code: 'def f():\n    return 1\nresult = {}' });
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.code, 'forbidden_syntax');
      assert.equal(r.body.error.symbol, 'functiondef');
    },
  },
  {
    id: 'PRESET-002', profile: 'strict', title: 'strict-data: class → forbidden_syntax/classdef',
    run: async (c) => {
      const r = await c.exec({ code: 'class A:\n    pass\nresult = {}' });
      assert.equal(r.body.error.code, 'forbidden_syntax');
      assert.equal(r.body.error.symbol, 'classdef');
    },
  },
  {
    id: 'PRESET-003', profile: 'strict', title: 'strict-data: global 语句 → forbidden_syntax/global',
    run: async (c) => {
      const r = await c.exec({ code: 'global g\nresult = {}' });
      assert.equal(r.body.error.code, 'forbidden_syntax');
      assert.equal(r.body.error.symbol, 'global');
    },
  },
  {
    id: 'PRESET-004', profile: 'strict', title: 'strict-data: np 未暴露 → NameError',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"v": np.arange(2)}' });
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.type, 'NameError');
    },
  },
  {
    id: 'PRESET-005', profile: 'strict', title: 'strict-data: pd.read_csv 正常可用',
    run: async (c) => {
      const r = await c.exec({
        code: 'df = pd.read_csv(files["d.csv"])\nresult = {"rows": len(df)}',
        files: [{ name: 'd.csv', b64: b64('a\n1\n2\n') }],
      });
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.result, { rows: 2 });
    },
  },
  {
    id: 'PRESET-010', profile: 'minimal', title: 'minimal: lambda → forbidden_syntax/lambda',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"v": (lambda: 1)()}' });
      assert.equal(r.body.error.code, 'forbidden_syntax');
      assert.equal(r.body.error.symbol, 'lambda');
    },
  },
  {
    id: 'PRESET-011', profile: 'minimal', title: 'minimal: float → forbidden_name',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"v": float(1)}' });
      assert.equal(r.body.error.code, 'forbidden_name');
      assert.equal(r.body.error.symbol, 'float');
    },
  },
  {
    id: 'PRESET-012', profile: 'minimal', title: 'minimal: pd 未暴露 → NameError',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"v": pd.DataFrame()}' });
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.type, 'NameError');
    },
  },
  {
    id: 'PRESET-020', profile: 'tight', title: 'raw: eval 放行且结果正确',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"v": eval("6*7")}' });
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.result, { v: 42 });
    },
  },
  {
    id: 'PRESET-021', profile: 'tight', title: 'raw: dunder 属性访问放行',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"c": (1).__class__.__name__}' });
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.result, { c: 'int' });
    },
  },
  {
    id: 'PRESET-022', profile: 'tight', title: 'raw: 非 dict result 放行(resultMustBeDict=false)',
    run: async (c) => {
      const r = await c.exec({ code: 'result = [1, 2, 3]' });
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.result, [1, 2, 3]);
    },
  },
  {
    id: 'PRESET-023', profile: 'tight', title: 'raw: import 放行',
    run: async (c) => {
      const r = await c.exec({ code: 'import math\nresult = {"v": math.floor(2.7)}' });
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.result, { v: 2 });
    },
  },
];
