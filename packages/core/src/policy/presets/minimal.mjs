// minimal.mjs — arithmetic/logic snippets only. No modules exposed.
export const minimal = {
  description: 'Pure computation: no imports, no defs (incl. lambda), no modules, smallest builtin set.',
  banSyntax: ['Import', 'ImportFrom', 'FunctionDef', 'AsyncFunctionDef', 'ClassDef', 'Lambda', 'Global', 'Nonlocal'],
  banNames: [
    'open', 'exec', 'eval', 'compile', 'getattr', 'setattr', 'delattr',
    'globals', 'locals', 'vars', 'input', 'breakpoint', 'print', 'help',
    'object', 'type', 'super', 'memoryview', 'id', 'hash', 'repr', 'iter',
    'next', 'format', 'license', 'credits', 'copyright', 'float', 'set',
    'frozenset', 'bytes', 'bytearray', 'complex',
  ],
  attributeMode: 'deny-underscore',
  attributeWhitelist: [],
  forbidAttributeStore: true,
  denyUnderscoreNames: true,
  builtinsMode: 'safe',
  builtinsExtra: [],
  resultMustBeDict: true,
  exposeModules: {},
};
