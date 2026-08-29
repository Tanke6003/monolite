//
// The contracts of authentication. This is the only file an application needs
// to read in order to plug its own in: the rest of the subsystem depends on
// these interfaces and not on how the users happen to be stored.

/** A user as authentication understands it, not as the app stores it. */
export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  /** Empty is valid: a user with no roles is still an authenticated user. */
  roles: string[];
}

/** The user plus the one thing that must never leave here. */
export interface AuthUserWithSecret extends AuthUser {
  passwordHash: string;
}

/**
 * Where the users come from.
 *
 * The application implements it, and it is the piece that stops the framework
 * from imposing a table, a set of columns or an engine. It may read from the
 * database or from an array in memory: the subsystem does not care.
 *
 * What it cannot do is stand in front of a service that checks the password
 * itself. This contract hands back a hash for `AuthBLL` to compare locally, and
 * no external directory will give you one — LDAP, Nextcloud and every OIDC
 * provider verify the password on their side and answer yes or no. That case is
 * `IIdentityProvider` and `ExternalAuthBLL`, further down this file.
 */
export interface IUserProvider {
  /**
   * `null` when the user does not exist. It never throws for "not found" —
   * telling a missing user apart from a broken lookup is what lets the BLL
   * answer both cases identically on purpose (see `AuthBLL`).
   */
  findByEmail(email: string): Promise<AuthUserWithSecret | null>;
}

// ----------------------------------------------  identities kept elsewhere ---
//
// Everything from here to `Credentials` exists for the deployment where the
// password is not this application's to check: a corporate directory, a
// Nextcloud, an OIDC provider. None of them will ever hand over a hash, so the
// seam cannot be `IUserProvider` — it has to sit where the comparison happens,
// which is the BLL. `ExternalAuthBLL` is that BLL, and it needs two things the
// application supplies: something that confirms a password, and somewhere to
// keep the local account behind it.

/** What a provider knows about somebody, once it has confirmed who they are. */
export interface ExternalIdentity {
  /**
   * Their key over there — the directory's `uid`, the account name, the `sub`
   * of an OIDC token. It is stored alongside the local account so that the
   * person survives being renamed, and it is deliberately **not** what the
   * issued token carries as its subject: that stays the local id, because that
   * is what the audit columns and the permission rules read.
   */
  key: string;
  name: string;
  /** May be absent: plenty of directories do not require an address. */
  email: string | null;
  /**
   * The groups over there. Carried so they can be recorded, and so an
   * application can decide something with them if it chooses to — but the roles
   * this application enforces are this application's. See `ExternalAuthBLL` for
   * why mapping one onto the other automatically is a privilege-escalation bug
   * waiting for somebody to be added to the wrong group.
   */
  groups: string[];
}

/**
 * Whoever confirms a password this application does not store.
 *
 * One method, and the whole subtlety is in what it may answer. It is a contract
 * rather than a class because the thing behind it changes for reasons outside
 * the application: Basic auth against a directory stops working the day someone
 * turns on a second factor, and the replacement is a new class here and one
 * line in the composition root.
 */
export interface IIdentityProvider {
  /**
   * `null` when the credentials do not check out, or the account is disabled
   * over there.
   *
   * It **throws** when the provider did not answer at all, and that distinction
   * is the entire point of the method. A directory that is down is not a wrong
   * password: collapsing the two locks out everybody at once and tells each of
   * them they mistyped. `ExternalAuthBLL` reads the difference and answers a
   * 503 rather than a 401 (see `localPasswordFallback`).
   */
  verify(login: string, password: string): Promise<ExternalIdentity | null>;
}

/** The local account behind an external identity. */
export interface ExternalAuthUser extends AuthUserWithSecret {
  /**
   * The provider key this account is linked to, `null` when it never signed in
   * through one. Kept updatable rather than treated as immutable, because on
   * some providers renaming an account is deleting it and creating another.
   */
  externalKey: string | null;
  /**
   * `true` for an account that exists and must not sign in.
   *
   * Reported rather than hidden, which is the opposite of what `IUserProvider`
   * asks for, and the reason is a bug that is easy to ship: a provider that
   * answers `null` for a suspended account sends the next sign-in — which the
   * directory still accepts — down the provisioning path, and the suspension is
   * quietly undone by a brand new account. The BLL still answers a disabled
   * account exactly like a wrong password.
   */
  disabled?: boolean;
}

