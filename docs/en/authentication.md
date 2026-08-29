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
| `IUserProvider` | **You** | Where users live is your decision — a table, a document store, an array. The package must not impose a schema. |
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

It is also the boundary of what this contract can do: it hands back a hash, so
the password has to be checkable here. A directory that checks its own — LDAP,
Nextcloud, OIDC — never produces one, and that case has a seam of its own,
further down.

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

## When the password is not yours to check

`IUserProvider` hands back a hash and `AuthBLL` compares it here. That is right
for a users table and impossible for a directory: LDAP, Nextcloud and every OIDC
provider check the password on their side and answer yes or no — none of them
will ever hand over a hash to compare. So the seam for those is not the user
provider, however natural that reads. It has to be where the comparison happens,
which is the BLL.

`ExternalAuthBLL` is that BLL. It keeps everything around the comparison — the
token, the single error, the timing defence, the suspended account — so that
connecting a directory is two small classes rather than a login flow rewritten
from scratch.

| Contract | Who implements it | What it answers |
| --- | --- | --- |
| `IIdentityProvider` | **You** | An `ExternalIdentity` for a confirmed credential, `null` for a rejected one, and a **throw** when the provider did not answer at all. |
| `IExternalUserProvider` | **You** | Where the local account behind that identity lives. It extends `IUserProvider`, so one class serves both flows. |

```ts
export interface IIdentityProvider {
  verify(login: string, password: string): Promise<ExternalIdentity | null>;
}

export interface ExternalIdentity {
  /** Their key over there: a `uid`, an account name, an OIDC `sub`. */
  key: string;
  name: string;
  email: string | null;
  /** Carried so you can record them. Never read as a role — see below. */
  groups: string[];
}
```

**`null` and a throw are different answers, and that is the point of the
contract.** `null` means the credentials were refused; throwing means the
provider did not answer. Collapse the two and an outage tells everybody in the
organisation that they mistyped their password — which is both wrong and the
fastest way to bury the one fact an operator needed. `ExternalAuthBLL` answers a
401 for the first and a 503 `IDENTITY_PROVIDER_UNAVAILABLE` for the second.

### Choosing one flow or the other at startup

```ts
const auth = directoryUrl
  ? new ExternalAuthBLL(new DirectoryIdentityProvider(directoryUrl), users, hasher, tokens, {
      logger,
    })
  : new AuthBLL(users, hasher, tokens);
```

`IExternalUserProvider` extends `IUserProvider`, so `users` is one class either
way and the choice is a line in the composition root. That is what lets a copy
of the application without access to the directory still sign in against its own
table — which is how the tests run, and how somebody works on a laptop.

### What it decides, and why

- **The roles are yours, never the provider's.** `identity.groups` is carried
  and never read. Mapping directory groups onto roles reads as a convenience
  right up until somebody is added to a group called `admin` for an unrelated
  reason and inherits your application with it.
- **The token's `sub` stays the local id.** That claim fills the audit columns
  and is what every rule about *who* is asking resolves against. The external
  key identifies the person to the provider, not to you; it is stored beside the
  account, and kept updatable, because on some providers renaming an account is
  deleting it and creating another.
- **An outage is a 503, not a 401.** It leaks nothing: an unreachable directory
  is a fact about the deployment, identical for an address that exists and one
  that does not.
- **A local password still works.** `localPasswordFallback` is on by default, so
  the emergency account gets in while the directory is down. Turn it off to make
  the provider the only authority; nothing then ever calls the hasher.
- **A suspended account says so out loud.** `ExternalAuthUser.disabled`, rather
  than a `null` from `findByEmail`. Hiding it sends the next sign-in — which the
  directory still accepts — down the provisioning path, and a brand new account
  quietly undoes the suspension. The answer to the request is still the ordinary
  401.
- **First sign-in creates the account**, with whatever least privilege your
  `provision` grants it. `autoProvision: false` turns that off, and a verified
  identity with no local account then gets the same 401 — answering anything
  else confirms the password to whoever was guessing it.

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
- **No OAuth or OIDC redirect flow.** There is no authorisation-code dance, no
  state parameter, no callback route. What there is, for a provider that will
  check a password directly, is `IIdentityProvider` above; for one that issues
  its own tokens, verify them with your own `ITokenBLL` implementation and keep
  the rest of this package as it is.

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
