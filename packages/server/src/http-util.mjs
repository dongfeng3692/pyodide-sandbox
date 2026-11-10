// http-util.mjs — request-body reading shared by every route (/exec, /mcp,
// admin API). One implementation, so every caller gets the same limits and
// the same oversize semantics.

/**
 * Read a request body as UTF-8, capped at `maxBytes`.
 * Resolves (never rejects) to `{ ok, text }`. On overflow the socket is
 * destroyed — the client sees a reset rather than a 4xx (frozen contract:
 * INFRA-006). `ok: false` (oversize or client abort) means nobody is
 * listening any more: the caller must stop processing and not respond.
 */
export function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        finish({ ok: false, text: '' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf-8') }));
    req.on('error', () => finish({ ok: false, text: '' }));
  });
}

/** Parse JSON, returning `undefined` (never throwing) on malformed input. */
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
