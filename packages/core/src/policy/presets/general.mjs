// general.mjs — the default preset. Balanced surface for agent data tasks.
export const general = {
  description: 'Default: no imports, no dunder/underscore access, safe builtins, attribute-store ban, dict result contract.',
  banSyntax: ['Import', 'ImportFrom'],
  // print is allowed: stdout is captured and capped (output.stdoutMaxChars)
  banNames: [
    'open', 'exec', 'eval', 'compile', 'getattr', 'setattr', 'delattr',
    'globals', 'locals', 'vars', 'input', 'breakpoint', 'help',
    'object', 'type', 'super', 'memoryview', 'id', 'hash', 'repr', 'iter',
    'next', 'format', 'license', 'credits', 'copyright',
  ],
  attributeMode: 'deny-underscore', // also blocks every dunder attribute
  attributeWhitelist: [],
  forbidAttributeStore: true,
  denyUnderscoreNames: true,
  builtinsMode: 'safe',
  builtinsExtra: [],
  resultMustBeDict: true,
  exposeModules: { pd: 'pandas', np: 'numpy' },
};
