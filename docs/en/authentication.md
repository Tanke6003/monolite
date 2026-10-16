# Authentication

> 🇪🇸 [Leer en español](../es/authentication.md) · package: `monolite-auth`

Optional and pluggable. The package supplies what is the same in every
application — the login flow, a token BLL, a password hasher, the middleware
that guards a route — and deliberately refuses to know the parts that are not.

**No other package depends on this one.** An application that authenticates
elsewhere can take `requireAuth` alone, or nothing at all.

---

## The three contracts you plug into

| Contract | Who implements it | Why it is an interface |
| --- | --- | --- |
| `IUserProvider` | **You** | Where users live is your decision — a table, an LDAP directory, an array. The package must not impose a schema. |
| `IPasswordHasher` | Included (`ScryptPasswordHasher`), swappable | What is sufficient today will not be in five years. Swapping to argon2 must not touch anything else. |
| `ITokenBLL` | Included (`JwtTokenBLL`), swappable | An application with opaque tokens backed by a store implements the same two methods. |

```ts
export interface IUserProvider {
  // `null` when the user does not exist — it never throws for "not found".
  findByEmail(email: string): Promise<AuthUserWithSecret | null>;
}
```

That is the entire integration surface. `AuthUserWithSecret` is `{ id, name,
email, roles, passwordHash }`, and `passwordHash` is the one field that never
leaves the BLL.

---

## Wiring it up

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

const auth = new AuthBLL(new MyUserProvider(usersRepository), hasher, tokens);

const app = createApp({
  controllers: [...controllers, new AuthController(auth)],
  guard: requireAuth(tokens),
  logger,
  context,
});
```

`POST /auth/login` takes `{ email, password }` and answers
`{ token, expiresIn, user }`. `expiresIn` travels alongside the token because the
client should not have to parse the token to learn it — to a client the token is
an opaque string.

---

## Two things the login does on purpose

**It answers identically for an unknown email and a wrong password.** Both raise
the same 401 with the same message. Distinguishing them turns the login endpoint
into an account-existence oracle: an attacker learns which addresses are
registered without guessing a single password.

**It spends the same time on both.** When the user does not exist, the BLL
still runs the hash verification, against a dummy hash. Skipping it would return
in microseconds instead of the ~100 ms a real scrypt comparison costs, and that
difference is measurable over a network — the identical message would leak through
the clock instead.

Neither is theoretical: both are how enumeration is done in practice, and getting
the second one right is the part most implementations skip.

---

## Password hashing

`ScryptPasswordHasher` uses Node's built-in `crypto.scrypt` — a memory-hard KDF,
a random salt per password, and `timingSafeEqual` for the comparison. It needs no
dependency, which is why it is the default.

It is not the strongest option available. argon2id is the current recommendation
where you can add a native dependency, and bcrypt remains fine. Both fit behind
`IPasswordHasher` without touching anything else:

```ts
class Argon2Hasher implements IPasswordHasher {
  hash(plain: string) { return argon2.hash(plain); }
  verify(plain: string, hash: string) { return argon2.verify(hash, plain); }
}
```

`verify` returns `false` — rather than throwing — when the stored hash is
unreadable. A corrupted row must fail the login, not the request.

---

## Guarding routes

```ts
// Everything the app mounts, unless a route declares itself public.
createApp({ controllers, guard: requireAuth(tokens), logger, context });
```

Or one route at a time, with the guard as extra middleware:

```ts
class ReportsController {
  @Get("/admin/reports", { use: [requireRoles("admin")] })
  public reports = async (req: Request, res: Response) => { /* ... */ };
}
```

`requireAuth` reads `Authorization: Bearer …`, verifies the token, and publishes
the identity into the request context — the same context the repositories read for
their audit columns and the error handler reads for its log. Nothing downstream
parses a token.

A route marked `public: true` in its decorator options skips the guard, and the
OpenAPI builder correspondingly omits its `security` block and its automatic 401.
One declaration, both effects.

`requireRoles(...roles)` checks `CurrentUser.roles` and answers 403. Both fail
through `AppError`, so the existing error handler renders them in the standard
envelope with a stable `code` — you do not get a second error format just because
the failure was an authorisation one.

`authenticatedUser(req)` returns the `CurrentUser` or `null`, for the handful of
places that need to branch rather than reject.

### Claim names

Providers disagree on claim names, so the mapping tries a list in order:

| | Claims tried, in order |
| --- | --- |
| id | `sub`, `userId`, `id`, `oid` |
| name | `name`, `nameComplete`, `preferred_username`, `samaccountname`, `username` |
| email | `email`, `emails`, `upn` |
| roles | `roles`, `role` — a string or an array, always normalised to an array |

If no name claim is present the email is used, and failing that the id — so an
authenticated write is never recorded as `System`.

Use the **id**, never the name, for anything that depends on who is asking. Names
change; ids do not.

---

## Signing out and revoking tokens

A JWT is valid until its `exp` by construction — the signature cannot be taken
back. Revoking one means remembering, somewhere every instance can read, that it
no longer counts. `CacheTokenRevocation` keeps that list in the shared `ICache`,
and only for as long as each token had left to live, so it empties itself.

```ts
import { CacheTokenRevocation } from "monolite-auth";

