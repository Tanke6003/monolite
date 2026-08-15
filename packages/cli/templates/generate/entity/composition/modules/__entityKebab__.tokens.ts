/**
 * DI identifiers for the __entityKebab__ module.
 *
 * They live in their own file, and not in `composition/tokens.ts`, for one
 * practical reason: `monolite generate module` must never edit a file you
 * wrote. A central table would have to be reopened and appended to on every
 * generation, which is exactly how a generator starts corrupting hand-written
 * code.
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
