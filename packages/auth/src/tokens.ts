/**
 * Identifiers the authentication pieces are registered and injected under.
 *
 * The package does not depend on a container —nothing here imports tsyringe,
 * and an application wiring these classes with `new` never reads this file— but
 * the ones that *do* use a container need to agree on a string, and the string
 * cannot live in the application: `AuthController` declares its own token in
 * its decorator, so the router can only find whoever serves it if both sides
 * spell it the same way.
 *
 * Key and value are identical on purpose, and `ITokenBLL` deliberately
 * matches the entry in `monolite-di`'s table. The two packages do not import
 * each other; they agree on a name, which is all a token is. An application
 * running both registers the token BLL once and both tables find it.
 */
export const AUTH_TOKENS = {
  /**
   * Issues and verifies access tokens. Same string as `monolite-di`'s
   * `TOKENS.ITokenBLL`, so the two never end up with two registrations of
   * the same thing.
   */
  ITokenBLL: "ITokenBLL",
  IPasswordHasher: "IPasswordHasher",
  /** Where the login looks users up. Always the application's own class. */
  IUserProvider: "IUserProvider",
  IAuthBLL: "IAuthBLL",
  /** Token `AuthController` declares, and the one the router resolves it by. */
  IAuthController: "IAuthController",
} as const;

/** Any of the identifiers above. */
export type AuthToken = (typeof AUTH_TOKENS)[keyof typeof AUTH_TOKENS];
