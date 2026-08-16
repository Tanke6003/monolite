import {
  AUTH_TOKENS,
  AuthController,
  AuthService,
  JwtTokenService,
  ScryptPasswordHasher,
} from "monolite-auth";
import type { IAuthService, IPasswordHasher, ITokenService, IUserProvider } from "monolite-auth";
import { registerInstance, registerSingleton } from "monolite-di";
import type { DependencyContainer } from "monolite-di";
import { SeedUserProvider } from "../auth/seed-user.provider";
import { readEnv, requireEnv, toInt } from "../config/env";

/**
 * Everything the login flow needs, in one place you own.
 *
 * `monolite-auth` ships the parts that are the same in every application —
 * checking a password, minting a token, guarding a route — and refuses to know
 * the one that is not, which is where the users live. That is `IUserProvider`,
 * and the scaffold's implementation is a single seeded account: replace it.
 *
 * The classes are built here rather than resolved, because two of them take
 * arguments a container cannot invent: the secret and the token lifetime are
 * configuration, read once at startup.
 */
export function registerAuth(container: DependencyContainer): void {
  const hasher: IPasswordHasher = new ScryptPasswordHasher();
  registerInstance<IPasswordHasher>(container, AUTH_TOKENS.IPasswordHasher, hasher);

  // Singleton, and not a preference: `SeedUserProvider` hashes its seed on
  // first use and caches it, and the real implementation this becomes will hold
  // a repository.
  registerSingleton<IUserProvider>(container, AUTH_TOKENS.IUserProvider, SeedUserProvider);

  // The constructor refuses an empty secret rather than signing with a default,
  // so this is where a misconfigured deployment stops — at startup, in the boot
  // log, instead of at the first forged token.
  const tokens: ITokenService = new JwtTokenService({
    secret: requireEnv("JWT_SECRET"),
    // Seconds. `jsonwebtoken` also takes "1h" and "7d", but the variable is
    // read as a number here so a typo is a startup failure rather than a
    // lifetime somebody has to go and measure.
    expiresIn: toInt(readEnv("JWT_EXPIRES_IN"), 3600, 1),
  });
  // Registered under the string both `monolite-auth` and `monolite-di` use,
  // so whatever asks for a token service finds this one.
  registerInstance<ITokenService>(container, AUTH_TOKENS.ITokenService, tokens);

  const auth: IAuthService = new AuthService(container.resolve(AUTH_TOKENS.IUserProvider), hasher, tokens);
  registerInstance<IAuthService>(container, AUTH_TOKENS.IAuthService, auth);

  // The controller declares this token in its own decorator, which is how the
  // router —which mounts every decorated controller it finds— knows who serves
  // it. The second argument is the extra middleware for the login route: a rate
  // limiter belongs there, and login is the one endpoint whose whole attack is
  // to be called a great many times.
  registerInstance(container, AUTH_TOKENS.IAuthController, new AuthController(auth, []));
}
