// packages.test.mjs — unit tests for the injectable dependency manifest:
// validation gates (allowlist/denylist/alias rules), compilation into the
// boot primitives, resolveConfig integration, and describeEnvironment output.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig, DEFAULT_CONFIG } from '../src/runtime/config.mjs';
import { validatePackages, compilePackages, STDLIB_SAFE_ALLOWLIST, FORBIDDEN_EXPOSE, BUILTIN_HINTS } from '../src/packages.mjs';
import { describeEnvironment } from '../src/describe.mjs';
import { resolvePolicy } from '../src/policy/index.mjs';

const validate = (manifest, opts = {}) => validatePackages(manifest, {
  policyConfig: { preset: 'general' }, denyModules: DEFAULT_CONFIG.runtime.denyModules, ...opts,
});

test('empty manifest resolves to exactly the pre-manifest behavior', () => {
  const { config, warnings } = resolveConfig({});
  assert.deepEqual(config.packages, []);
  assert.deepEqual(config.runtime.preload, ['pandas', 'numpy']);
  assert.deepEqual(config.runtime.preimport, ['pandas', 'numpy']);
  assert.equal(config.policy.exposeModules, null); // preset supplies pd/np
  assert.equal(warnings.length, 0);
});

test('valid manifest compiles into preload/preimport/exposeModules', () => {
  const manifest = [
    { name: 'scipy', aliases: { sp: 'scipy' } },                                // pyodide (inferred)
    { name: 'openpyxl', wheel: 'openpyxl-3.1.5-py2.py3-none-any.whl', version: '3.1.5' }, // wheel (inferred)
    { name: 're' },                                                             // stdlib (inferred)
    { name: 'urllib.parse', aliases: { up: 'urllib.parse' } },                  // dotted stdlib
    { name: 'six', aliases: null },                                             // dependency-only
  ];
  const { config } = resolveConfig({ packages: manifest });
  assert.ok(config.runtime.preload.includes('scipy'));
  assert.ok(!config.runtime.preload.includes('openpyxl'), 'wheel packages do not go through loadPackage');
  assert.deepEqual(config.policy.exposeModules, {
    pd: 'pandas', np: 'numpy', // preset aliases survive
    sp: 'scipy',
    openpyxl: 'openpyxl',      // default alias for a simple name
    re: 're',
    up: 'urllib.parse',
  });
  assert.ok(config.runtime.preimport.includes('urllib.parse'));
  assert.ok(config.runtime.preimport.includes('pandas'));
  // normalized entries echo back
  assert.equal(config.packages.find((e) => e.name === 're').source, 'stdlib');
  assert.equal(config.packages.find((e) => e.name === 'scipy').source, 'pyodide');
  assert.equal(config.packages.find((e) => e.name === 'openpyxl').source, 'wheel');
  assert.deepEqual(config.packages.find((e) => e.name === 'six').aliases, {});
});

test('forbidden modules are hard-rejected regardless of channel', () => {
  for (const bad of ['os', 'sys', 'io', 'js', 'micropip', 'pyodide', 'importlib', 'ctypes', 'shutil', 'pickle', 'os.path']) {
    const { errors } = validate([{ name: bad }]);
    assert.ok(errors.some((e) => e.field === 'name' && /forbidden/.test(e.message)), bad);
  }
  // denyModules extends the built-in deny set
  const { errors } = validate([{ name: 'mysecretbridge' }], { denyModules: ['mysecretbridge'] });
  assert.ok(errors.some((e) => /forbidden/.test(e.message)));
});

test('stdlib channel is allowlist-gated', () => {
  const ok = validate([{ name: 'json' }]);
  assert.equal(ok.errors.length, 0);
  for (const bad of ['shutil', 'subprocess', 'glob', 'pathlib', 'io']) {
    assert.notEqual(STDLIB_SAFE_ALLOWLIST.includes(bad), true, `${bad} must not be on the allowlist`);
  }
  // non-allowlist name without wheel infers pyodide — explicit stdlib is the error
  const { errors } = validate([{ name: 'shutil', source: 'stdlib' }]);
  assert.ok(errors.some((e) => /allowlist/.test(e.message)));
  // dotted stdlib requires explicit aliases
  const dotted = validate([{ name: 'urllib.parse' }]);
  assert.ok(dotted.errors.some((e) => e.field === 'aliases' && /explicit aliases/.test(e.message)));
});

test('alias rules: grammar, reserved names, builtin/ban collisions, preset collisions, target scope', () => {
  const cases = [
    [{ '9bad': 'json' }, /not a usable alias name/],
    [{ __dunder__: 'json' }, /not a usable alias name/],
    [{ files: 'json' }, /reserved/],
    [{ result: 'json' }, /reserved/],
    [{ print: 'json' }, /safe builtin/],
    [{ open: 'json' }, /banned name/],
    [{ pd: 'json' }, /already bound by preset:pandas/],
    [{ j: 'math' }, /must be "json" or a submodule/], // target outside the entry's tree
  ];
  for (const [aliases, re] of cases) {
    const { errors } = validate([{ name: 'json', aliases }]);
    assert.ok(errors.some((e) => e.field === 'aliases' && re.test(e.message)), JSON.stringify(aliases));
  }
  // duplicate aliases across entries
  const dup = validate([{ name: 'json' }, { name: 're', aliases: { json: 're' } }]);
  assert.ok(dup.errors.some((e) => /already bound/.test(e.message)));
});

