// index.mjs — policy resolution + Python source assembly.
// Policy is DATA (JSON) + one Python engine. Presets are data packages.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { general } from './presets/general.mjs';
import { strictData } from './presets/strict-data.mjs';
import { minimal } from './presets/minimal.mjs';
import { raw } from './presets/raw.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PRESETS = {
  general,
  'strict-data': strictData,
  minimal,
  raw,
};

export const POLICY_KEYS = new Set([
  'preset', 'banSyntax', 'banNames', 'extraBanNames', 'extraAllowNames',
  'attributeMode', 'attributeWhitelist', 'forbidAttributeStore',
  'builtinsMode', 'builtinsExtra', 'resultMustBeDict', 'maxCodeBytes',
  'exposeModules',
]);

// Builtins handed to model code in builtinsMode "safe" (the wrapper also adds
// a caged `__import__`). Single source of truth: the wrapper receives this
// list via _POLICY_FLAGS and describeEnvironment() advertises it to models.
// Preset banNames still apply on top (AST check), e.g. minimal bans float.
// Deliberately absent: getattr/setattr/hasattr/vars/dir (string-keyed
// attribute access sidesteps the AST attribute checks), open, eval/exec.
export const SAFE_BUILTINS = Object.freeze([
  // values & containers
  'abs', 'all', 'any', 'bool', 'dict', 'enumerate', 'filter', 'float', 'int',
  'isinstance', 'issubclass', 'len', 'list', 'map', 'max', 'min', 'range',
  'reversed', 'round', 'set', 'frozenset', 'sorted', 'str', 'sum', 'tuple', 'zip',
  'divmod', 'pow', 'chr', 'ord', 'hex', 'bin', 'oct', 'slice', 'bytes',
  'bytearray', 'complex', 'callable', 'print',
  // exceptions (raise / except)
  'Exception', 'ArithmeticError', 'AssertionError', 'AttributeError',
  'FloatingPointError', 'ImportError', 'IndexError', 'KeyError', 'LookupError',
  'NameError', 'NotImplementedError', 'OverflowError', 'RuntimeError',
  'StopIteration', 'TypeError', 'UnicodeDecodeError', 'UnicodeEncodeError',
  'UnicodeError', 'ValueError', 'ZeroDivisionError',
  // class statements need it (bans on ClassDef are enforced by the AST engine)
  '__build_class__',
]);

/** Merge a preset with config.policy overrides into the final policy object. */
export function resolvePolicy(policyConfig = {}) {
  const warnings = [];
  const presetName = policyConfig.preset ?? 'general';
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`unknown policy preset "${presetName}" (available: ${Object.keys(PRESETS).join(', ')})`);
  }
  for (const key of Object.keys(policyConfig)) {
    if (!POLICY_KEYS.has(key)) warnings.push(`policy: unknown key "${key}" ignored (typo?)`);
  }
  if (presetName === 'raw') warnings.push('UNSAFE: preset "raw" disables all code restrictions.');

  const p = { preset: presetName };
  for (const key of ['banSyntax', 'banNames', 'attributeMode', 'attributeWhitelist',
    'forbidAttributeStore', 'denyUnderscoreNames', 'builtinsMode', 'builtinsExtra',
    'resultMustBeDict', 'maxCodeBytes', 'exposeModules']) {
    p[key] = policyConfig[key] ?? preset[key];
  }
  const extraBan = policyConfig.extraBanNames ?? [];
  const extraAllow = new Set(policyConfig.extraAllowNames ?? []);
  p.banNames = [...new Set([...(p.banNames ?? []), ...extraBan])].filter((n) => !extraAllow.has(n));
  if (p.builtinsMode === 'full') warnings.push('UNSAFE: builtinsMode="full" exposes __import__/open/eval to model code.');
  return { policy: p, warnings };
}

/** Python source for the AST engine — importable under CPython for host-side pre-checks. */
export function policyEngineSource() {
  return readFileSync(join(HERE, 'python', 'policy.py'), 'utf-8');
}

/** Full trusted python source: engine + encoder + hints + state reset +
 *  wrapper, with policy injected. Evaluates to SBX_WRAP; SBX_RESET is left
 *  in the runtime's globals. */
export function buildWrapperSource(policy, { resultMaxBytes = 24_576 } = {}) {
  const engineJson = JSON.stringify({
    banSyntax: policy.banSyntax,
    banNames: policy.banNames,
    attributeMode: policy.attributeMode,
    attributeWhitelist: policy.attributeWhitelist,
    forbidAttributeStore: policy.forbidAttributeStore,
    denyUnderscoreNames: policy.denyUnderscoreNames ?? true,
    maxCodeBytes: policy.maxCodeBytes,
  });
  const flags = JSON.stringify({
    builtinsMode: policy.builtinsMode,
    builtinsExtra: policy.builtinsExtra,
    safeBuiltins: SAFE_BUILTINS,
    resultMustBeDict: policy.resultMustBeDict,
    resultMaxBytes,
  });
  const py = (name) => readFileSync(join(HERE, 'python', name), 'utf-8');
  return [
    // __SBX_POLICY__ stays a RAW string; policy.load_policy() is the single
    // place that parses it (avoids double-json.loads on dict).
    `__SBX_POLICY__ = r'''${engineJson}'''`,
    policyEngineSource(),
    `import json\n_POLICY_FLAGS = json.loads(r'''${flags}''')`,
    py('encode.py'),
    py('hints.py'),
    py('state.py'),
    py('wrapper.py'),
    'SBX_WRAP',
  ].join('\n');
}
