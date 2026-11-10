// make-wheels-lock.mjs — snapshot wheels/ into a sha256 lock file.
// Run after (re)downloading vendored wheels: `npm run lock:wheels -w @pyodide-sandbox/server`
// At boot, initRuntime verifies the directory against this lock (supply chain tripwire).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.env.SBX_WHEELS_DIR ?? './wheels');
if (!existsSync(dir)) {
  console.error(`wheels dir not found: ${dir}`);
  process.exit(1);
}
const lock = {};
for (const f of readdirSync(dir).filter((n) => n.endsWith('.whl')).sort()) {
  lock[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
}
const out = join(dir, 'wheels-lock.json');
writeFileSync(out, JSON.stringify(lock, null, 2) + '\n');
console.log(`wrote ${out} (${Object.keys(lock).length} wheels)`);
