// classify.mjs — failure classification for the admin dashboard (D12).
//
// Classes are DERIVED AT READ TIME from the persisted executions row
// (ok / error_type / error_code) — no schema change, no backfill: rows
// written before this feature existed classify exactly like new ones, so the
// dashboard never shows a semantics gap across the change.
//
//   blocked — rejected before execution, by design: policy AST rejections
//             (PolicyError) and pre-execution request validation. The
//             sandbox working as intended — not a service problem.
//   model   — the code ran and failed: runtime exceptions, result-contract
//             violations (result_must_be_dict / result_too_large), timeouts.
//             The caller/model side of the story.
//   system  — the serving infrastructure failed (pool/worker/boot). Needs
//             ops attention; unknown failure shapes also land here so they
//             surface instead of hiding as "normal".

export const FAIL_CLASSES = ['blocked', 'model', 'system'];

// error_type values meaning "the infrastructure, not the code, failed".
// Emitted by pool.codedError() and the service/pool catch-alls — extend this
// list together with the parity test in classify.test.mjs.
export const SYSTEM_TYPES = [
  'queue_full', 'pool_degraded', 'shutting_down', 'execution_unavailable', 'worker_error',
];

// error_type values meaning "rejected before execution, caller-side".
// 'validation' is the legacy blanket value from before real-type recording.
const INVALID_TYPES = [
  'validation', 'invalid_code', 'invalid_files', 'too_many_files', 'file_too_large', 'invalid_json',
];

/**
 * Classify an execution record. Accepts camelCase recorder fields
 * ({ok, errorType}) and snake_case DB rows ({ok, error_type}).
 * Returns null for successful executions.
 */
export function classifyFailure(rec) {
  if (rec.ok) return null;
  const t = rec.errorType ?? rec.error_type;
  if (t === 'PolicyError' || INVALID_TYPES.includes(t)) return 'blocked';
  if (t == null || SYSTEM_TYPES.includes(t)) return 'system';
  return 'model'; // open set: code-level exception class names (incl. execution_timeout)
}

/**
 * SQL predicate over the executions table for one class — built from the
 * same constants as classifyFailure so the logs filters can never drift
 * from the classifier.
 */
export function classWhere(cls) {
  const list = (xs) => xs.map((x) => `'${x}'`).join(',');
  const blocked = `(error_type = 'PolicyError' OR error_type IN (${list(INVALID_TYPES)}))`;
  const system = `error_type IN (${list(SYSTEM_TYPES)})`;
  if (cls === 'blocked') return blocked;
  if (cls === 'system') return system;
  if (cls === 'model') return `ok = 0 AND NOT (${blocked} OR ${system})`;
  return '';
}
