# monolite-auth

Authentication you can plug your own everything into.

The package brings the parts that are identical in every application — the login
flow, a token BLL, a password hasher, the middleware that guards a route —
and deliberately refuses to know the parts that are not. **Where your users
live** is `IUserProvider`, which you implement. **How passwords are hashed** is
`IPasswordHasher`, with a dependency-free implementation included. **What a
token is made of** is `ITokenBLL`, with JWT as the default. And when the
password is not yours to check at all — a corporate directory, a Nextcloud, an
OIDC provider — that is `IIdentityProvider` and `ExternalAuthBLL`.

Nothing here is mandatory: no other package in the toolkit depends on this one,
and an application that already authenticates somewhere else can take
`requireAuth` alone.

## Install

```bash
npm install monolite-auth
```

It expects `express@^5` in the host application, and builds on `monolite-core`
and `monolite-http`.

## Usage

```ts
import {
  AuthController,
  AuthBLL,
  JwtTokenBLL,
  ScryptPasswordHasher,
  requireAuth,
  requireRoles,
} from "monolite-auth";

const tokens = new JwtTokenBLL({ secret: process.env.JWT_SECRET!, expiresIn: "1h" });
const hasher = new ScryptPasswordHasher();
const auth = new AuthBLL(new SqlUserProvider(repository), hasher, tokens);

// The login route. `guards` is optional; a rate limiter belongs there.
const controller = new AuthController(auth, [loginRateLimiter]);

// Guarding routes.
app.use("/api", requireAuth(tokens, { context }));
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
import type { AuthUserWithSecret, IUserProvider } from "monolite-auth";

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

`AuthBLL` lower-cases and trims the address before handing it over, so store
and query your emails lower-cased.

## When the password is not yours to check

`IUserProvider` hands back a hash, and `AuthBLL` compares it here. That works
for a users table. It cannot work for a directory: LDAP, Nextcloud and every
OIDC provider check the password on their side and answer yes or no — none of
them will ever give you a hash to compare. So the seam for those is not the user
provider, it is the BLL.

`ExternalAuthBLL` is that BLL. You write the piece that talks to the service:

```ts
import type { ExternalIdentity, IIdentityProvider } from "monolite-auth";

export class DirectoryIdentityProvider implements IIdentityProvider {
  constructor(private readonly baseUrl: string) {}

