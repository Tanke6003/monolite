/**
 * `@monolite/auth` — optional, pluggable authentication.
 *
 * The package supplies the parts that are the same in every application — the
 * login flow, a token service, a password hasher, the middleware that guards a
 * route — and refuses to know the parts that are not. Where users live is
 * `IUserProvider`, which the application implements; how passwords are hashed
 * is `IPasswordHasher`, with an implementation included that needs nothing but
 * Node; what a token is made of is `ITokenService`, with JWT as the default.
 *
 * Nothing here is mandatory. An application that already authenticates
 * elsewhere can take `requireAuth` alone, or nothing at all: no other package
 * in the toolkit depends on this one.
 */

// -----------------------------------------------------------  contracts  ---
export type {
  AuthResult,
  AuthUser,
  AuthUserWithSecret,
  Credentials,
  IAuthService,
  IPasswordHasher,
  ITokenService,
  IUserProvider,
  SignedToken,
  TokenClaims,
} from "./contracts.js";

// ---------------------------------------------------------------  tokens  ---
export { JwtTokenService } from "./jwt.token-service.js";
export type { JwtTokenServiceOptions } from "./jwt.token-service.js";

// -------------------------------------------------------------  hashing  ---
export { ScryptPasswordHasher } from "./password.hasher.js";
export type { ScryptPasswordHasherOptions } from "./password.hasher.js";

// ---------------------------------------------------------------  login  ---
export { AuthService } from "./auth.service.js";
export type { AuthServiceOptions } from "./auth.service.js";

// ----------------------------------------------------------  middleware  ---
// The claim-to-identity mapping is not re-exported: it is `toCurrentUser` in
// `@monolite/http`, which is the same function the request context is built
// around, and having one name for it is the point.
export { authenticatedUser, requireAuth, requireRoles } from "./auth.middleware.js";
export type { RequireAuthOptions } from "./auth.middleware.js";

// ----------------------------------------------------------  controller  ---
export { AuthController, authResultSchema, loginSchema } from "./auth.controller.js";
