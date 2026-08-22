/**
 * Identifiers under which every framework-level dependency is registered and
 * injected.
 *
 * tsyringe resolves by string, so a typo in an `@inject("ILoger")` compiles
 * without complaining and blows up while building the object graph, with the
 * process already running. Going through this table always means the compiler
 * sees the typo and the editor completes the name.
 *
 * Key and value are identical on purpose: the value is the one the
 * registrations and the tests use, and keeping it identical means you can still
 * grep for "ILogger" and find at a glance where it is registered and where it
 * is injected.
 *
 * Only the framework's own contracts live here. The tokens of a feature —its
 * service, its repository, its controller— belong to the application that owns
 * that feature: this package cannot know them, and hosting them here would make
 * every consumer inherit a vocabulary of entities it does not have. An
 * application declares its own table and uses both, side by side.
 */
export const TOKENS = {
  // ---------------------------------------------------------------- plugins --
  /** Configuration source; see `IEnvs`. */
  IEnvs: "IEnvs",
  ILogger: "ILogger",
  IRequestContext: "IRequestContext",
  /** Transaction in progress; the unit of work publishes it. */
  ITransactionContext: "ITransactionContext",
  IHealthProbe: "IHealthProbe",
  /** Issues and verifies access tokens. Implemented outside this package. */
  ITokenBLL: "ITokenBLL",
  IFileStorage: "IFileStorage",

  // ------------------------------------------------------------ persistence --
  /**
   * Connector of the active engine. Registered only by applications that need
   * to reach the driver directly —a stored procedure, a diagnostic query—;
   * everything that goes through the generic repository never sees it.
   */
  IDbPlugin: "IDbPlugin",
  IUnitOfWork: "IUnitOfWork",
  /** Change log the generic repositories write to after every write. */
  IAuditTrail: "IAuditTrail",
  /**
   * Generic repository over the change-log entity. Read-only from the
   * application: it is written by the repositories themselves.
   */
  IAuditLogStore: "IAuditLogStore",
} as const;

/** Any of the identifiers above. */
export type Token = (typeof TOKENS)[keyof typeof TOKENS];

/** The name of any of the identifiers above. */
export type TokenName = keyof typeof TOKENS;

/**
 * Token under which the generic repository of an entity is registered.
 *
 * A *store* is the generic repository already mounted on the active engine; a
 * feature's own repository receives it and adds its own logic on top. The
 * convention is the entity name plus the `Store` suffix —`USERS` becomes
 * `USERSStore`— and it is only a default: a registration may name its own token
 * so an application can keep the spelling its feature modules already inject.
 */
export function storeToken(entity: string): string {
  return `${entity}Store`;
}
