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
 * database, from an LDAP directory or from an array in memory: the subsystem
 * does not care.
 */
export interface IUserProvider {
  /**
   * `null` when the user does not exist. It never throws for "not found" —
   * telling a missing user apart from a broken lookup is what lets the service
   * answer both cases identically on purpose (see `AuthService`).
   */
  findByEmail(email: string): Promise<AuthUserWithSecret | null>;
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
 * is JWT (see `jwt.token-service.ts`), but nothing above this interface knows
 * that: an application with opaque tokens backed by a store implements the same
 * two methods.
 */
export interface ITokenService {
  /**
   * Signs `payload` and reports the lifetime that was applied.
   *
   * @param expiresIn Overrides the service's default lifetime for this token.
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
export interface IAuthService {
  /**
   * Exchanges credentials for a token.
   *
   * @throws AppError 401 when the credentials do not check out — always the
   * same error, whatever the reason (see `AuthService`).
   */
  login(credentials: Credentials): Promise<AuthResult>;
}
