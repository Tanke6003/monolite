import { tokensFor } from "monolite-di";

/**
 * DI identifiers for the __entityKebab__ module:
 *
 *   store       "__storeToken__"       the generic repository, bound to the active engine
 *   bll         "__bllToken__"
 *   repository  "__repositoryToken__"  registered once `monolite generate repository __entityKebab__` has run
 *   controller  "__controllerToken__"
 *
 * Derived from the entity name rather than spelled out, so the four cannot
 * disagree with each other. To rename one, spread and override:
 * `{ ...tokensFor("__entityName__"), bll: "OtherName" } as const`.
 *
 * They live in their own file, and not in a central table, because
 * `monolite generate module` must never rewrite a file you wrote. And they
 * live *outside* `__entityKebab__.module.ts` because the BLL and the controller
 * import them too — importing them from the module file, which imports the BLL
 * and the controller, would close a cycle.
 */
export const __entityUpper___TOKENS = tokensFor("__entityName__");
