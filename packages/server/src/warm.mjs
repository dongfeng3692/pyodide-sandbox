// warm.mjs — pre-populate the Pyodide package cache (pkg-cache/) so the
// server/e2e start fully offline afterwards. Run ONCE on a machine with
// network access (or via proxy):
//   node packages/server/src/warm.mjs
//   SBX_CACHE_DIR=/var/cache/sbx node packages/server/src/warm.mjs
// Proxy on Node >= 24: NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://... node ...
import { resolveConfig, overridesFromEnv, initRuntime } from '@pyodide-sandbox/core';

const { config, warnings } = resolveConfig(overridesFromEnv(process.env));
for (const w of warnings) console.warn(`[warm] ${w}`);

const rt = await initRuntime(config);
const info = rt.py.runPython(
  'import sys\nmods = {m: __import__(m).__version__ for m in ["pandas", "numpy"] if __import__("importlib").util.find_spec(m)}\n'
  + 'f"python={sys.version.split()[0]} " + " ".join(f"{k}={v}" for k, v in mods.items())',
);
console.log(`[warm] OK: ${info}`);
console.log(`[warm] cache populated at: ${config.runtime.cacheDir}`);
process.exit(0);
