// mcp-tool.mjs — the `execute_code` MCP tool: definition (generated from the
// active environment), argument → job mapping, payload → tool result.
// Transport/session concerns live in mcp.mjs.
import { isPlainObject } from './http-util.mjs';

export const TOOL_NAME = 'execute_code';

const LEAD = 'Run Python code in a sandboxed Pyodide runtime (data analysis with the pre-bound '
  + 'libraries listed below) and get the `result` dict back as JSON. Read the rules below before '
  + 'writing code — code that breaks them is rejected with an error and a hint.\n\n';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'true when the code ran and `result` was returned' },
    result: { description: 'the JSON-encoded `result` value (present when ok)' },
    stdout: { type: 'string', description: 'captured print() output' },
    warnings: { type: 'array', items: { type: 'string' } },
    error: {
      type: 'object',
      description: 'present when ok is false',
      properties: {
        type: { type: 'string' },
        code: { type: 'string' },
        message: { type: 'string' },
        hint: { type: 'string', description: 'what to change in the code' },
        line: { type: ['integer', 'null'] },
        symbol: { type: ['string', 'null'] },
      },
    },
  },
  required: ['ok'],
};

/** Tool definition for tools/list; `environment` = describeEnvironment(). */
export function toolDefinition(environment) {
  return {
    name: TOOL_NAME,
    title: 'Run Python (sandboxed pandas/numpy)',
    description: LEAD + environment,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python source. Must assign the answer to a top-level `result` dict.',
        },
        files: {
          type: 'array',
          description: 'Optional input files, exposed to the code as `files[name]`. '
            + 'Give each file either `text` (UTF-8 content, e.g. CSV) or `b64` (base64 bytes, e.g. xlsx). '
            + 'Files are NOT kept between calls — send them with every call that reads them.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'file name, e.g. "sales.csv"' },
              text: { type: 'string', description: 'UTF-8 text content' },
              b64: { type: 'string', description: 'base64-encoded binary content' },
            },
            required: ['name'],
          },
        },
      },
      required: ['code'],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

function argumentError(message, hint) {
  return { ok: false, error: { type: 'invalid_arguments', message, hint } };
}

/** tools/call arguments → {job} or {error: payload}. Never throws. */
export function toJob(args) {
  if (!isPlainObject(args)) {
    return { error: argumentError('arguments must be an object', 'call execute_code with {"code": "..."}') };
  }
  if (args.files !== undefined && !Array.isArray(args.files)) {
    return { error: argumentError('`files` must be an array', 'send files as [{"name": "a.csv", "text": "..."}]') };
  }
  const files = [];
  for (const [i, f] of (args.files ?? []).entries()) {
    if (!isPlainObject(f) || typeof f.name !== 'string' || !f.name) {
      return { error: argumentError(`files[${i}] needs a string "name"`, 'each file is {"name": "a.csv", "text": "..."}') };
    }
    const hasText = typeof f.text === 'string';
    const hasB64 = typeof f.b64 === 'string';
    if (hasText === hasB64) {
      return {
        error: argumentError(`files[${i}] ("${f.name}") must have exactly one of "text" or "b64"`,
          'use "text" for CSV/JSON/plain text, "b64" for binary files such as xlsx'),
      };
    }
    files.push({ name: f.name, b64: hasB64 ? f.b64 : Buffer.from(f.text, 'utf-8').toString('base64') });
  }
  return { job: { code: args.code, files } };
}

/** What the model sees. Code-level failures (HTTP-equivalent 200) drop
 *  `retryable`: for a model it reads as "resend as-is", which fails again —
 *  the hint says what to change instead. Infra failures keep it. */
function modelView(status, payload) {
  if (payload.ok !== false || status !== 200 || !isPlainObject(payload.error)) return payload;
  const { retryable, ...error } = payload.error;
  return { ...payload, error };
}

export function toolResult(status, payload) {
  const view = modelView(status, payload);
  return {
    content: [{ type: 'text', text: JSON.stringify(view) }],
    structuredContent: view,
    isError: view.ok !== true,
  };
}
