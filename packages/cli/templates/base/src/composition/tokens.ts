/**
 * Identifiers the container registers and injects the framework-level services
 * under.
 *
 * tsyringe resolves by string, so a typo in `@inject("ILoggr")` compiles
 * happily and blows up when the class is constructed — which, for a controller,
 * is at startup, and for anything lazier is in production. Going through this
 * table means the compiler sees the typo and the editor completes the name.
 *
 * A feature module does not add anything here: it brings its own small table
 * (`composition/modules/<name>.tokens.ts`) so that `monolite generate module`
 * never has to edit a file you wrote.
 */
export const TOKENS = {
  ILogger: "ILogger",
  IRequestContext: "IRequestContext",
  IHealthProbe: "IHealthProbe",
  /** The persistence layer, from which every module takes its repository. */
  DataSource: "DataSource",
} as const;

export type Token = (typeof TOKENS)[keyof typeof TOKENS];
