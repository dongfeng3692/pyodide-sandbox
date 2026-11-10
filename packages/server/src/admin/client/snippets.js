// admin/client/snippets.js — copy-paste examples, built from the page origin
// so they work as-is against this server. Shared by API, MCP and Settings.

const SNIP_CODE = 'result = {"n": 6 * 7}';
const TOKEN_PLACEHOLDER = '<your-token>';

function curlSnippet(token = TOKEN_PLACEHOLDER) {
  return [
    'curl -X POST ' + location.origin + '/exec \\',
    '  -H "x-sbx-token: ' + token + '" \\',
    '  -H "content-type: application/json" \\',
    "  -d '" + JSON.stringify({ code: SNIP_CODE }) + "'",
  ].join('\n');
}

function pythonSnippet(token = TOKEN_PLACEHOLDER) {
  return [
    'from sbx_client import SbxClient',
    '',
    'sbx = SbxClient("' + location.origin + '", token="' + token + '")',
    'out = sbx.execute(' + JSON.stringify(SNIP_CODE) + ')',
    'print(out["result"])  # {"n": 42}',
  ].join('\n');
}

function jsSnippet(token = TOKEN_PLACEHOLDER) {
  return [
    "const res = await fetch('" + location.origin + "/exec', {",
    "  method: 'POST',",
    "  headers: { 'x-sbx-token': '" + token + "', 'content-type': 'application/json' },",
    '  body: JSON.stringify({ code: ' + JSON.stringify(SNIP_CODE) + ' }),',
    '});',
    'const out = await res.json(); // { ok, result, stdout, warnings }',
  ].join('\n');
}

function execSnippetTabs(token) {
  return [
    { label: 'curl', code: curlSnippet(token) },
    { label: 'Python', code: pythonSnippet(token) },
    { label: 'JavaScript', code: jsSnippet(token) },
  ];
}

function mcpConfigSnippet(token = TOKEN_PLACEHOLDER) {
  return JSON.stringify({
    mcpServers: {
      'pyodide-sandbox': {
        type: 'http',
        url: location.origin + '/mcp',
        headers: { Authorization: 'Bearer ' + token },
      },
    },
  }, null, 2);
}

function claudeCodeSnippet(token = TOKEN_PLACEHOLDER) {
  return 'claude mcp add --transport http pyodide-sandbox ' + location.origin + '/mcp \\\n' +
    '  --header "Authorization: Bearer ' + token + '"';
}

function mcpCurlSnippet(token = TOKEN_PLACEHOLDER) {
  const url = location.origin + '/mcp';
  const head = (extra) => [
    'curl -X POST ' + url + ' \\',
    '  -H "authorization: Bearer ' + token + '" \\',
    ...extra,
    '  -H "content-type: application/json" \\',
  ];
  return [
    '# 1) initialize — the response carries an mcp-session-id header',
    ...head([]),
    "  -d '" + JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'demo', version: '1.0' } },
    }) + "'",
    '',
    '# 2) call the tool with that session id',
    ...head(['  -H "mcp-session-id: <session-id>" \\']),
    "  -d '" + JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'execute_code', arguments: { code: SNIP_CODE } },
    }) + "'",
  ].join('\n');
}
