// POL — AST policy engine over HTTP (general preset, main profile).
// Every violation must carry the structured five-field error so a model can
// self-correct: {type:'PolicyError', code, symbol, line, retryable}.
import assert from 'node:assert/strict';

export default [
  {
    id: 'POL-001', profile: 'main', title: 'import os → forbidden_syntax/import',
    run: async (c) => {
      const r = await c.exec({ code: 'import os\nresult = {}' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.type, 'PolicyError');
      assert.equal(r.body.error.code, 'forbidden_syntax');
      assert.equal(r.body.error.symbol, 'import');
    },
  },
  {
    id: 'POL-002', profile: 'main', title: 'import js(桥模块)→ forbidden_syntax',
    run: async (c) => {
      const r = await c.exec({ code: 'import js\nresult = {}' });
      assert.equal(r.body.error.code, 'forbidden_syntax');
      assert.equal(r.body.error.symbol, 'import');
    },
  },
  {
    id: 'POL-003', profile: 'main', title: 'from os import path → forbidden_syntax/importfrom',
    run: async (c) => {
      const r = await c.exec({ code: 'from os import path\nresult = {}' });
      assert.equal(r.body.error.code, 'forbidden_syntax');
      assert.equal(r.body.error.symbol, 'importfrom');
    },
  },
  {
    id: 'POL-004', profile: 'main', title: '__import__ → forbidden_name',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"v": __import__("os")}' });
      assert.equal(r.body.error.code, 'forbidden_name');
      assert.equal(r.body.error.symbol, '__import__');
    },
  },
  {
    id: 'POL-005', profile: 'main', title: '禁用内置名逐一拦截(遍历)',
    run: async (c) => {
      const names = ['open', 'exec', 'eval', 'compile', 'getattr', 'setattr',
        'globals', 'vars', 'input', 'breakpoint', 'type', 'object'];
      // print left this list on purpose: general allows it (stdout is captured + capped) — see AGENT-003
      for (const name of names) {
        const r = await c.exec({ code: `x = ${name}\nresult = {}` });
        assert.equal(r.body.ok, false, name);
        assert.equal(r.body.error.code, 'forbidden_name', name);
        assert.equal(r.body.error.symbol, name);
      }
    },
  },
  {
    id: 'POL-006', profile: 'main', title: 'dunder 标识符 → forbidden_name',
    run: async (c) => {
      const r = await c.exec({ code: 'x = __debug__\nresult = {}' });
      assert.equal(r.body.error.code, 'forbidden_name');
      assert.equal(r.body.error.symbol, '__debug__');
    },
  },
  {
    id: 'POL-007', profile: 'main', title: '下划线属性 → forbidden_attribute(deny-underscore)',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"a": pd.DataFrame()._nope}' });
      assert.equal(r.body.error.code, 'forbidden_attribute');
      assert.equal(r.body.error.symbol, '_nope');
    },
  },
  {
    id: 'POL-008', profile: 'main', title: '单个下划线 _ 放行',
    run: async (c) => {
      const r = await c.exec({ code: '_ = 1\nresult = {"ok": True}' });
      assert.equal(r.body.ok, true);
    },
  },
  {
    id: 'POL-009', profile: 'main', title: '属性 STORE(反 monkeypatch)→ forbidden_store',
    run: async (c) => {
      const r = await c.exec({ code: 'pd.DataFrame.to_dict = 1\nresult = {}' });
      assert.equal(r.body.error.type, 'PolicyError');
      assert.equal(r.body.error.code, 'forbidden_store');
    },
  },
  {
    id: 'POL-010', profile: 'main', title: 'NFKC 全角 ｅｖａｌ 仍被拦(symbol 归一为 eval)',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"v": ｅｖａｌ("1+1")}' });
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.code, 'forbidden_name');
      assert.equal(r.body.error.symbol, 'eval', 'PEP 3131 normalizes full-width identifiers');
    },
  },
  {
    id: 'POL-011', profile: 'main', title: 'lambda 嵌套作用域藏名仍被拦',
    run: async (c) => {
      const r = await c.exec({ code: 'f = (lambda: eval("1"))\nresult = {"v": f()}' });
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.code, 'forbidden_name');
      assert.equal(r.body.error.symbol, 'eval');
    },
  },
  {
    id: 'POL-012', profile: 'main', title: '策略错误信封五字段完整(type/code/symbol/line/retryable)',
    run: async (c) => {
      const r = await c.exec({ code: 'import os\nresult = {}' });
      const e = r.body.error;
      assert.equal(e.type, 'PolicyError');
      assert.equal(e.code, 'forbidden_syntax');
      assert.equal(e.symbol, 'import');
      assert.equal(e.line, 1);
      assert.equal(e.retryable, true);
    },
  },
  {
    id: 'POL-013', profile: 'main', title: 'class 实例状态(self.x 存储)放行',
    run: async (c) => {
      const r = await c.exec({
        code: 'class Pt:\n'
          + '    def __init__(self, x, y):\n'
          + '        self.x = x\n'
          + '        self.y = y\n'
          + '    def norm2(self):\n'
          + '        return self.x ** 2 + self.y ** 2\n'
          + 'result = {"ok": Pt(3, 4).norm2() == 25}',
      });
      assert.equal(r.body.ok, true);
      assert.equal(r.body.result.ok, true);
    },
  },
  {
    id: 'POL-014', profile: 'main', title: 'self 豁免不扩到类外(def f(self) 仍 forbidden_store)',
    run: async (c) => {
      const r = await c.exec({
        code: 'def poison(self):\n'
          + '    self.read_csv = 1\n'
          + 'result = {"v": poison}',
      });
      assert.equal(r.body.error.code, 'forbidden_store');
      assert.match(r.body.error.hint, /self\.x = \.\.\.` inside a `class`/);
    },
  },
  {
    id: 'POL-015', profile: 'main', title: '__import__ hint 指向预绑定 globals 而非建议改名',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"v": __import__("os").name}' });
      assert.equal(r.body.error.code, 'forbidden_name');
      assert.match(r.body.error.hint, /import statements are disabled/);
      assert.doesNotMatch(r.body.error.hint, /rename/);
    },
  },
];
