// installer.test.mjs — offline unit tests for the install pipeline's pure
// parts: spec parsing, channel routing, pure-wheel selection and lock
// extension/rollback. The network path (PyPI + micropip oracle + verify boot)
// is exercised manually via `npm run add:pkg` — CI never goes online.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSpec, route, pyodidePackageNames, pickPureWheel, extendLock } from '../src/installer.mjs';

test('parseSpec: names, pins, and rejections', () => {
  assert.deepEqual(parseSpec('openpyxl'), { name: 'openpyxl', version: null, req: 'openpyxl' });
  assert.deepEqual(parseSpec(' openpyxl==3.1.5 '), { name: 'openpyxl', version: '3.1.5', req: 'openpyxl==3.1.5' });
  for (const bad of ['', 'a b', 'pkg[x]', 'a/b', 'a\\b', 'x==1==2', 'a==v1', 'http://x', '_x', 'a..b', '.a']) {
    assert.throws(() => parseSpec(bad), { code: 'invalid_spec' }, JSON.stringify(bad));
  }
});

test('route: stdlib / pyodide / pypi / forbidden', () => {
  assert.equal(route('json'), 'stdlib');
  assert.equal(route('urllib.parse'), 'stdlib');
  const names = pyodidePackageNames();
  assert.ok(Array.isArray(names));
  if (names.length) {
    assert.ok(names.includes('numpy') && names.includes('pandas'), 'the pinned pyodide lock bundles numpy/pandas');
    assert.equal(route('numpy'), 'pyodide');
  }
  assert.equal(route('definitely-not-a-real-pypi-pkg-xyz'), 'pypi');
  for (const bad of ['os', 'sys', 'micropip', 'js', 'ctypes', 'shutil']) {
    assert.throws(() => route(bad), { code: 'forbidden_module' }, bad);
  }
  // allowlisted dotted stdlib is NOT caught by the forbidden parent (urllib)
  assert.doesNotThrow(() => route('urllib.parse'));
});

test('pickPureWheel: only py3-none-any / py2.py3-none-any wheels', () => {
  const urls = [
    { packagetype: 'sdist', filename: 'x-1.0.tar.gz' },
    { packagetype: 'bdist_wheel', filename: 'x-1.0-cp312-cp312-emscripten.whl' },
    { packagetype: 'bdist_wheel', filename: 'x-1.0-cp312-cp312-linux_x86_64.whl' },
    { packagetype: 'bdist_wheel', filename: 'x-1.0-py3-none-any.whl' },
    { packagetype: 'bdist_wheel', filename: 'y-2.0-py2.py3-none-any.whl' },
  ];
  assert.equal(pickPureWheel(urls).filename, 'x-1.0-py3-none-any.whl');
  assert.equal(pickPureWheel([urls[1]]), null, 'compiled-only releases are rejected');
});

test('extendLock: adds entries, refuses conflicts, rollback token restores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-inst-'));
  try {
    const lockPath = join(dir, 'wheels-lock.json');
    const add = (f, h) => ({ filename: f, sha256: h });
    const h = 'a'.repeat(64);

    // empty dir, no lock → creates the lock
    const b1 = extendLock(dir, lockPath, [add('a.whl', h)]);
    assert.equal(b1, null);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf-8')), { 'a.whl': h });

    // same content again → no-op
    extendLock(dir, lockPath, [add('a.whl', h), add('b.whl', 'b'.repeat(64))]);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf-8')), { 'a.whl': h, 'b.whl': 'b'.repeat(64) });

    // different content for a locked wheel → refuses
    assert.throws(() => extendLock(dir, lockPath, [add('a.whl', 'c'.repeat(64))]), /different sha256/);

    // pre-existing unlocked wheels → fail closed
    const dir2 = join(dir, 'no-lock');
    mkdirSync(dir2);
    writeFileSync(join(dir2, 'old.whl'), 'bytes');
    assert.throws(() => extendLock(dir2, join(dir2, 'wheels-lock.json'), [add('new.whl', h)]), /lock:wheels/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
