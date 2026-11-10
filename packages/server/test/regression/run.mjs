// run.mjs — regression suite runner.
//
//   node packages/server/test/regression/run.mjs                # full suite
//   node packages/server/test/regression/run.mjs --filter POL   # one group / id prefix
//   node packages/server/test/regression/run.mjs --list
//
// Cases run sequentially in declaration order (they share profile state, e.g.
// AUTH creates the tokens EXEC/POL reuse). A failing case does not stop the
// run; the exit code is non-zero if anything failed. Case IDs are stable
// contract references — never reuse a retired ID (see README.md).
import { boot, makeCtx, teardown, PATCHES } from './harness.mjs';
import infra from './cases/infra.mjs';
import auth from './cases/auth.mjs';
import validation from './cases/validation.mjs';
import execution from './cases/execution.mjs';
import policy from './cases/policy.mjs';
import presets from './cases/presets.mjs';
import limits from './cases/limits.mjs';
import admin from './cases/admin.mjs';
import persistence from './cases/persistence.mjs';
import security from './cases/security.mjs';
import mcp from './cases/mcp.mjs';
import agent from './cases/agent.mjs';
import packages from './cases/packages.mjs';

const FILES = [
  infra, auth, validation, execution, policy, presets,
  limits, admin, persistence, security, agent, packages, mcp,
];

const CASE_TIMEOUT_MS = 60_000;

const all = FILES.flat();
// --- registry validation: stable IDs, known profiles, no duplicates
{
  const seen = new Set();
  for (const c of all) {
    if (!/^[A-Z]+-\d{3}$/.test(c.id ?? '')) throw new Error(`bad case id: ${JSON.stringify(c.id)} (${c.title})`);
    if (seen.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
    seen.add(c.id);
    if (!(c.profile in PATCHES)) throw new Error(`${c.id}: unknown profile ${c.profile}`);
    if (typeof c.run !== 'function') throw new Error(`${c.id}: missing run()`);
  }
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const filterIdx = args.indexOf('--filter');
const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;
if (filter !== null && !filter) throw new Error('--filter needs a value (group name or id prefix)');

const selected = filter
  ? all.filter((c) => c.id.startsWith(filter.toUpperCase()) || c.id === filter.toUpperCase())
  : all;

if (listOnly) {
  for (const c of selected) console.log(`${c.id}  ${c.profile.padEnd(8)} ${c.skip ? '[SKIP] ' : ''}${c.title}`);
  console.log(`\n${selected.length} case(s)`);
  process.exit(0); // list mode: nothing was booted or run
}

const results = [];
const t0 = performance.now();

let currentGroup = null;
for (const c of selected) {
  const group = c.id.split('-')[0];
  if (group !== currentGroup) {
    if (currentGroup !== null) console.log('');
    console.log(`== ${group} ==`);
    currentGroup = group;
  }
  if (c.skip) {
    results.push({ c, status: 'skip', ms: 0, err: new Error(c.skip) });
    console.log(`[SKIP] ${c.id} ${c.title} — ${c.skip}`);
    continue;
  }
  let p;
  try {
    p = await boot(c.profile); // outside the case timer: boot cost is not case cost
  } catch (err) {
    results.push({ c, status: 'fail', ms: 0, err });
    console.log(`[FAIL] ${c.id} ${c.title} (boot)\n       ${String(err?.message ?? err).split('\n')[0]}`);
    continue;
  }
  const started = performance.now();
  try {
    const ctx = makeCtx(p, c);
    const timer = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`case timed out after ${CASE_TIMEOUT_MS}ms`)), CASE_TIMEOUT_MS);
    });
    await Promise.race([c.run(ctx), timer]);
    const ms = Math.round(performance.now() - started);
    results.push({ c, status: 'pass', ms });
    console.log(`[PASS] ${c.id} ${c.title} (${ms}ms)`);
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    results.push({ c, status: 'fail', ms, err });
    const first = String(err?.message ?? err).split('\n')[0];
    console.log(`[FAIL] ${c.id} ${c.title} (${ms}ms)\n       ${first}`);
  }
}

await teardown();

// --- summary ---
console.log('\n' + '='.repeat(64));
const byGroup = new Map();
for (const r of results) {
  const g = r.c.id.split('-')[0];
  const cur = byGroup.get(g) ?? { pass: 0, fail: 0, skip: 0 };
  cur[r.status] += 1;
  byGroup.set(g, cur);
}
for (const [g, n] of byGroup) console.log(`${g.padEnd(8)} ${n.pass} pass · ${n.fail} fail · ${n.skip} skip`);
const passed = results.filter((r) => r.status === 'pass').length;
const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skip').length;
console.log('-'.repeat(64));
console.log(`Regression: ${passed}/${results.length} passed` +
  (skipped ? `, ${skipped} skipped` : '') +
  ` · ${((performance.now() - t0) / 1000).toFixed(1)}s`);

if (skipped) {
  console.log('\nskipped cases:');
  for (const r of results.filter((x) => x.status === 'skip')) console.log(`  ${r.c.id} ${r.c.title} — ${r.skip}`);
}
if (failed.length) {
  console.log('\nfailures:');
  for (const r of failed) {
    console.log(`\n  ${r.c.id} ${r.c.title}`);
    console.log(String(r.err?.stack ?? r.err).split('\n').slice(0, 6).map((l) => `    ${l}`).join('\n'));
  }
  process.exitCode = 1;
}