  async verify(login: string, password: string): Promise<ExternalIdentity | null> {
    const response = await fetch(`${this.baseUrl}/whoami`, {
      headers: { Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}` },
      signal: AbortSignal.timeout(8000),
    });

    // A rejection is `null`. Anything else — a timeout, a 500, a socket that
    // never opened — has to throw: see below.
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error(`[directory] answered ${response.status}`);

    const account = (await response.json()) as {
      id: string;
      displayName: string;
      email: string | null;
      groups: string[];
    };

    return {
      key: account.id,
      name: account.displayName,
      email: account.email,
      groups: account.groups,
    };
  }
}
```

**`null` and a throw are different answers, and getting that wrong is the bug
this contract exists to prevent.** `null` means the credentials were refused;
throwing means the provider did not answer. Collapse the two and an outage tells
every person in the organisation that they mistyped their password. `ExternalAuthBLL`
answers a 401 for the first and a **503 `IDENTITY_PROVIDER_UNAVAILABLE`** for the
second.

The other half is where the local account lives, which is still yours.
`IExternalUserProvider` extends `IUserProvider` with three methods:

```ts
import type { ExternalAuthUser, ExternalIdentity, IExternalUserProvider } from "monolite-auth";

export class SqlUserProvider implements IExternalUserProvider {
  constructor(private readonly users: IGenericRepository<IUser>) {}

  findByEmail(email: string): Promise<ExternalAuthUser | null> {
    return this.first({ email });
  }

  // The lookup that survives a rename over there.
  findByExternalKey(key: string): Promise<ExternalAuthUser | null> {
    return this.first({ externalKey: key });
  }

  // First sign-in. Give it the least privilege you have.
  async provision(identity: ExternalIdentity, fallbackEmail: string): Promise<ExternalAuthUser> {
    return toAuthUser(
      await this.users.insert({
        name: identity.name,
        email: identity.email ?? fallbackEmail,
        externalKey: identity.key,
        role: "reader",
      })
    );
  }

  // What the provider just said. Not the roles, and not the disabled flag.
  async link(user: ExternalAuthUser, identity: ExternalIdentity): Promise<ExternalAuthUser> {
    return toAuthUser(
      // `AuthUser.id` is a string, because a token claim is; the key of this
      // table is not. The conversion belongs here and nowhere else.
      await this.users.update(Number(user.id), { externalKey: identity.key, name: identity.name })
    );
  }

  private async first(where: object): Promise<ExternalAuthUser | null> {
    const row = await this.users.firstOrDefault({ where });
    // `passwordHash` is `""` for an account that has never had a local one, and
    // `disabled` is reported rather than hidden — see below.
    return row ? toAuthUser(row) : null;
  }
}
```

Because it extends `IUserProvider`, one class serves both flows — which is what
lets the composition root choose from configuration:

```ts
const auth = directoryUrl
  ? new ExternalAuthBLL(new DirectoryIdentityProvider(directoryUrl), users, hasher, tokens, {
      logger,
    })
  : new AuthBLL(users, hasher, tokens);
```

A copy of the application without access to the directory then still signs in
against its own table, which is how the tests run and how a developer works on a
laptop.

### What it decides, and why

| | |
| --- | --- |
| **The roles are yours, never the provider's** | `identity.groups` is carried and never read. Mapping directory groups onto roles is a convenience until somebody is added to a group called `admin` for an unrelated reason and inherits your application with it. |
| **The token's `sub` is the local id** | That claim fills the audit columns and is what every rule about *who* is asking resolves against. The external key identifies the person to the provider, not to you. |
| **An outage is a 503, not a 401** | It leaks nothing — the directory being unreachable is a fact about the deployment, identical for an address that exists and one that does not — and it is the difference between one incident and an organisation resetting passwords that were fine. |
| **A local password is still accepted** | `localPasswordFallback` is on by default, so the emergency account works while the directory does not. Turn it off to make the provider the only authority. |
| **A disabled account says so** | `ExternalAuthUser.disabled` rather than a `null` from `findByEmail`: hiding a suspended account sends the next sign-in — which the directory still accepts — down the provisioning path, and a brand new account quietly undoes the suspension. |

`autoProvision: false` turns off first-sign-in account creation; a verified
identity with no local account then gets the ordinary 401, because answering
anything else confirms the password to whoever was guessing it.

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
import type { IPasswordHasher } from "monolite-auth";

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

Pass it to `AuthBLL` and nothing else changes. Because every hash carries
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

`requireAuth(tokenBLL, options?)` reads `Authorization: Bearer`, verifies the
token and publishes the identity — on the request, and into the request context
when you pass one, which is what lets a BLL three layers down know who is
asking without threading the user through every signature.

```ts
requireAuth(tokens, {
  context,
  // For an issuer whose claims the toolkit does not recognise. The default is
  // `toCurrentUser` from monolite-http, which already knows what OIDC and
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

An application that wants refresh tokens has everything it needs: `ITokenBLL`
signs and verifies whatever payload you give it, including a long-lived one
whose id you keep in your own table.

## API

| Export | What it is |
| --- | --- |
| `AuthUser`, `AuthUserWithSecret`, `Credentials`, `AuthResult`, `TokenClaims`, `SignedToken` | The vocabulary |
| `IUserProvider`, `IPasswordHasher`, `ITokenBLL`, `IAuthBLL` | The four seams |
| `ExternalIdentity`, `ExternalAuthUser`, `IIdentityProvider`, `IExternalUserProvider` | The two more, for an identity kept elsewhere |
| `AuthBLL`, `AuthBLLOptions` | The login flow |
| `ExternalAuthBLL`, `ExternalAuthBLLOptions` | The same, against a provider that checks the password itself |
| `JwtTokenBLL`, `JwtTokenBLLOptions` | Signing and verifying JWTs |
| `ScryptPasswordHasher`, `ScryptPasswordHasherOptions` | The dependency-free hasher |
| `requireAuth`, `requireRoles`, `authenticatedUser`, `RequireAuthOptions` | Route guards |
| `AuthController`, `loginSchema`, `authResultSchema` | `POST /auth/login` |
| `AUTH_TOKENS`, `AuthToken` | The DI identifiers, which is what you register your own `IUserProvider` under |

## License

MIT
