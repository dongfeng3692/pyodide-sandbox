// PKG — the injectable dependency manifest (packages profile): the three
// channels actually change what model code can use, the admin routes gate
// bad manifests, saves apply across restart(), and the MCP tool description
// reflects the live environment (names, versions, usage hints).
// The ONLINE install path (PyPI download + micropip oracle + verify boot) is
// intentionally not driven here — the suite never goes online; its pure parts
// are covered by packages/server/test/installer.test.mjs.
import assert from 'node:assert/strict';

const rpc = (c, body) => c.fetch('/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${c.state.token}` },
  body: JSON.stringify(body),
});

const manifestOf = async (c) => {
  const r = await c.admin('GET', '/admin/api/packages');
  assert.equal(r.status, 200);
  return r.body;
};

export default [
  {
    id: 'PKG-001', profile: 'packages', title: 'stdlib 别名可用：json / re 预绑定，无需 import',
    run: async (c) => {
      const r = await c.exec({
        code: 'm = re.search(r"\\d+", "ab12cd").group()\n'
          + 'j = json.loads(\'{"a": 5}\')["a"]\n'
          + 'result = {"m": m, "j": j}',
      });
      assert.equal(r.body.ok, true, JSON.stringify(r.body.error));
      assert.equal(r.body.result.m, '12');
      assert.equal(r.body.result.j, 5);
    },
  },
  {
    id: 'PKG-002', profile: 'packages', title: 'wheel 通道可用：openpyxl（sha256 lock）导入并工作',
    run: async (c) => {
      const r = await c.exec({
        code: 'wb = openpyxl.Workbook()\n'
          + 'ws = wb.active\n'
          + 'ws["A1"] = 42\n'
          + 'result = {"sheetnames": wb.sheetnames, "a1": ws["A1"].value}',
      });
      assert.equal(r.body.ok, true, JSON.stringify(r.body.error));
      assert.equal(r.body.result.a1, 42);
    },
  },
  {
    id: 'PKG-003', profile: 'packages', title: '版本 pin 与 admin config 回显（3.1.5 生效）',
    run: async (c) => {
      const r = await c.admin('GET', '/admin/api/config');
      assert.equal(r.status, 200);
      const names = r.body.packages.active.map((e) => e.name);
      assert.deepEqual(names.sort(), ['json', 'openpyxl', 're']);
      const openpyxl = r.body.packages.active.find((e) => e.name === 'openpyxl');
      assert.equal(openpyxl.source, 'wheel');
      assert.equal(openpyxl.version, '3.1.5'); // boot survived the pin check
      assert.equal(r.body.packages.restartRequired, false);
    },
  },
  {
    id: 'PKG-004', profile: 'packages', title: 'MCP 工具描述包含注入的依赖、版本与用法提示',
    run: async (c) => {
      await c.admin('POST', '/admin/api/mcp', { enabled: true });
      const init = await (await rpc(c, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json();
      assert.match(init.result.instructions, /`json` = json/);
      assert.match(init.result.instructions, /`openpyxl` = openpyxl 3\.1\.5/);
      const tool = (await (await rpc(c, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools[0];
      assert.match(tool.description, /do NOT write import/);
      assert.match(tool.description, /- Usage `json`:/);
      assert.match(tool.description, /- Usage `re`:/);
      assert.match(tool.description, /openpyxl/);
      // injected modules must not be advertised as missing
      assert.doesNotMatch(tool.description, /no json\/re\/math/);
      assert.doesNotMatch(tool.description, /no math\/json\/re/);
    },
  },
  {
    id: 'PKG-005', profile: 'packages', title: 'admin 保存校验：危险模块 / 别名冲突 / 白名单外 stdlib / 未知键 → 422',
    run: async (c) => {
      const base = async (packages) => {
        const r = await c.admin('POST', '/admin/api/packages', { packages });
        return { status: r.status, type: r.body?.error?.type, issues: r.body?.error?.issues ?? [] };
      };
      const cur = (await manifestOf(c)).active.map((e) => ({ name: e.name, source: e.source, aliases: e.aliases, version: e.version, wheel: e.wheel }));

      let r = await base([...cur, { name: 'os' }]);
      assert.equal(r.status, 422);
      assert.equal(r.type, 'invalid_packages');
      assert.ok(r.issues.some((i) => /forbidden/.test(i.message)));

      r = await base([{ name: 'shutil', source: 'stdlib' }]);
      assert.ok(r.issues.some((i) => /allowlist/.test(i.message)));

      r = await base([{ name: 'json', aliases: { pd: 'json' } }]);
      assert.ok(r.issues.some((i) => /already bound/.test(i.message)));

      r = await base([{ name: 'json', aliases: { files: 'json' } }]);
      assert.ok(r.issues.some((i) => /reserved/.test(i.message)));

      r = await base([{ name: 'json', typoKey: 1 }]);
      assert.ok(r.issues.some((i) => /unknown key/.test(i.message)));

      r = await base([{ name: 'os', source: 'stdlib' }, { name: 'x', wheel: '../../etc.whl' }]);
      assert.ok(r.issues.some((i) => /forbidden/.test(i.message)));

      // a valid save still works and is reversible (re-save the active list)
      const okSave = await c.admin('POST', '/admin/api/packages', { packages: cur });
      assert.equal(okSave.status, 200);
      assert.equal(okSave.body.restartRequired, false);
    },
  },
  {
    id: 'PKG-006', profile: 'packages', title: '在线安装路由：坏 spec/危险模块 422，状态机 idle → 不触网',
    run: async (c) => {
      const bad = async (spec) => {
        const r = await c.admin('POST', '/admin/api/packages/install', { spec });
        return { status: r.status, type: r.body?.error?.type };
      };
      assert.deepEqual(await bad(''), { status: 422, type: 'invalid_spec' });
      assert.deepEqual(await bad('not a name!'), { status: 422, type: 'invalid_spec' });
      assert.deepEqual(await bad('a/b'), { status: 422, type: 'invalid_spec' });
      assert.deepEqual(await bad('os'), { status: 422, type: 'forbidden_module' });
      assert.deepEqual(await bad('micropip'), { status: 422, type: 'forbidden_module' });
      const st = await c.admin('GET', '/admin/api/packages/install');
      assert.equal(st.body.job.phase, 'idle', 'nothing was started');
    },
  },
  {
    id: 'PKG-007', profile: 'packages', title: '保存 → 待重启 → restart() → 生效（math 可用 + 描述同步）',
    run: async (c) => {
      const before = await manifestOf(c);
      const next = [...before.active.map((e) => ({ name: e.name, source: e.source, aliases: e.aliases, version: e.version, wheel: e.wheel })), { name: 'math' }];
      const save = await c.admin('POST', '/admin/api/packages', { packages: next });
      assert.equal(save.status, 200);
      assert.equal(save.body.restartRequired, true, 'pending ≠ active until restart');

      // not applied yet: math is still undefined in the live runtime
      const stillOld = await c.exec({ code: 'result = {"v": math.sqrt(4)}' });
      assert.equal(stillOld.body.ok, false);

      await c.restart();

      const after = await manifestOf(c);
      assert.equal(after.restartRequired, false);
      assert.ok(after.active.some((e) => e.name === 'math'));
      const r = await c.exec({ code: 'result = {"v": math.sqrt(4)}' });
      assert.equal(r.body.ok, true, JSON.stringify(r.body.error));
      assert.equal(r.body.result.v, 2);
    },
  },
  {
    id: 'PKG-008', profile: 'packages', title: '恢复默认清单 → restart() → 回到配置文件的 3 项，math 消失',
    run: async (c) => {
      const reset = await c.admin('POST', '/admin/api/packages/reset');
      assert.equal(reset.status, 200);
      assert.equal(reset.body.restartRequired, true);
      await c.restart();
      const after = await manifestOf(c);
      assert.equal(after.restartRequired, false);
      assert.deepEqual(after.active.map((e) => e.name).sort(), ['json', 'openpyxl', 're']);
      const r = await c.exec({ code: 'result = {"v": math.sqrt(4)}' });
      assert.equal(r.body.ok, false, 'math left with the reset manifest');
      // and the seeded defaults still work
      const j = await c.exec({ code: 'result = {"a": json.loads(\'{"x": 1}\')["x"]}' });
      assert.equal(j.body.ok, true);
    },
  },
];
