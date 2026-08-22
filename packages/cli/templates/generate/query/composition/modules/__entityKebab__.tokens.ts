/**
 * DI identifiers for the __entityKebab__ query.
 *
 * There is no `store` here, and that is the difference between this and an
 * entity module: a query owns no table. It reads ones that already exist, whose
 * stores are registered by their own modules and injected by the repository
 * below under *their* tokens.
 *
 * Like every generated tokens file, this one lives apart from the module that
 * registers them: the BLL and the controller need them too, and importing
 * them from the module file — which imports the BLL and the controller —
 * would close a cycle.
 */
export const __entityUpper___TOKENS = {
  repository: "I__entityName__Repository",
  bll: "I__entityName__BLL",
  controller: "I__entityName__Controller",
} as const;
