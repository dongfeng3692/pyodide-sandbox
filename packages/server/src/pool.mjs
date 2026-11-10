// pool.mjs — worker lifecycle: spawn, queue, hard timeout via terminate,
// recycle after N calls, on self-reported RSS pressure, or when the per-call
// state reset reports the runtime broken; boot-failure circuit breaker (no
// respawn storms). No orphans: workers are always owned by exactly one Pool.
//
// Concurrency rules (each backed by a race found in review):
//  - a `done` arriving after retire is dropped (terminating guard)
//  - a late timer never kills a worker that already moved on (pendingId check)
//  - stop() rejects queued and in-flight jobs (no promises left hanging)
//  - the recycle decision rides on `done` itself, so a recycling worker is
//    never handed the next job first
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BOOT_FAILURES = 3;

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

export class Pool {
  constructor(config, { onEvent } = {}) {
    this.config = config;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    // Workers never need the HTTP/server section; strip it so the auth token
    // never enters a worker's environment (leak surface, /proc/environ).
    const { server, state, ...workerConfig } = config;
    this.workerConfig = workerConfig;
    this.workers = new Set();
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.seq = 0;
    this.stopped = false;
    this.degraded = false;      // latched after repeated boot failures
    this.bootFailures = 0;
    this.runtimeInfo = null;    // {modules: {alias: {module, version}}} from the first ready worker
    for (let i = 0; i < config.pool.size; i += 1) this.spawn();
  }

  get stats() {
    return {
      pool: this.config.pool.size,
      live: this.workers.size,
      idle: this.idle.length,
      waiting: this.queue.length,
      pending: this.pending.size,
      degraded: this.degraded,
    };
  }

  /** stats + per-worker telemetry for the admin dashboard. */
  detail() {
    const workers = [...this.workers].map((w) => ({
      id: w.worker.threadId,
      state: w.terminating ? 'stopping' : w.busy ? 'busy' : (w.ready ? 'idle' : 'booting'),
      calls: w.calls,
      rssMb: w.metrics ? Math.round((w.metrics.rss / 1048576) * 10) / 10 : null,
      heapMb: w.metrics ? Math.round((w.metrics.heapUsed / 1048576) * 10) / 10 : null,
      eluPct: w.metrics ? Math.round(w.metrics.elu * 1000) / 10 : null,
    }));
    return { ...this.stats, workers };
  }

  spawn() {
    if (this.stopped || this.degraded) return;
    const worker = new Worker(join(HERE, 'worker.mjs'), {
      env: { ...process.env, SBX_CONFIG: JSON.stringify(this.workerConfig) },
    });
    const w = { worker, ready: false, busy: false, calls: 0, pendingId: null, timer: null, terminating: false };
    this.workers.add(w);

    const retire = () => {
      if (w.terminating) return;
      w.terminating = true;
      this.workers.delete(w);
      const idx = this.idle.indexOf(w);
      if (idx >= 0) this.idle.splice(idx, 1);
      worker.terminate().finally(() => {
        if (!this.stopped && !this.degraded) this.spawn();
        this.drain();
      });
    };
    w.retire = retire;

    worker.on('message', (m) => {
      if (m.type === 'boot_error') {
        console.error(`[sbx-pool] worker boot failed: ${m.message}`);
        this.onEvent('boot_error', m.message);
        return; // exit event below handles retire + breaker
      }
      if (m.type === 'ready') {
        this.bootFailures = 0;
        if (m.info) this.runtimeInfo = m.info; // same config → same info for every worker
        w.ready = true;
        w.busy = false;
        this.idle.push(w);
        this.drain();
      } else if (m.type === 'metrics') {
        w.metrics = { rss: m.rss, heapUsed: m.heapUsed, elu: m.elu };
      } else if (m.type === 'done') {
        if (w.terminating) return; // late done from an already-retired worker
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(w.timer);
        w.pendingId = null;
        w.calls += 1;
        w.busy = false;
        if (m.restored?.length) this.onEvent('state_restored', `job=${m.id} ${m.restored.join(',')}`);
        if (m.recycle) this.onEvent(m.recycle === 'rss' ? 'rss_recycle' : 'state_recycle', m.detail ?? '');
        // Decided in the same message: a recycling worker never gets the next job.
        const recycle = Boolean(m.recycle) || w.calls >= this.config.pool.recycleAfter;
        if (recycle) retire();
        else this.idle.push(w);
        this.drain();
        if (p) p.resolve(m.payload);
      }
    });
    worker.on('error', (err) => this.fail(w, err));
    worker.on('exit', () => {
      if (w.terminating) return;
      // boot failure path (worker exits before ever reporting ready)
      if (!w.ready) {
        this.bootFailures += 1;
        if (this.bootFailures >= MAX_BOOT_FAILURES) {
          this.degraded = true;
          console.error(`[sbx-pool] ${this.bootFailures} consecutive boot failures — pool degraded, refusing to respawn (restart after fixing configuration)`);
          this.onEvent('pool_degraded', `${this.bootFailures} consecutive boot failures`);
        }
      }
      this.fail(w, new Error(w.ready ? 'worker exited unexpectedly' : 'worker boot failed'));
    });
    return w;
  }

  fail(w, err) {
    if (w.pendingId != null) {
      const p = this.pending.get(w.pendingId);
      this.pending.delete(w.pendingId);
      clearTimeout(w.timer);
      if (p) p.reject(err);
    }
    w.retire();
  }

  drain() {
    while (this.queue.length && this.idle.length) {
      const w = this.idle.shift();
      const job = this.queue.shift();
      w.busy = true;
      w.pendingId = job.id;
      w.timer = setTimeout(() => {
        // Only act if this worker is still on THIS job — a late timer must
        // never kill a worker that already completed and moved on.
        if (w.pendingId !== job.id) return;
        const p = this.pending.get(job.id);
        this.pending.delete(job.id);
        w.pendingId = null;
        if (p) p.reject(codedError('execution_timeout'));
        this.onEvent('timeout_retire', `job=${job.id} after ${this.config.pool.execTimeoutMs}ms`);
        w.retire(); // the only way to stop a runaway WASM loop
      }, this.config.pool.execTimeoutMs);
      w.worker.postMessage(job);
    }
  }

  exec(payload) {
    if (this.degraded) return Promise.reject(codedError('pool_degraded', 'pool degraded: repeated worker boot failures'));
    if (this.queue.length >= this.config.pool.maxQueue) {
      return Promise.reject(codedError('queue_full'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, type: 'exec', ...payload });
      this.drain();
    });
  }

  /** Wait until all workers report ready (boot timeout → retire slow ones). */
  async waitReady() {
    const deadline = Date.now() + this.config.pool.bootTimeoutMs;
    while (this.workers.size < this.config.pool.size || [...this.workers].some((w) => !w.ready)) {
      if (this.degraded) throw new Error('pool_degraded');
      if (Date.now() > deadline) throw new Error('pool_boot_timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async stop() {
    this.stopped = true;
    // Reject queued jobs first, then any still in flight.
    for (const job of this.queue.splice(0)) {
      const p = this.pending.get(job.id);
      this.pending.delete(job.id);
      if (p) p.reject(codedError('shutting_down'));
    }
    for (const w of this.workers) {
      w.terminating = true;
      if (w.pendingId != null) {
        const p = this.pending.get(w.pendingId);
        this.pending.delete(w.pendingId);
        clearTimeout(w.timer);
        if (p) p.reject(codedError('shutting_down'));
      }
      await w.worker.terminate();
    }
    this.workers.clear();
    this.idle.length = 0;
  }
}