/**
 * Where the local accounts behind external identities live.
 *
 * It extends `IUserProvider`, so one class serves both BLLs — which is what
 * lets a composition root pick between them from configuration without a second
 * implementation, and what lets the same application fall back to a stored
 * password when the provider is unreachable.
 *
 * `passwordHash` is `""` for an account that has never had a local password,
 * and that is the normal case here: the field exists for the emergency account
 * that has to work while the directory does not.
 */
export interface IExternalUserProvider extends IUserProvider {
  findByEmail(email: string): Promise<ExternalAuthUser | null>;

  /**
   * `null` when no local account is linked to that key.
   *
   * This is the lookup that survives a rename. Somebody whose address changed
   * over there types the new one, the local lookup by email finds nothing, and
   * without this the next step would be to create a second account and orphan
   * everything the first one signed.
   */
  findByExternalKey(key: string): Promise<ExternalAuthUser | null>;

  /**
   * Creates the local account for an identity signing in for the first time.
   *
   * Called only when the provider has already confirmed the credentials, and
   * only when `autoProvision` is on. **Give it the least privilege you have.**
   * A permission too few is reported by the person themselves within minutes; a
   * permission too many is noticed by nobody.
   *
   * @param fallbackEmail the address that was typed, for a provider that did
   * not supply one. It is safe to use: the provider just confirmed the account
   * belongs to whoever typed it.
   */
  provision(identity: ExternalIdentity, fallbackEmail: string): Promise<ExternalAuthUser>;

  /**
   * Records on the local account what the provider just said about it.
   *
   * The external key and the display name, in practice. **Not the roles and not
   * the disabled flag**: those are decided here, and rewriting them on every
   * sign-in would silently undo whatever an administrator had just configured.
   * Returning the account unchanged is a valid implementation.
   */
  link(user: ExternalAuthUser, identity: ExternalIdentity): Promise<ExternalAuthUser>;
}

/**
 * How passwords are stored and checked.
 *
 * It is declared as a contract so the algorithm can change without touching
 * anything else, which is what ends up happening: what is sufficient today will
 * not be in five years.
 */
export interface IPasswordHasher {
  hash(plain: string): Promise<string>;
  /** Constant-time comparison; `false` too when the hash is unreadable. */
  verify(plain: string, hash: string): Promise<boolean>;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface AuthResult {
  token: string;
  /** Seconds the token lasts; the client decides when to renew. */
  expiresIn: number;
  user: AuthUser;
}

/**
 * The claims of a verified token.
 *
 * Nothing is guaranteed beyond it being an object: which claims a token carries
 * is the issuer's decision, and the middleware that reads them says out loud
 * which names it tries.
 */
export type TokenClaims = Record<string, unknown>;

/** A freshly signed token, together with how long it will be accepted. */
export interface SignedToken {
  token: string;
  /**
   * Lifetime in seconds. It travels alongside the token because the client
   * cannot be asked to parse the token to find out — and should not: to the
   * client the token is an opaque string.
   */
  expiresIn: number;
}

/**
 * Signing and verifying tokens.
 *
 * Generic over the payload so a caller gets its own claims back typed, instead
 * of casting a bag of `unknown` at every call site. The default implementation
 * is JWT (see `jwt.token-bll.ts`), but nothing above this interface knows
 * that: an application with opaque tokens backed by a store implements the same
 * two methods.
 */
export interface ITokenBLL {
  /**
   * Signs `payload` and reports the lifetime that was applied.
   *
   * @param expiresIn Overrides the BLL's default lifetime for this token.
   */
  sign<TPayload extends object>(payload: TPayload, expiresIn?: string | number): SignedToken;

  /**
   * Verifies the token and returns its claims. It **throws** when the token is
   * invalid, expired or not yet valid; it never returns `null`, so a caller
   * cannot forget to check.
   */
  verify<TPayload extends object = TokenClaims>(token: string): TPayload;
}

/**
 * Signing in. It is the whole of the authentication use case: everything else
 * in this package either feeds it (the user provider, the hasher) or consumes
 * what it produced (the middleware that verifies the token).
 */
export interface IAuthBLL {
  /**
   * Exchanges credentials for a token.
   *
   * @throws AppError 401 when the credentials do not check out — always the
   * same error, whatever the reason (see `AuthBLL`).
   */
  login(credentials: Credentials): Promise<AuthResult>;
}
