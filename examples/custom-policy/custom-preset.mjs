// custom-preset.mjs — runnable example: tune a preset + expose your own module.
// Run from anywhere: node examples/custom-policy/custom-preset.mjs
import { initRuntime, resolveConfig } from '@pyodide-sandbox/core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { config, warnings } = resolveConfig({
  runtime: {
    cacheDir: join(ROOT, 'pkg-cache'),          // absolute: no cwd surprises
    wheelsDir: join(ROOT, 'no-wheels'),
    wheelsLockPath: join(ROOT, 'no-wheels', 'none.json'),
    preload: ['pandas', 'numpy'],
    preimport: ['pandas', 'numpy', 'statistics'],
  },
  policy: {
    preset: 'general',
    extraBanNames: ['float'],                    // domain rule: integers only
    exposeModules: { pd: 'pandas', np: 'numpy', stats: 'statistics' },
  },
});
for (const w of warnings) console.warn('[warn]', w);

const rt = await initRuntime(config);
const out = await rt.exec({ code: 'result = {"mean": stats.mean([1, 2, 3])}' });
console.log(JSON.stringify(out));
// {"ok":true,"result":{"mean":2},"warnings":[],"stdout":""}
process.exit(0);