const revocation = new CacheTokenRevocation(cache, { maxTokenLifetime: 3600 });

const auth = new AuthBLL(users, hasher, tokens, { revocation });
const guard = requireAuth(tokens, { revocation, context });
```

The guard and the BLL must be given **the same instance**, or signing out is
written somewhere nobody reads.

- **`POST /auth/logout`** revokes the token the request carries and answers 204.
  It is guarded like any other route, so signing out twice is a 401
  `TOKEN_REVOKED`, not a second 204.
- **`revocation.revokeAllFor(userId)`** withdraws every token issued to that user
  so far — for a disabled account, a changed password, a lost device. Tokens
  issued afterwards still work; keeping a disabled account out for good is your
  `IUserProvider`'s job, by not finding it at sign-in.
- Every token `JwtTokenBLL` signs now carries a **`jti`**, the name it is revoked
  by. A token signed before the upgrade has none, and `logout` answers 400
  `TOKEN_NOT_REVOCABLE` for it until it expires on its own.

With revocation configured, every guarded request reads the cache — two keys, in
parallel. When the cache cannot be reached the guard answers **503
`AUTH_UNAVAILABLE`** rather than letting the request through: a token revoked
because it was stolen is exactly the one that must not ride through an outage.
The login limiter makes the same choice.

| `code` | Status | Meaning |
| --- | --- | --- |
| `TOKEN_REVOKED` | 401 | The token was signed out or its user was cut off. Sign in again. |
| `AUTH_UNAVAILABLE` | 503 | The revocation store is down. Retry. |
| `TOKEN_NOT_REVOCABLE` | 400 | `logout` on a token with no `jti`. |
| `LOGOUT_UNAVAILABLE` | 501 | `logout` on a server with no revocation configured. |

`revokeAllFor` is compared against the token's `iat`, which is in whole seconds:
a token issued in the same second as the cut-off is still accepted. Refusing it
would also refuse the fresh token handed out right after a password change.

With `CACHE_DRIVER=memory` a sign-out holds only in the process that received
it. Behind more than one replica, use Redis.

---

## What this package does not do

Being explicit, because the gaps matter more than the features:

- **No refresh tokens.** A refresh token has to be stored, rotated on every use
  and tied to the account it extends, and that table is an application decision.
  Issuing a second JWT and calling it a refresh token buys nothing.
- **No registration, no password reset, no email verification.** All three need
  to send mail, rate-limit by address and decide a policy. They are application
  features that happen to touch authentication.
- **No OAuth or OIDC.** If you need one, verify the provider's token with your own
  `ITokenBLL` implementation and keep the rest of this package as it is.

Each of those is a deliberate omission rather than a missing feature. A framework
that guesses at them ships something you have to undo.

---

## Configuration

| Variable | Notes |
| --- | --- |
| `JWT_SECRET` | Required when the JWT token BLL is used. There is **no default** — a framework that ships a fallback signing key ships a forged-token vulnerability to everyone who forgot to override it. |
| `JWT_EXPIRES_IN` | Default `1h`. Accepts the `jsonwebtoken` duration syntax. |

Verify the secret is present at startup and fail loudly if it is not. Failing at
boot is a five-second problem; discovering it in production is not.
