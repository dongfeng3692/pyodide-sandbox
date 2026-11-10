// policy.test.mjs — unit tests: config resolution, preset merge, and the
// Python AST engine exercised under the local CPython (dual-use proof:
// the same engine that runs inside Pyodide also pre-checks host-side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig, overridesFromEnv, mergeOverrides } from '../src/runtime/config.mjs';
import { describeEnvironment } from '../src/describe.mjs';
import { resolvePolicy, PRESETS } from '../src/policy/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(HERE, '../src/policy/python/policy.py');

// Prefer python3 (most Linux distros); fall back to python (Windows, macOS).
const PYTHON = (() => {
  for (const bin of ['python3', 'python']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch { /* try next */ }
  }
  throw new Error('tests need python3 (or python) on PATH — the policy engine runs under CPython');
})();

function pyValidate(code, policyObj) {
  // policy.py reads __SBX_POLICY__; emulate the injection via a driver.
  const driver = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dirname(ENGINE))})
import policy
p = policy.load_policy(json.loads(sys.argv[1]))
try:
    policy.validate(sys.argv[2], p)
    print("OK")
except policy.PolicyError as e:
    print("VIOLATION", e.code, e.name or "-", e.lineno or "-")
`;
  const out = execFileSync(PYTHON, ['-I', '-c', driver,
    JSON.stringify(policyObj), code], { encoding: 'utf-8' }).trim();
  return out;
}

const basePolicy = (over = {}) => resolvePolicy({ preset: 'general', ...over }).policy;

test('presets exist and differ in surface', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ['general', 'minimal', 'raw', 'strict-data']);
  assert.ok(basePolicy().banSyntax.includes('Import'));
  assert.ok(basePolicy({ preset: 'minimal' }).banSyntax.includes('Lambda'));
  assert.equal(basePolicy({ preset: 'raw' }).banSyntax.length, 0);
});

test('preset overrides merge: extraBanNames added, extraAllowNames win', () => {
  const p = basePolicy({ extraBanNames: ['frobnicate'], extraAllowNames: ['print'] });
  assert.ok(p.banNames.includes('frobnicate'));
  assert.ok(!p.banNames.includes('print'));
});

test('unknown policy preset throws', () => {
  assert.throws(() => resolvePolicy({ preset: 'nope' }), /unknown policy preset/);
});

test('python engine: happy path passes', () => {
  const p = { banSyntax: ['Import'], banNames: ['open'], attributeMode: 'deny-underscore', forbidAttributeStore: true, maxCodeBytes: 1000 };
  assert.equal(pyValidate('result = {"a": 1}', p), 'OK');
});

test('python engine: import blocked', () => {
  const p = basePolicy();
  assert.equal(pyValidate('import js\nresult = {}', p), 'VIOLATION forbidden_syntax import 1');
});

test('python engine: dunder/underscore name blocked, plain "_" allowed', () => {
  const p = basePolicy();
  assert.equal(pyValidate('x = __import__\nresult = {}', p).startsWith('VIOLATION forbidden_name __import__'), true);
  assert.equal(pyValidate('_ = 1\nresult = {"u": _}', p), 'OK');
});

test('python engine: full-width NFKC evasion blocked (PEP 3131)', () => {
  const p = basePolicy();
  // full-width "ｅｖａｌ" normalizes to "eval" at parse time
  const out = pyValidate('x = ｅｖａｌ\nresult = {}', p);
  assert.ok(out.startsWith('VIOLATION'), `expected violation, got: ${out}`);
});

test('python engine: underscore attribute blocked', () => {
  const p = basePolicy();
  assert.ok(pyValidate('result = {"a": files.__class__}', p).startsWith('VIOLATION forbidden_attribute'));
});

test('python engine: attribute STORE blocked (anti-monkeypatch)', () => {
  const p = basePolicy();
  assert.ok(pyValidate('pd.DataFrame.to_dict = 1\nresult = {}', p).startsWith('VIOLATION forbidden_store'));
});

test('python engine: lambda hidden name is caught (walks nested scopes)', () => {
  const p = basePolicy();
  assert.ok(pyValidate('f = lambda: open("/etc/passwd")\nresult = {}', p).startsWith('VIOLATION forbidden_name open'));
});

test('python engine: self/cls stores allowed inside class bodies (instance state)', () => {
  const p = basePolicy();
  assert.equal(pyValidate(
    'class Pt:\n'
    + '    def __init__(self, x):\n'
    + '        self.x = x\n'
    + '    def scaled(self, k):\n'
    + '        self.x = self.x * k\n'
    + '        return self.x\n'
    + 'result = {"v": Pt(2).scaled(3)}', p), 'OK');
  // deeper chains rooted at self, and cls-level config, are equally fine
  assert.equal(pyValidate(
    'class Reg:\n'
    + '    def configure(self, other):\n'
    + '        self.cfg.rows = other\n'
    + '        cls.label = "x"\n'
    + 'result = {}', p), 'OK');
});

test('python engine: self-store exemption does not open a monkeypatch hole', () => {
  const p = basePolicy();
  // `self` as an ordinary parameter OUTSIDE a class body is no exemption
  assert.ok(pyValidate(
    'def poison(self):\n'
    + '    self.read_csv = 1\n'
    + 'result = {"v": poison}', p).startsWith('VIOLATION forbidden_store'));
  // inside a class, only chains ROOTED at self/cls pass — other objects stay protected
  assert.ok(pyValidate(
    'class C:\n'
    + '    def m(self, other):\n'
    + '        other.to_dict = 1\n'
    + 'result = {}', p).startsWith('VIOLATION forbidden_store'));
});

// Drive hints.py standalone: stub the classes it expects from the
// concatenated runtime (encode.py/wrapper.py) so isinstance checks resolve.
function pyRuntimeHint(excExpr) {
  const driver = `
