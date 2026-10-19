import { randomBytes } from "node:crypto";
import { AppError } from "monolite-core";
import type {
  AuthResult,
  AuthUser,
  Credentials,
  IAuthBLL,
  IPasswordHasher,
  ITokenBLL,
  ITokenRevocation,
  IUserProvider,
  TokenClaims,
} from "./contracts.js";

export interface AuthBLLOptions {
  /** Lifetime of the issued token. Falls back to the token BLL's default. */
  expiresIn?: string | number;
  /**
   * Hash to check the password against when the email is unknown.
   *
   * There is a sensible default (see `dummyHash`), and supplying one is only
   * worth it when the very first failed login of a process must cost exactly
   * what a successful one costs.
   */
  dummyPasswordHash?: string;
  /**
   * Where `logout` withdraws tokens. The same instance `requireAuth` reads,
   * or signing out is recorded somewhere nobody looks.
   */
  revocation?: ITokenRevocation;
}

/**
 * The one error a failed login produces.
 *
 * "That email does not exist" and "that password is wrong" are answered
 * identically, with the same code and the same status. Telling them apart turns
 * the login form into a lookup service: an attacker submits a list of addresses
 * with a junk password and walks away knowing which ones are registered. That
 * matters on its own — knowing somebody has an account somewhere is often the
 * sensitive part — and it also halves the work of the attack that follows,
 * because guessing passwords is only worth doing against addresses known to
 * exist.
 */
function invalidCredentials(): AppError {
  return new AppError("Invalid email or password", 401, true, {
    code: "INVALID_CREDENTIALS",
  });
}

/**
 * Signing in: find the user, check the password, hand back a token.
 *
 * It knows nothing about where users are stored, how passwords are hashed or
 * what a token is made of — those are the three interfaces it is constructed
 * with. That is what lets the same BLL sit on top of a SQL table, an LDAP
 * directory or a fixture array in a test.
 */
export class AuthBLL implements IAuthBLL {
  /** Memoised; see `dummyHash`. */
  private dummy?: Promise<string>;

  constructor(
    private readonly users: IUserProvider,
    private readonly hasher: IPasswordHasher,
    private readonly tokens: ITokenBLL,
    private readonly options: AuthBLLOptions = {}
  ) {}

  async login(credentials: Credentials): Promise<AuthResult> {
    // Normalised here rather than in the route schema so it holds however the
    // BLL is called. Addresses are case-insensitive in practice, and a user
    // who registered as "Ana@example.com" will type "ana@example.com" sooner or
    // later; providers can therefore store and look up lower-cased.
    const email = credentials.email.trim().toLowerCase();
    const user = await this.users.findByEmail(email);

    // The verification runs even when there is no such user, against a throwaway
    // hash. Answering with the same message is not enough on its own: skipping
    // the hash would make the "unknown email" answer arrive in a millisecond
    // and the "wrong password" answer in the hundred that scrypt deliberately
    // costs, and that difference is measurable over a network. The timing has
    // to lie as convincingly as the message does.
    const storedHash = user?.passwordHash ? user.passwordHash : await this.dummyHash();
    const passwordMatches = await this.hasher.verify(credentials.password, storedHash);

    // A user with no stored hash — an account that only ever signed in through
    // an external provider — took the dummy path above and fails here, which is
    // right: there is no password to accept.
    if (!user || !passwordMatches) throw invalidCredentials();

    // `sub` is the standard subject claim: it is what the request context reads
    // to fill the audit columns and what any rule that depends on *who* is
    // asking must use. The name can change; the id cannot.
    const { token, expiresIn } = this.tokens.sign(
      { sub: user.id, name: user.name, email: user.email, roles: user.roles },
      this.options.expiresIn
    );

    return { token, expiresIn, user: publicUser(user) };
  }

  async logout(claims: TokenClaims): Promise<void> {
    const revocation = this.options.revocation;

    // 501 rather than a quiet success: a client told it signed out would throw
    // away a token that still works for whoever else has a copy.
    if (!revocation) {
      throw new AppError("Signing out is not configured on this server", 501, true, {
        code: "LOGOUT_UNAVAILABLE",
      });
    }

    // Tokens signed before `jti` was added to every token have nothing to be
    // revoked by. They expire on their own within one token lifetime of the
    // upgrade; until then the client is told the truth.
    if (typeof claims.jti !== "string" || claims.jti.length === 0) {
      throw new AppError("This token cannot be revoked", 400, true, {
        code: "TOKEN_NOT_REVOCABLE",
      });
    }

    await revocation.revoke(claims);
  }

  /**
   * A hash of a password nobody knows, used to burn the same time a real check
   * would when the email does not exist.
   *
   * It is produced by the injected hasher, not written as a constant, because
   * the constant would be in scrypt's format: hand it to an argon2 hasher and
   * verification fails at the parse step, in microseconds, which is precisely
   * the timing signal this is here to remove.
   *
   * It is built once and reused. The first failed login of a process pays for
   * an extra derivation; `dummyPasswordHash` is the way out for a deployment
   * where even that first request must not stand out.
   */
  private dummyHash(): Promise<string> {
    const configured = this.options.dummyPasswordHash;
    if (configured) return Promise.resolve(configured);

    this.dummy ??= this.hasher.hash(randomBytes(32).toString("hex"));
    return this.dummy;
  }
}

/**
 * Strips the secret. Written field by field rather than as a spread with the
 * hash deleted afterwards: a new secret added to `AuthUserWithSecret` later
 * would be published by the spread and silently ride out to the client, while
 * here it simply does not appear.
 */
function publicUser(user: AuthUser): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles,
  };
}
