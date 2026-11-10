# Custom policy preset

This example shows the two extension points of `@pyodide-sandbox/core`:

1. **Tune an existing preset** via `extraBanNames` / `extraAllowNames`.
2. **Expose your own trusted module facade** to model code via
   `exposeModules` — here a tiny `stats` helper built on `statistics`
   (preloaded via `runtime.preload`), no `import` needed by model code.

```js
// run with: node custom-preset.mjs
import { initRuntime, resolveConfig } from '@pyodide-sandbox/core';

const { config, warnings } = resolveConfig({
  runtime: {
    cacheDir: '../../pkg-cache',
    wheelsDir: './no-wheels',
    wheelsLockPath: './no-wheels/none.json',
    preload: ['pandas', 'numpy'],
    preimport: ['pandas', 'numpy', 'statistics'],
  },
  policy: {
    preset: 'general',
    extraBanNames: ['float'],           // domain rule: integers only
    exposeModules: { pd: 'pandas', np: 'numpy', stats: 'statistics' },
  },
});
for (const w of warnings) console.warn('[warn]', w);

const rt = await initRuntime(config);
const out = await rt.exec({ code: 'result = {"mean": stats.mean([1, 2, 3])}' });
console.log(JSON.stringify(out));
// {"ok":true,"result":{"mean":2},"warnings":[],"stdout":""}
process.exit(0);
```

Model code sees `pd`, `np`, `stats` — and nothing else. Adding a richer
facade (e.g. a restricted internal SDK client) means shipping your own
trusted module into the runtime and listing it in `exposeModules`.
