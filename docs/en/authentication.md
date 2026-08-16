# Authentication

> 🇪🇸 [Leer en español](../es/authentication.md) · package: `monolite-auth`

Optional and pluggable. The package supplies what is the same in every
application — the login flow, a token service, a password hasher, the middleware
that guards a route — and deliberately refuses to know the parts that are not.

**No other package depends on this one.** An application that authenticates
elsewhere can take `requireAuth` alone, or nothing at all.

---

## The three contracts you plug into

| Contract | Who implements it | Why it is an interface |
| --- | --- | --- |
| `IUserProvider` | **You** | Where users live is your decision — a table, an LDAP directory, an array. The package must not impose a schema. |
| `IPasswordHasher` | Included (`ScryptPasswordHasher`), swappable | What is sufficient today will not be in five years. Swapping to argon2 must not touch anything else. |
| `ITokenService` | Included (`JwtTokenService`), swappable | An application with opaque tokens backed by a store implements the same two methods. |

```ts
export interface IUserProvider {
  // `null` when the user does not exist — it never throws for "not found".
  findByEmail(email: string): Promise<AuthUserWithSecret | null>;
}
```

That is the entire integration surface. `AuthUserWithSecret` is `{ id, name,
email, roles, passwordHash }`, and `passwordHash` is the one field that never
leaves the service.

---

## Wiring it up

```ts
import {
  AuthController,
  AuthService,
  JwtTokenService,
  ScryptPasswordHasher,
  requireAuth,
  requireRoles,
} from "monolite-auth";

const tokens = new JwtTokenService({ secret: process.env.JWT_SECRET!, expiresIn: "1h" });
const hasher = new ScryptPasswordHasher();

const auth = new AuthService({
  users: new MyUserProvider(usersRepository),   // yours
  hasher,
  tokens,
});

const app = createApp({
  controllers: [...controllers, new AuthController(auth)],
  guard: requireAuth(tokens),
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

**It spends the same time on both.** When the user does not exist, the service
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
createApp({ guard: requireAuth(tokens) });

// Or per route.
@Get("/admin/reports", { use: [requireRoles("admin")] })
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

## What this package does not do

Being explicit, because the gaps matter more than the features:

- **No refresh tokens.** A refresh flow needs somewhere to store and revoke
  them, and that store is an application decision. Issuing a second JWT and
  calling it a refresh token buys nothing — it cannot be revoked either.
- **No registration, no password reset, no email verification.** All three need
  to send mail, rate-limit by address and decide a policy. They are application
  features that happen to touch authentication.
- **No session store, no logout.** A JWT is valid until it expires; "logging out"
  is the client discarding it. Real revocation needs a denylist, which is the same
  storage decision as above.
- **No OAuth or OIDC.** If you need one, verify the provider's token with your own
  `ITokenService` implementation and keep the rest of this package as it is.

Each of those is a deliberate omission rather than a missing feature. A framework
that guesses at them ships something you have to undo.

---

## Configuration

| Variable | Notes |
| --- | --- |
| `JWT_SECRET` | Required when the JWT token service is used. There is **no default** — a framework that ships a fallback signing key ships a forged-token vulnerability to everyone who forgot to override it. |
| `JWT_EXPIRES_IN` | Default `1h`. Accepts the `jsonwebtoken` duration syntax. |

Verify the secret is present at startup and fail loudly if it is not. Failing at
boot is a five-second problem; discovering it in production is not.
