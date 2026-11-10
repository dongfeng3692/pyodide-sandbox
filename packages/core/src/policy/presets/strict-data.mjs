// strict-data.mjs — smallest surface for table/file analysis (pandas only).
// Roadmap: per-object pandas facade (read_csv/read_excel identity binding,
// strict decoding, cell-count prechecks) layered on top of this preset.
export const strictData = {
  description: 'For untrusted model code analyzing authorized data files: general + no function/class definitions, pandas surface only.',
  banSyntax: ['Import', 'ImportFrom', 'FunctionDef', 'AsyncFunctionDef', 'ClassDef', 'Global', 'Nonlocal'],
  // print is allowed: stdout is captured and capped (output.stdoutMaxChars)
  banNames: [
    'open', 'exec', 'eval', 'compile', 'getattr', 'setattr', 'delattr',
    'globals', 'locals', 'vars', 'input', 'breakpoint', 'help',
    'object', 'type', 'super', 'memoryview', 'id', 'hash', 'repr', 'iter',
    'next', 'format', 'license', 'credits', 'copyright',
  ],
  attributeMode: 'deny-underscore',
  attributeWhitelist: [],
  forbidAttributeStore: true,
  denyUnderscoreNames: true,
  builtinsMode: 'safe',
  builtinsExtra: [],
  resultMustBeDict: true,
  exposeModules: { pd: 'pandas' },
};
