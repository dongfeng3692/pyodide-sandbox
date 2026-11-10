// admin-pages.test.mjs — render every admin page and check that the inlined
// client code at least parses (catches template-escaping mistakes) and that
// every i18n key referenced from markup exists in both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as pages from '../src/admin/pages.mjs';
import { I18N } from '../src/admin/i18n.mjs';

const PAGE_FNS = ['dashboardPage', 'logsPage', 'apiPage', 'mcpPage', 'settingsPage'];

test('admin pages render and their inline scripts parse', () => {
  for (const name of PAGE_FNS) {
    const html = pages[name]();
    assert.match(html, /^<!doctype html>/, name);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 2, `${name}: theme boot + app script`);
    for (const src of scripts) {
      assert.doesNotThrow(() => new Function(src), `${name}: inline script must parse`);
    }
  }
});

test('i18n keys used in page markup exist in zh and en', () => {
  for (const name of PAGE_FNS) {
    const html = pages[name]();
    const keys = [...html.matchAll(/data-i18n(?:-ph|-title)?="([^"]+)"/g)].map((m) => m[1]);
    for (const key of keys) {
      assert.ok(I18N.zh[key], `${name}: missing zh "${key}"`);
      assert.ok(I18N.en[key], `${name}: missing en "${key}"`);
    }
  }
});

test('element ids are unique on every page (page markup vs shell chrome)', () => {
  for (const name of PAGE_FNS) {
    const html = pages[name]().replace(/<script>[\s\S]*?<\/script>/g, '');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dupes, [], `${name}: duplicate ids`);
  }
});

test('zh and en define the same keys', () => {
  assert.deepEqual(Object.keys(I18N.zh).sort(), Object.keys(I18N.en).sort());
});

// Every 'ns.key' string literal in the client code / page builders whose
// namespace is an i18n namespace must exist (catches keys used in ternaries
// like T(on ? 'tok.disable' : 'tok.enable') that markup scanning misses).
test('i18n keys referenced from client code exist', () => {
  const namespaces = new Set(Object.keys(I18N.en).map((k) => k.split('.')[0]));
  const dir = new URL('../src/admin/', import.meta.url);
  const files = ['pages.mjs', 'shell.mjs', ...readdirSync(new URL('client/', dir)).map((f) => `client/${f}`)];
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const [, key] of src.matchAll(/'([a-z]+\.[a-zA-Z0-9_]+)'/g)) {
      if (!namespaces.has(key.split('.')[0])) continue;
      assert.ok(I18N.en[key], `${f}: unknown i18n key "${key}"`);
    }
  }
});
