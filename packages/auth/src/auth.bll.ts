import { randomBytes } from "node:crypto";
import type {
  AuthResult,
  Credentials,
  IAuthBLL,
  IPasswordHasher,
  ITokenBLL,
  IUserProvider,
} from "./contracts.js";
import { invalidCredentials, publicUser } from "./login.js";

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
}

/**
 * Signing in: find the user, check the password, hand back a token.
 *
 * It knows nothing about where users are stored, how passwords are hashed or
 * what a token is made of — those are the three interfaces it is constructed
 * with. That is what lets the same BLL sit on top of a SQL table, a document
 * store or a fixture array in a test.
 *
 * What it does know is that the password is checked *here*, against a hash the
 * provider handed over. An identity kept in a directory that checks its own
 * passwords never produces such a hash, and no `IUserProvider` can invent one:
 * that deployment wants `ExternalAuthBLL` instead.
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