test('entry field validation: names, wheels, versions, hints, unknown keys', () => {
  const cases = [
    [{ name: '../evil' }, /not a valid package\/module name/],
    [{ name: '_private' }, /starts with "_"/],
    [{ name: 'a b' }, /not a valid package\/module name/],
    [{ name: 'x', unknown: 1 }, /unknown key/],
    [{ name: 'openpyxl', wheel: 'a/b.whl' }, /not a plain \.whl filename/],
    [{ name: 'openpyxl', wheel: 'x.whl', source: 'stdlib' }, /wheel only applies/],
    [{ name: 'x', version: 'v1' }, /PEP 440/],
    [{ name: 'x', hint: 'line\nbreak' }, /single-line/],
    [{ name: 'x', hint: 'x'.repeat(301) }, /single-line/],
    [{ name: 'x', sha256: 'zz' }, /64 hex chars/],
  ];
  for (const [entry, re] of cases) {
    const { errors } = validate([entry]);
    assert.ok(errors.some((e) => re.test(e.message)), JSON.stringify(entry));
  }
  const dup = validate([{ name: 're' }, { name: 're' }]);
  assert.ok(dup.errors.some((e) => /appears twice/.test(e.message)));
});

test('resolveConfig throws (fail fast) on an invalid manifest', () => {
  assert.throws(() => resolveConfig({ packages: [{ name: 'os' }] }), /config\.packages invalid.*forbidden/s);
  assert.throws(() => resolveConfig({ packages: [{ name: 'x', aliases: { pd: 'x' } }] }), /already bound/);
  // a non-array manifest only warns (typo protection, not a crash)
  const { warnings } = resolveConfig({ packages: 'nope' });
  assert.ok(warnings.some((w) => /must be an array/.test(w)));
});

test('resolveConfig is idempotent when re-resolved with a different manifest', () => {
  const first = resolveConfig({ packages: [{ name: 'math' }, { name: 're' }] }).config;
  const second = resolveConfig({ packages: [{ name: 'math' }] }, first).config;
  assert.deepEqual(second.policy.exposeModules, { pd: 'pandas', np: 'numpy', math: 'math' });
  assert.ok(!second.runtime.preimport.includes('re'), 'the removed entry\'s contribution is stripped');
  const third = resolveConfig({ packages: [] }, second).config; // drop everything
  assert.deepEqual(third.policy.exposeModules, null);
  assert.deepEqual(third.runtime.preimport, ['pandas', 'numpy']);
  assert.deepEqual(third.packages, []);
});

test('describeEnvironment: hints and dynamic missing-module line', () => {
  const { config } = resolveConfig({ packages: [{ name: 'math' }, { name: 're' }, { name: 'flask', aliases: { flask: 'flask' }, hint: 'custom hint text' }] });
  const { policy } = resolvePolicy(config.policy);
  const text = describeEnvironment({ policy, config, runtime: null });
  assert.match(text, /do NOT write import/);
  assert.match(text, /- Usage `math`:/);
  assert.match(text, /- Usage `re`:/);
  assert.match(text, /- Usage `flask`: custom hint text\./);
  assert.doesNotMatch(text, /no math\/json\/re\/datetime/, 'injected modules are not listed as missing');
  assert.match(text, /no json\/datetime\/collections/, 'remaining allowlist examples fill the line');

  // no manifest → the original static line is intact
  const plain = describeEnvironment({ policy: resolvePolicy().policy, config: resolveConfig().config });
  assert.match(plain, /no math\/json\/re\/datetime\/collections/);
  assert.doesNotMatch(plain, /- Usage/);
});

test('builtin hints exist for the full stdlib allowlist', () => {
  for (const m of STDLIB_SAFE_ALLOWLIST) {
    assert.ok(BUILTIN_HINTS[m], `missing builtin hint for ${m}`);
  }
});

test('compilePackages never sends wheel/stdlib entries through loadPackage', () => {
  const { entries } = validate([
    { name: 'json' },
    { name: 'openpyxl', wheel: 'openpyxl-3.1.5-py2.py3-none-any.whl' },
    { name: 'scipy' },
  ]);
  const compiled = compilePackages(entries);
  assert.deepEqual(compiled.preload, ['scipy']);
  assert.deepEqual(compiled.wheels, [{ name: 'openpyxl', wheel: 'openpyxl-3.1.5-py2.py3-none-any.whl' }]);
  assert.deepEqual(compiled.exposeModules, { json: 'json', openpyxl: 'openpyxl', scipy: 'scipy' });
  assert.ok(FORBIDDEN_EXPOSE.has('os') && FORBIDDEN_EXPOSE.has('sys'));
});
