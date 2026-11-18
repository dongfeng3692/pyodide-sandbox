// runtime.mjs — pure helpers (sanitizeName). The runtime itself needs a real
// Pyodide and is covered by the server regression suite instead.
import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeName } from '../src/runtime/runtime.mjs';

test('sanitizeName keeps non-ASCII (files-dict key contract)', () => {
  assert.equal(sanitizeName('流向-10月-绵阳科伦.xlsx'), '流向-10月-绵阳科伦.xlsx');
  assert.equal(sanitizeName('café.csv'), 'café.csv');
});

test('sanitizeName strips any path component', () => {
  assert.equal(sanitizeName('/etc/passwd'), 'passwd');
  assert.equal(sanitizeName('..\\..\\win.ini'), 'win.ini');
  assert.equal(sanitizeName('a/b/c.json'), 'c.json');
});

test('sanitizeName refuses dot-specials and empty, scrubs control chars', () => {
  assert.equal(sanitizeName('..'), 'file');
  assert.equal(sanitizeName('.'), 'file');
  assert.equal(sanitizeName(''), 'file');
  // null/undefined names never reach here via HTTP (normalizeFiles defaults
  // them to 'file'); String() coercion semantics only.
  assert.equal(sanitizeName(null), 'null');
  assert.equal(sanitizeName('a\nb\tc.csv'), 'a_b_c.csv');
});
