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
 * where they are registered, because the service and the controller need them
 * too — and importing them from the module file, which imports the service and
 * the controller, would close a cycle.
 */
export const __entityUpper___TOKENS = {
  /** The generic repository for this entity, already bound to the active engine. */
  store: "__storeToken__",
  service: "__serviceToken__",
  controller: "__controllerToken__",
} as const;
