import { inject, injectable } from "tsyringe";
import { AUTH_TOKENS } from "monolite-auth";
import type { AuthUserWithSecret, IPasswordHasher, IUserProvider } from "monolite-auth";
import { readEnv } from "../config/env";

/**
 * Where the login looks its users up. **Replace this.**
 *
 * `IUserProvider` is the one thing `monolite-auth` cannot supply: it knows how
 * to check a password, mint a token and guard a route, but it has no opinion
 * about your users' table. Swap the body of `findByEmail` for a query — usually
 * through the repository of your users module — and delete this file.
 *
 * If the passwords you authenticate against belong to somebody else — a
 * corporate directory, a Nextcloud, an OIDC provider — this is not the contract
 * you want at all. Those services check the password themselves and never hand
 * over a hash, so the seam is `IIdentityProvider` and the login flow is
 * `ExternalAuthBLL`; see the authentication guide.
 *
 * What ships here is a single account held in memory, so that a freshly
 * scaffolded project can log in and see the flow work end to end.
 */

/**
 * The seeded account's password comes from the environment and has **no
 * default and no constant to fill in**.
 *
 * That is deliberate, and it is the correction of a mistake this file used to
 * invite. A constant with a placeholder string in it is a comfortable place to
 * put a password, and a real one ends up there — in a tracked file, in the
 * history, on every fork — usually in a project where this provider was
 * replaced months earlier and nobody had reason to open the file again. There
 * is nowhere here to type one now: the value lives in `.env`, which is
 * git-ignored, next to `JWT_SECRET` and the database password.
 */
const SEED = {
  id: "1",
  name: "Admin",
  email: "admin@example.com",
  roles: ["admin"],
};

@injectable()
export class SeedUserProvider implements IUserProvider {
  private readonly password: string;

  /**
   * The hash is computed on first use rather than written as a literal, because
   * a literal would pin this file to whichever algorithm the package shipped on
   * the day the template was written. Asking the hasher keeps the two in step.
   */
  private cached?: AuthUserWithSecret;

  constructor(@inject(AUTH_TOKENS.IPasswordHasher) private readonly hasher: IPasswordHasher) {
    // Refused outright in production rather than merely discouraged. A seeded
    // administrator with a password from an environment variable is a fixture
    // for a project's first afternoon; the way it turns into an incident is by
    // surviving, unread, into a deployment nobody thought it was part of.
    if (readEnv("NODE_ENV") === "production") {
      throw new Error(
        "[auth] SeedUserProvider is a scaffold and refuses to run in production. " +
          "Implement IUserProvider against your own users table and register that instead."
      );
    }

    // Failing at startup, like `JWT_SECRET` does, for the same reason: a login
    // that silently accepts a default password is discovered by whoever tries
    // it first, and that is not usually you.
    this.password = readEnv("SEED_PASSWORD");
    if (!this.password) {
      throw new Error(
        "[auth] SEED_PASSWORD is not set. Copy .env.example to .env and put a value there, " +
          "or replace SeedUserProvider with a provider that reads your own users."
      );
    }
  }

  async findByEmail(email: string): Promise<AuthUserWithSecret | null> {
    // Case-insensitive, because an email address is: refusing "Admin@..." would
    // be a login failure nobody can debug from the outside.
    if (email.trim().toLowerCase() !== SEED.email) return null;

    this.cached ??= { ...SEED, passwordHash: await this.hasher.hash(this.password) };
    return this.cached;
  }
}
