#!/usr/bin/env node
// sbx-install — install a package into the sandbox dependency manifest from
// the command line (same flow as the admin UI): resolve → download → verify
// boot → commit to the DB. Applies after the server restarts.
//   node packages/server/bin/sbx-install.mjs openpyxl
//   node packages/server/bin/sbx-install.mjs "openpyxl==3.1.5"
//   SBX_DB_PATH=/path/sbx.db SBX_WHEELS_DIR=/path/wheels node ... six
import { readFileSync } from 'node:fs';
import { resolveConfig, overridesFromEnv, mergeOverrides } from '@pyodide-sandbox/core';
import { openStore } from '../src/store.mjs';
import { createInstaller, parseSpec, route } from '../src/installer.mjs';

const spec = process.argv[2];
if (!spec) {
  console.error('usage: sbx-install <package[==version]>   (applies after a server restart)');
  process.exit(1);
}

const argv = process.argv.slice(3);
let fileOverrides = {};
const configFlag = argv.indexOf('--config');
if (configFlag >= 0 && argv[configFlag + 1]) {
  fileOverrides = JSON.parse(readFileSync(argv[configFlag + 1], 'utf-8'));
}
const overrides = mergeOverrides(fileOverrides, overridesFromEnv(process.env));
const { config, warnings } = resolveConfig(overrides);
for (const w of warnings) console.warn(`[install] ${w}`);

try {
  const parsed = parseSpec(spec);
  console.log(`[install] ${parsed.name}${parsed.version ? `==${parsed.version}` : ''} → channel: ${route(parsed.name)}`);
} catch (err) {
  console.error(`[install] ${err.message}`);
  process.exit(1);
}

const { store, reason } = await openStore(config.server.dbPath);
if (!store) {
  console.error(`[install] ${reason}`);
  process.exit(1);
}

const installer = createInstaller({ config, store, seed: config.packages ?? [] });
const { done } = installer.install(spec);
const t0 = Date.now();
await done;
const job = installer.status();
if (job.phase === 'error') {
  console.error(`[install] FAILED after ${Math.round((Date.now() - t0) / 1000)}s: ${job.error}`);
  console.error('[install] the manifest and wheels/ are unchanged (rolled back).');
  store.close();
  process.exit(1);
}
console.log(`[install] done in ${Math.round((Date.now() - t0) / 1000)}s — "${job.name}" committed to the manifest.`);
console.log('[install] RESTART the server to apply (the MCP tool description updates automatically).');
store.close();
process.exit(0);
