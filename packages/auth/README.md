# @monolite/auth

Authentication you can plug your own everything into.

The package brings the parts that are identical in every application — the login
flow, a token service, a password hasher, the middleware that guards a route —
and deliberately refuses to know the parts that are not. **Where your users
live** is `IUserProvider`, which you implement. **How passwords are hashed** is
`IPasswordHasher`, with a dependency-free implementation included. **What a
token is made of** is `ITokenService`, with JWT as the default.

Nothing here is mandatory: no other package in the toolkit depends on this one,
and an application that already authenticates somewhere else can take
`requireAuth` alone.

## Install

```bash
npm install @monolite/auth
```

It expects `express@^5` in the host application, and builds on `@monolite/core`
and `@monolite/http`.

## Usage

```ts
import {
  AuthController,
  AuthService,
  JwtTokenService,
  ScryptPasswordHasher,
  requireAuth,
  requireRoles,
} from "@monolite/auth";

const tokens = new JwtTokenService({ secret: process.env.JWT_SECRET!, expiresIn: "1h" });
const hasher = new ScryptPasswordHasher();
const auth = new AuthService(new SqlUserProvider(repository), hasher, tokens);

// The login route. `guards` is optional; a rate limiter belongs there.
const controller = new AuthController(auth, [loginRateLimiter]);

// Guarding routes.
app.use("/api", requireAuth(tokens, { context: requestContext }));
app.use("/api/admin", requireRoles("admin"));
```

`POST /auth/login` answers with the token, its lifetime in seconds and the
identity behind it:

```json
{
  "token": "eyJhbGciOi...",
  "expiresIn": 3600,
  "user": { "id": "42", "name": "Ana", "email": "ana@example.com", "roles": ["admin"] }
}
```

## Plugging in your own user provider

One method. Return `null` when there is no such user — never throw for "not
found", because telling a missing user apart from a broken lookup is exactly
what the login flow refuses to leak.

```ts
import type { AuthUserWithSecret, IUserProvider } from "@monolite/auth";

export class SqlUserProvider implements IUserProvider {
  constructor(private readonly users: IGenericRepository<IUser>) {}

  async findByEmail(email: string): Promise<AuthUserWithSecret | null> {
    const user = await this.users.firstOrDefault({ where: { email } });
    if (!user) return null;

    return {
      id: String(user.pkUser),
      name: user.name,
      email: user.email,
      roles: user.roles?.split(",") ?? [],
      passwordHash: user.passwordHash,
    };
  }
}
```

`AuthService` lower-cases and trims the address before handing it over, so store
and query your emails lower-cased.

## Plugging in your own hasher

`ScryptPasswordHasher` is the default because `crypto.scrypt` ships with Node:
the package hashes passwords without dragging in a native module that needs a
toolchain, breaks on Node upgrades and has to be rebuilt per platform. scrypt is
memory-hard (RFC 7914) — the property that matters against GPU cracking — and
OWASP accepts it for password storage. It is a defensible default, not a claim
that it is the best available.

Its cost parameters live inside each stored hash
(`scrypt$N$r$p$salt$hash`), so raising them later does not invalidate the
passwords already stored:

```ts
// OWASP's current guidance, for a process with the memory headroom for it.
new ScryptPasswordHasher({ cost: 2 ** 17 });
```

To use argon2id or bcrypt instead, implement the same two methods:

```ts
import argon2 from "argon2";
import type { IPasswordHasher } from "@monolite/auth";

export class Argon2PasswordHasher implements IPasswordHasher {
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    // The contract is `false`, never a throw, for an unreadable hash.
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
```

Pass it to `AuthService` and nothing else changes. Because every hash carries
its scheme at the front, old and new can coexist while stored passwords are
migrated on next login.

## What login does not tell you

A wrong password and an unknown email produce the same status, the same code and
the same message. Telling them apart would turn the login form into a lookup
service — submit a list of addresses with junk passwords, learn which ones are
registered — and knowing that somebody has an account is often the sensitive
part on its own.

The message is only half of it. The password check runs even when there is no
such user, against a throwaway hash built by your own hasher, so that the two
answers take the same time to arrive. Skipping it would make "unknown email"
come back in a millisecond and "wrong password" in the hundred that hashing
deliberately costs, and that difference is measurable across a network.

## Guarding routes

`requireAuth(tokenService, options?)` reads `Authorization: Bearer`, verifies the
token and publishes the identity — on the request, and into the request context
when you pass one, which is what lets a service three layers down know who is
asking without threading the user through every signature.

```ts
requireAuth(tokens, {
  context: requestContext,
  // For an issuer whose claims the toolkit does not recognise. The default is
  // `toCurrentUser` from @monolite/http, which already knows what OIDC and
  // Azure AD emit — and is the same function the request context is built on.
  toCurrentUser: (claims) => ({ id: claims.uid as string, name: "...", email: null, roles: [] }),
});
```

`requireRoles(...roles)` grants access when the user holds **any** of the listed
roles — the reading of `[Authorize(Roles = ...)]` in ASP.NET, and the way the
rule is usually said out loud. To demand several at once, chain the middleware:

```ts
app.use("/api/invoices", requireRoles("admin"), requireRoles("billing"));
```

Both answer through `AppError`, so a 401 or a 403 from here carries the same
shape — code, request id — as every other error in the API.

## No refresh endpoint

There is no `POST /auth/refresh`, on purpose. Refreshing honestly means a
second, longer-lived credential that is stored, rotated on every use and
revocable; without that store there is nothing to revoke, and an endpoint that
merely re-signs a still-valid access token does not extend a session so much as
delete the expiry that was the point of having one. The store is a decision
about your persistence, which is precisely what this package refuses to know.

An application that wants refresh tokens has everything it needs: `ITokenService`
signs and verifies whatever payload you give it, including a long-lived one
whose id you keep in your own table.

## API

| Export | What it is |
| --- | --- |
| `AuthUser`, `AuthUserWithSecret`, `Credentials`, `AuthResult`, `TokenClaims`, `SignedToken` | The vocabulary |
| `IUserProvider`, `IPasswordHasher`, `ITokenService`, `IAuthService` | The four seams |
| `AuthService`, `AuthServiceOptions` | The login flow |
| `JwtTokenService`, `JwtTokenServiceOptions` | Signing and verifying JWTs |
| `ScryptPasswordHasher`, `ScryptPasswordHasherOptions` | The dependency-free hasher |
| `requireAuth`, `requireRoles`, `authenticatedUser`, `RequireAuthOptions` | Route guards |
| `AuthController`, `loginSchema`, `authResultSchema` | `POST /auth/login` |

## License

MIT
