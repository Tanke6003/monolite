/**
 * DI identifiers for the __entityKebab__ module.
 *
 * They live in their own file, and not in a central table, for one practical
 * reason: `monolite generate module` must never rewrite a file you wrote. A
 * shared table would have to be reopened and appended to on every generation,
 * which is exactly how a generator starts corrupting hand-written code.
 *
 * The framework's own identifiers —logger, request context, unit of work— are
 * not here either: they come from `TOKENS` in `monolite-di`, and this table
 * holds only what belongs to this module.
 *
 * They also live *outside* `__entityKebab__.module.ts`, even though that is
 * where they are registered, because the BLL and the controller need them
 * too — and importing them from the module file, which imports the BLL and
 * the controller, would close a cycle.
 */
export const __entityUpper___TOKENS = {
  /** The generic repository for this entity, already bound to the active engine. */
  store: "__storeToken__",
  bll: "__bllToken__",
  /**
   * This module's own repository, if it has one.
   *
   * Nothing registers it until `monolite generate repository __entityKebab__`
   * has been run — an entity gets a working repository from its mapping alone,
   * and most modules never need more. The name is declared here anyway so that
   * the generator can add the binding without reopening this file.
   */
  repository: "__repositoryToken__",
  controller: "__controllerToken__",
} as const;
