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

type Vowel = "a" | "e" | "i" | "o" | "u" | "A" | "E" | "I" | "O" | "U";
type Sibilant = "s" | "x" | "z" | "ch" | "sh" | "S" | "X" | "Z" | "Ch" | "cH" | "CH" | "Sh" | "sH" | "SH";

/**
 * The plural `tokensFor` applies, as a type.
 *
 * It mirrors the runtime rule letter for letter —consonant plus `y` becomes
 * `ies`, a sibilant takes `es`, anything else takes `s`— because the point of
 * the helper is that `PAYMENT_TOKENS.bll` stays the literal `"IPaymentsBLL"`
 * and not `string`. A token typed as `string` still compiles in `@inject()`,
 * which is precisely how a typo gets past the compiler.
 */
export type Plural<N extends string> = N extends `${infer Head}${"y" | "Y"}`
  ? Head extends "" | `${string}${Vowel}`
    ? `${N}s`
    : `${Head}ies`
  : N extends `${string}${Sibilant}`
    ? `${N}es`
    : `${N}s`;

/** What `tokensFor` returns for an entity called `N`. */
export interface ModuleTokens<N extends string> {
  /** The generic repository for the entity, already bound to the active engine. */
  readonly store: `${Plural<N>}Store`;
  readonly bll: `I${Plural<N>}BLL`;
  /**
   * The module's own repository, if it has one. Nothing registers it until
   * `monolite generate repository` has been run; the name exists anyway so the
   * generator can add the binding without reopening the tokens file.
   */
  readonly repository: `I${Plural<N>}Repository`;
  readonly controller: `I${Plural<N>}Controller`;
}

/**
 * The four DI identifiers of a feature module, derived from its entity name.
 *
 * Every generated module used to transcribe them by hand —`"PaymentsStore"`,
 * `"IPaymentsBLL"`, `"IPaymentsRepository"`, `"IPaymentsController"`— and four
 * strings that must agree with each other are four chances to end up with
 * `IPaymentServiceBLL` in one place and `IPaymentsBLL` in another: a mismatch
 * nobody hears about until the container fails to resolve at start-up.
 *
 * `name` is the entity's singular PascalCase name, the one the generator
 * already uses for the class (`Payment`, `InvoiceLine`). It is pluralised with
 * the CLI's own naive English rule and otherwise taken as given, like
 * `storeToken`: the caller's spelling is the one its modules inject.
 *
 * A module that wants a different name for one of them spreads and overrides:
 *
 * ```ts
 * export const PAYMENT_TOKENS = { ...tokensFor("Payment"), bll: "LegacyPaymentsService" } as const;
 * ```
 */
export function tokensFor<const N extends string>(name: N): ModuleTokens<N> {
  const plural = pluralize(name);

  return Object.freeze({
    store: `${plural}Store`,
    bll: `I${plural}BLL`,
    repository: `I${plural}Repository`,
    controller: `I${plural}Controller`,
  }) as ModuleTokens<N>;
}

/**
 * The same three rules as `pluralize` in `monolite-cli`.
 *
 * Duplicated rather than shared because the CLI deliberately depends on no
 * package of this monorepo. The two are held together by a test in the CLI that
 * compares `tokensFor` against the names the generator writes.
 */
function pluralize(raw: string): string {
  if (/[^aeiou]y$/i.test(raw)) return `${raw.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(raw)) return `${raw}es`;
  return `${raw}s`;
}
