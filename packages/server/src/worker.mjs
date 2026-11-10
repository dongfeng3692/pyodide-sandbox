// worker.mjs — one hardened Pyodide runtime per worker thread.
// Talks to pool.mjs via {type:'ready'|'done'|'metrics'|'boot_error', ...}.
// `done` carries `recycle` (null | 'rss' | 'state') so the pool decides in
// the same message whether this worker may take another job — a separate
// follow-up message could arrive after the pool already dispatched one.
import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { initRuntime } from '@pyodide-sandbox/core';

const cfg = JSON.parse(process.env.SBX_CONFIG ?? '{}');
let rt = null;

// Telemetry for the admin dashboard: RSS/heap + event-loop utilization
// (deltas over the report interval; ~1.0 == this thread was never idle).
let lastElu = performance.eventLoopUtilization();
setInterval(() => {
  const elu = performance.eventLoopUtilization(lastElu);
  lastElu = performance.eventLoopUtilization();
  const mem = process.memoryUsage();
  parentPort.postMessage({ type: 'metrics', rss: mem.rss, heapUsed: mem.heapUsed, elu: elu.utilization });
}, 2000).unref();

initRuntime(cfg)
  .then((runtime) => {
    rt = runtime;
    parentPort.postMessage({ type: 'ready', info: runtime.info });
  })
  .catch((err) => {
    // Tell the pool WHY (it counts failures and trips a breaker), then die.
    parentPort.postMessage({ type: 'boot_error', message: String(err?.message ?? err).slice(0, 300) });
    process.exit(1);
  });

function recycleReason(health) {
  if (health?.broken) return { recycle: 'state', detail: health.broken };
  // Self-imposed memory recycle: cheaper than an OOM inside the host.
  const rss = process.memoryUsage().rss;
  if (cfg.pool?.rssLimitMb && rss > cfg.pool.rssLimitMb * 1024 * 1024) return { recycle: 'rss', detail: `rss=${rss}` };
  return { recycle: null, detail: null };
}

parentPort.on('message', async (msg) => {
  if (msg.type !== 'exec') return;
  try {
    const { payload, health } = await rt.run({ code: msg.code, files: msg.files });
    parentPort.postMessage({
      type: 'done', id: msg.id, payload, restored: health?.restored ?? [], ...recycleReason(health),
    });
  } catch (exc) {
    // The runtime itself threw (not user code): its state is unknown — recycle.
    parentPort.postMessage({
      type: 'done', id: msg.id, recycle: 'state', detail: 'runtime_error', restored: [],
      payload: { ok: false, error: { type: 'worker_error', message: String(exc).slice(0, 300), retryable: false } },
    });
  }
});