import sys
sys.path.insert(0, ${JSON.stringify(dirname(ENGINE))})
import hints
for n in ("ResultTooLarge", "ResultContractError", "MissingFile"):
    setattr(hints, n, type(n, (Exception,), {}))
from urllib.error import URLError
from http.client import RemoteDisconnected
exc = ${excExpr}
print(hints.runtime_hint(exc, {"modules": {"pd": "pandas", "np": "numpy"}}) or "-")
`;
  return execFileSync(PYTHON, ['-I', '-c', driver], { encoding: 'utf-8' }).trim();
}

function pyPolicyHint(code, symbol) {
  const driver = `
import sys
sys.path.insert(0, ${JSON.stringify(dirname(ENGINE))})
import policy, hints
exc = policy.PolicyError(${JSON.stringify(code)}, ${JSON.stringify(symbol)}, 1)
print(hints.policy_hint(exc, {"modules": {"pd": "pandas", "np": "numpy"}}) or "-")
`;
  return execFileSync(PYTHON, ['-I', '-c', driver], { encoding: 'utf-8' }).trim();
}

test('python hints: network failures say no-network instead of a transport error', () => {
  // the two messages the runtime actually produces for URL fetches
  const cases = [
    'URLError("Remote end closed connection without response")',
    'RemoteDisconnected("Remote end closed connection without response")',
    'RuntimeError("TLS not supported in this environment")',
  ];
  for (const c of cases) {
    const h = pyRuntimeHint(c);
    assert.match(h, /network access is disabled/, c);
    assert.match(h, /do not retry/, c);
  }
});

test('python hints: dunder forbidden_name never suggests a rename', () => {
  const importHint = pyPolicyHint('forbidden_name', '__import__');
  assert.match(importHint, /import statements are disabled/);
  assert.doesNotMatch(importHint, /rename/);
  const dunderHint = pyPolicyHint('forbidden_name', '__debug__');
  assert.match(dunderHint, /dunder/);
  assert.doesNotMatch(dunderHint, /rename/);
  // single-underscore names still get the rename suggestion
  assert.match(pyPolicyHint('forbidden_name', '_tmp'), /rename `_tmp`/);
});

test('config: unknown key warns, dangerous override warns louder', () => {
  const { config, warnings } = resolveConfig({ policy: { presetTypo: 1, preset: 'raw' } });
  assert.ok(warnings.some((w) => w.includes('unknown key "presetTypo"')));
  assert.ok(warnings.some((w) => w.includes('UNSAFE')));
  assert.equal(config.policy.preset, 'raw');
});

test('config: pool size bounds enforced', () => {
  assert.throws(() => resolveConfig({ pool: { size: 0 } }), RangeError);
  assert.throws(() => resolveConfig({ pool: { size: 999 } }), RangeError);
});

test('config: state provider other than none is gated for now', () => {
  const { config, warnings } = resolveConfig({ state: { provider: 'stage' } });
  assert.equal(config.state.provider, 'none');
  assert.ok(warnings.some((w) => w.includes('future release')));
});

test('raw preset: underscore names allowed only when denyUnderscoreNames is off', () => {
  const raw = basePolicy({ preset: 'raw' });
  assert.equal(raw.denyUnderscoreNames, false);
  assert.equal(pyValidate('x = __import__\nresult = {}', {
    banSyntax: raw.banSyntax, banNames: raw.banNames, denyUnderscoreNames: false,
  }), 'OK');
  // general still blocks the same name
  const general = basePolicy();
  assert.ok(pyValidate('x = __import__\nresult = {}', {
    banSyntax: general.banSyntax, banNames: general.banNames, denyUnderscoreNames: true,
  }).startsWith('VIOLATION forbidden_name'));
});

test('config: weakening overrides emit UNSAFE warnings', () => {
  const cases = [
    { policy: { attributeMode: 'off' } },
    { policy: { forbidAttributeStore: false } },
    { server: { allowNoToken: true } },
    { policy: { exposeModules: { s: 'sys' } } },
  ];
  for (const ov of cases) {
    const { warnings } = resolveConfig(ov);
    assert.ok(warnings.some((w) => w.startsWith('UNSAFE')), `expected UNSAFE for ${JSON.stringify(ov)}`);
  }
  // preset defaults must NOT warn
  const { warnings: clean } = resolveConfig({});
  assert.equal(clean.length, 0);
});

test('config: non-numeric/out-of-range numbers fail fast (no silent NaN timeouts)', () => {
  // SBX_TIMEOUT_MS=60s used to become NaN → setTimeout fires after 1ms → every call "timed out"
  assert.throws(() => resolveConfig(overridesFromEnv({ SBX_TIMEOUT_MS: '60s' })), /pool\.execTimeoutMs must be an integer/);
  assert.throws(() => resolveConfig({ server: { port: 70_000 } }), /server\.port/);
  assert.throws(() => resolveConfig({ pool: { maxQueue: -1 } }), /pool\.maxQueue/);
  assert.throws(() => resolveConfig({ output: { resultMaxBytes: 1.5 } }), /output\.resultMaxBytes/);
  // allowed edges: port 0 (OS-assigned), rssLimitMb null/0 (disabled)
  assert.doesNotThrow(() => resolveConfig({ server: { port: 0 }, pool: { rssLimitMb: null } }));
  assert.doesNotThrow(() => resolveConfig({ pool: { rssLimitMb: 0 } }));
});

test('config: env overrides merge per key, not per section', () => {
  const file = { server: { adminPassword: 'from-file', dbPath: '/srv/sbx.db', allowNoToken: true }, pool: { size: 4 } };
  const merged = mergeOverrides(file, overridesFromEnv({ SBX_PORT: '9000' }));
  const { config } = resolveConfig(merged);
  assert.equal(config.server.port, 9000);
  assert.equal(config.server.adminPassword, 'from-file', 'SBX_PORT must not wipe the file\'s server section');
  assert.equal(config.server.dbPath, '/srv/sbx.db');
  assert.equal(config.server.allowNoToken, true);
  assert.equal(config.pool.size, 4);
  assert.equal(file.server.port, undefined, 'inputs are not mutated');
});

test('describeEnvironment reflects the active preset, not a hard-coded text', () => {
  const { config } = resolveConfig({});
  const describe = (preset) => describeEnvironment({
    policy: resolvePolicy({ ...config.policy, preset }).policy,
    config,
    runtime: { modules: { pd: { version: '3.0.2' } } },
  });
  const general = describe('general');
  assert.match(general, /`pd` = pandas 3\.0\.2, `np` = numpy/);
  assert.match(general, /print/);
  assert.doesNotMatch(general, /Rejected syntax/, 'general allows def/class/lambda');
  const strict = describe('strict-data');
  assert.doesNotMatch(strict, /`np`/, 'strict-data exposes pandas only');
  assert.match(strict, /Rejected syntax: `def`/);
  const minimal = describe('minimal');
  assert.match(minimal, /No modules are available/);
  assert.match(minimal, /Not available: [^\n]*print/);
  assert.match(describe('raw'), /All Python builtins/);
});
