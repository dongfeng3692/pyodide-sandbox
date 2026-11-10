// classify.test.mjs — failure classification (D12): every error_type family
// the recorder can persist lands in exactly one class, and the SQL filter
// predicates are built from the same constants (no drift between the
// classifier and the logs filters).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFailure, classWhere, FAIL_CLASSES, SYSTEM_TYPES } from '../src/classify.mjs';

test('successes are not failures (camelCase + DB snake_case rows)', () => {
  assert.equal(classifyFailure({ ok: 1, errorType: null }), null);
  assert.equal(classifyFailure({ ok: true, error_type: 'Whatever' }), null);
});

test('PolicyError rows (any code) are blocked — by design, never executed', () => {
  for (const code of ['forbidden_syntax', 'forbidden_name', 'forbidden_attribute', 'forbidden_store', 'syntax_error', 'code_too_large', null]) {
    assert.equal(classifyFailure({ ok: 0, errorType: 'PolicyError', errorCode: code }), 'blocked', code ?? 'no-code');
  }
});

test('pre-execution validation rejections are blocked (incl. legacy blanket value)', () => {
  for (const t of ['validation', 'invalid_code', 'invalid_files', 'too_many_files', 'file_too_large', 'invalid_json']) {
    assert.equal(classifyFailure({ ok: 0, errorType: t }), 'blocked', t);
  }
});

test('infrastructure failures are system', () => {
  for (const t of SYSTEM_TYPES) {
    assert.equal(classifyFailure({ ok: 0, errorType: t }), 'system', t);
  }
});

test('code-level failures are model (open set of exception class names)', () => {
  for (const t of ['NameError', 'KeyError', 'ValueError', 'ZeroDivisionError', 'RecursionError',
    'execution_timeout', 'PythonAudioError2000']) {
    assert.equal(classifyFailure({ ok: 0, errorType: t }), 'model', t);
  }
});

test('unknown failure shapes surface as system (fail-safe, never silently normal)', () => {
  assert.equal(classifyFailure({ ok: 0 }), 'system');
  assert.equal(classifyFailure({ ok: 0, error_type: null }), 'system');
});

test('classWhere is derived from the same constants as classifyFailure', () => {
  const blocked = classWhere('blocked');
  const system = classWhere('system');
  const model = classWhere('model');
  // every classified family appears in its own predicate and no other
  assert.match(blocked, /'PolicyError'/);
  assert.match(blocked, /'validation'/);
  assert.match(blocked, /'too_many_files'/);
  assert.ok(!blocked.includes('queue_full'));
  for (const t of SYSTEM_TYPES) {
    assert.ok(system.includes(`'${t}'`), t);
    assert.ok(!blocked.includes(`'${t}'`), t);
  }
  assert.match(model, /ok = 0 AND NOT/);
  assert.match(model, /PolicyError/);
  assert.match(model, /queue_full/);
  // unknown class → empty predicate (matches nothing, caller decides)
  assert.equal(classWhere('nope'), '');
  assert.equal(classWhere('failed'), '');
  assert.equal(classWhere('timeout'), '');
});

test('FAIL_CLASSES stays the 3-class vocabulary (D12)', () => {
  assert.deepEqual(FAIL_CLASSES, ['blocked', 'model', 'system']);
});
