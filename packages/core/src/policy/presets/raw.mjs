// raw.mjs — NO restrictions. For fully trusted code only; selecting this
// preset always emits a loud warning from resolveConfig()/resolvePolicy().
export const raw = {
  description: 'DANGEROUS: no syntax/name/attribute restrictions, full builtins. Trusted code only.',
  banSyntax: [],
  banNames: [],
  attributeMode: 'off',
  attributeWhitelist: [],
  forbidAttributeStore: false,
  denyUnderscoreNames: false,
  builtinsMode: 'full',
  resultMustBeDict: false,
  exposeModules: { pd: 'pandas', np: 'numpy' },
};
