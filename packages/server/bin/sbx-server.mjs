#!/usr/bin/env node
// sbx-server — CLI entry: --config file + env overrides → resolveConfig → serve.
import { readFileSync } from 'node:fs';
import { resolveConfig, overridesFromEnv, mergeOverrides } from '@pyodide-sandbox/core';
import { startService } from '../src/service.mjs';

// Last-resort guard: one malformed request must never take the whole service
// down (Node's default for an unhandled rejection is to exit). Routes are
// expected to handle their own errors — anything landing here is a bug.
process.on('unhandledRejection', (err) => {
  console.error('[sbx] BUG: unhandled rejection (request survived, process kept alive):', err);
});

const argv = process.argv.slice(2);
let fileOverrides = {};
const configFlag = argv.indexOf('--config');
if (configFlag >= 0 && argv[configFlag + 1]) {
  fileOverrides = JSON.parse(readFileSync(argv[configFlag + 1], 'utf-8'));
}

// env wins over file per key (documented in README); the CLI flag wins over both
const overrides = mergeOverrides(
  fileOverrides,
  overridesFromEnv(process.env),
  argv.includes('--allow-no-token') ? { server: { allowNoToken: true } } : {},
);
const { config, warnings } = resolveConfig(overrides);
for (const w of warnings) console.warn(`[sbx] ${w}`);

const { server, pool, store, storeReason, adminStatus } = await startService(config);
const addr = server.address();
console.log(`[sbx] http://${addr.address}:${addr.port} pool=${config.pool.size} preset=${config.policy.preset} timeout=${config.pool.execTimeoutMs}ms`);
const adminUrl = `http://${addr.address === '127.0.0.1' ? '127.0.0.1' : addr.address}:${addr.port}/admin`;
const admin = adminStatus();
if (admin.mode === 'setup') {
  console.log(`[sbx] admin UI: first visit initializes the account → ${adminUrl}`);
} else {
  console.log(`[sbx] admin UI: enabled (${admin.source === 'config' ? 'config-pinned credentials' : `stored account "${admin.user}"`}) → ${adminUrl}`);
}
if (store && store.countEnabledTokens() === 0) {
  console.warn(config.server.allowNoToken
    ? '[sbx] no API tokens yet — /exec is UNAUTHENTICATED (--allow-no-token); create tokens in the admin UI (Settings)'
    : '[sbx] no API tokens yet — /exec returns 401 until you create one in the admin UI (Settings)');
}
if (!store) console.warn(`[sbx] ${storeReason} (admin UI, recording and token management disabled; /exec needs --allow-no-token)`);
else console.log(`[sbx] mcp: ${store.getSetting('mcp_enabled') === '1' ? 'enabled' : 'disabled (enable at /admin/mcp)'} → POST ${adminUrl.replace('/admin', '/mcp')}`);

const shutdown = async () => {
  await pool.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
