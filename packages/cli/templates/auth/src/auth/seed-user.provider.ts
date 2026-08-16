import { inject, injectable } from "tsyringe";
import { AUTH_TOKENS } from "monolite-auth";
import type { AuthUserWithSecret, IPasswordHasher, IUserProvider } from "monolite-auth";

/**
 * Where the login looks its users up. **Replace this.**
 *
 * `IUserProvider` is the one thing `monolite-auth` cannot supply: it knows how
 * to check a password, mint a token and guard a route, but it has no opinion
 * about your users' table, and that is what keeps it usable in a project whose
 * identities live in LDAP or behind another service.
 *
 * What ships here is a single account held in memory, so that a freshly
 * scaffolded project can log in and see the flow work end to end. Swap the body
 * of `findByEmail` for a query —usually through the repository of your users
 * module— and delete the seed.
 */

/** Password of the seeded account. Development only; there is no other user. */
const SEED_PASSWORD = "change_me";

const SEED = {
  id: "1",
  name: "Admin",
  email: "admin@example.com",
  roles: ["admin"],
};

@injectable()
export class SeedUserProvider implements IUserProvider {
  /**
   * The hash is computed on first use rather than written as a literal, because
   * a literal would pin this file to whichever algorithm the package shipped on
   * the day the template was written. Asking the hasher keeps the two in step.
   */
  private cached?: AuthUserWithSecret;

  constructor(@inject(AUTH_TOKENS.IPasswordHasher) private readonly hasher: IPasswordHasher) {}

  async findByEmail(email: string): Promise<AuthUserWithSecret | null> {
    // Case-insensitive, because an email address is: refusing "Admin@..." would
    // be a login failure nobody can debug from the outside.
    if (email.trim().toLowerCase() !== SEED.email) return null;

    this.cached ??= { ...SEED, passwordHash: await this.hasher.hash(SEED_PASSWORD) };
    return this.cached;
  }
}
