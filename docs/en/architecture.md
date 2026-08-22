# Architecture

> 🇪🇸 [Leer en español](../es/architecture.md)

Monolite is a set of packages, not a monolith with a plugin system. This document
explains how they fit together, what each one is allowed to depend on, and why the
boundaries are drawn where they are.

---

## The dependency graph

```
                         ┌──────────────┐
                         │     core     │   errors, logger and context contracts,
                         │ (0 runtime   │   AsyncLocalStorage request identity,
                         │  deps)       │   health probe
                         └──────┬───────┘
                   ┌────────────┼────────────┐
                   ▼            ▼            ▼
            ┌───────────┐ ┌──────────┐ ┌──────────┐
            │   data    │ │   http   │ │    di    │
            │ 6 engines │ │ express  │ │ tsyringe │
            └─────┬─────┘ └────┬─────┘ └──────────┘
                  │            │
                  └─────┬──────┘
                        ▼
                  ┌───────────┐      ┌──────────┐
                  │   crud    │      │   auth   │
                  └───────────┘      └──────────┘

            ┌───────────┐
            │    cli    │   depends on nothing; writes projects that use the rest
            └───────────┘
```

Three rules keep this honest:

1. **`core` never depends on anything.** Not Express, not a driver, not a
   container. It is the vocabulary the other packages agree on, and a package with
   dependencies cannot be that.
2. **No package depends on `di`.** The container is a leaf. Every other package
   takes its collaborators through the constructor, so a consumer who prefers
   Awilix, InversifyJS or plain `new` never installs tsyringe.
3. **Database drivers are optional peer dependencies.** `monolite-data` declares
   all six, all optional. A PostgreSQL project does not download the Oracle client.

---

## Layers inside a generated project

The packages implement the machinery; a project built on them still follows Clean
Architecture, and the CLI scaffolds exactly this shape:

```
┌─────────────────────────────────────────────────────┐
│  Presentation   controllers, middlewares            │  ← monolite-http
├─────────────────────────────────────────────────────┤
│  Application    BLLs, DTOs, use cases               │  ← monolite-crud
├─────────────────────────────────────────────────────┤
│  Domain         interfaces and models, no imports   │  ← your code only
├─────────────────────────────────────────────────────┤
│  Infrastructure repositories, connectors, plugins   │  ← monolite-data
└─────────────────────────────────────────────────────┘
```

The dependency rule is unchanged: inner layers know nothing about outer ones. What
the packages add is that the outer layers are now mostly *supplied* rather than
written. Your domain models and business rules stay yours.

### A controller talks to a BLL, never to a repository

The dependency rule is about *direction*, and a controller reaching past the
application layer into infrastructure obeys it as written — which is why this
needs saying separately.

Two decisions live in the gap it skips: **what a client is allowed to see**, and
**what the answer means**. A repository knows how to count rows. It does not know
which of them are worth publishing, in what order, or how many; and a controller
that answered with rows would be making both calls in the layer furthest from
either.

Most of the time nothing has to be remembered, because nothing can go wrong:
`CrudController` takes an `ICrudBLL` and will not take anything else, so
every `@Crud` module has the shape whether or not anyone thought about it. The
rule is only load-bearing in the one case where all four files are written from a
blank page — a report, a search across several tables, a dashboard. That is what
`monolite generate query` is for: it writes them with the layering already
right.

---

## Request lifecycle

```
HTTP request
    │
    ▼
Middleware chain                                          monolite-http
    │  x-powered-by off → trust proxy → request context →
    │  helmet → rate limit → cors → body parsers → http log → static
    │
    ▼
Router built from decorator metadata                      monolite-http
    │  auth guard, then Zod validation of body/query/params
    ▼
Controller                                                yours, or monolite-crud
    │  reads the request, calls the BLL
    ▼
BLL                                                       yours, or monolite-crud
    │  business rules. Opens a transaction with @Transactional()
    │  when the use case writes in more than one place
    ▼
Repository                                                yours (thin) + monolite-data
    │  logs, wraps driver errors, delegates
    ▼
Generic repository — SQL, MongoDB or in-memory            monolite-data
    │  builds the query from the entity mapping; every value is a bind
    ▼
Response, or an error through the single error handler
```

Two things travel *outside* this chain, both through `AsyncLocalStorage`:

- **The request identity** (`IRequestContext`, in `core`). The controller wants it
  for authorisation, the repository for the audit columns, the error handler for
  the log. Threading a `user` parameter through four layers would pollute every
  signature.
- **The open transaction** (`ITransactionContext`, in `data`). A repository joins
  the ambient transaction instead of being handed a connection, which is what lets
  `@Transactional()` be a one-line decorator.

Both are the same trick and both have the same requirement: the storage must be a
singleton, because the middleware that opens it and the repository that reads it
must be looking at the same store.

---

## `monolite-core` — the vocabulary

Everything here exists so the other packages can talk about the same concepts
without depending on each other.

| Export | Why it is in core |
| --- | --- |
| `AppError` | Every package throws it; the HTTP layer is the only one that renders it. |
| `normalizeError` | Turns any thrown value into a status plus a stable `code`. Lives here because `data` needs to classify driver errors and `http` needs to render them. |
| `ILogger` | A four-method contract, so no package depends on pino or winston. |
| `IRequestContext`, `CurrentUser`, `AsyncRequestContext` | Request identity. `SYSTEM_USER` is the value outside a request — seeds, startup, scheduled work. |
| `IHealthProbe`, `HealthProbe` | Readiness with a cache and a timeout, and a `beginShutdown()` that flips readiness before the process stops accepting work. |

### Error handling

Every failure, from any layer, leaves through the same door and produces the same
envelope:

```json
{
  "status": "error",
  "code": "APPOINTMENT_OVERLAP",
  "message": "The branch already has appointment #5 in that slot",
  "requestId": "407215bc-e453-4dcf-ac2f-37a1e88109c2",
  "timestamp": "2026-08-09T03:09:29.264Z",
  "path": "/api/v1/appointments",
  "method": "POST",
  "errors": [{ "field": "name", "message": "Name is required" }]
}
```

- `code` is stable and meant to be branched on; `message` is for humans and may be
  rewritten at any time.
- `stack` and `causes` are added **only outside production** — the most useful
  thing for debugging and the most dangerous to publish.
- A 5xx flagged non-operational always answers `"Internal server error"`
  regardless of environment. Hiding the detail of an unanticipated failure is the
  rule, not a production courtesy. An operational error keeps its message even at
  500, because someone wrote that message *for* the client.
- `requestId` goes out in `X-Request-Id` and into every log line of the request, so
  a user's screenshot is enough to find the trace.

`AppError` takes `isOperational` as its third argument. `true` means an expected
outcome: logged as a warning, message reaches the client. `false` marks a bug:
logged as an error, answered generically.

---

## `monolite-data` — one contract, six engines

This is the package the rest of the project exists to make possible. Full detail is
in [data-access.md](data-access.md); the architectural points are these:

**`IGenericRepository<T>` is the only data contract.** Every module goes through
it, whichever engine is configured, so CRUD is written once. Three drivers
implement it: SQL (shared by four engines), MongoDB, and in-memory.

**`SqlDialect` is the seam between the four SQL engines.** Paging syntax, identity
retrieval, row locking and boolean representation differ per engine and nothing
else does. Isolating those differences in one object is what makes "we are dropping
Oracle" a configuration change plus one file, rather than a rewrite.

**Filters are declarative and compiled, never concatenated.** The same
`WhereFilter<T>` compiles to SQL with bind parameters, to a MongoDB query document,
or to an in-memory predicate. Identifiers only ever reach the SQL through
`columnOf()`, which throws on an unmapped property; values are always bound. That
is the structural reason injection is not possible here — not escaping, but the
fact that user input never occupies an identifier position.

**Entity metadata is the single mapping.** One declaration gives the table name,
the property↔column mapping, the key, soft-delete support, audit columns and the
audit trail opt-in. All three drivers read it.

**The unit of work is per engine but uniform above.** `execute(work)` gets a scope
whose repositories are bound to the transaction; `lockRow` takes a real row lock in
SQL, and degrades honestly elsewhere.

---

## `monolite-http` — the metadata is the source of truth

A controller declares its routes on itself:

```ts
@ApiController("/branches", { tag: "Branches", token: BRANCH_TOKENS.controller })
export class BranchesController extends BaseController {
  constructor(context: IRequestContext) {
    super(context);
  }

  @Get("/", { query: listQuerySchema })
  list = async (req: Request, res: Response) => { /* ... */ };

  @Post("/", { body: createBranchSchema })
  create = async (req: Request, res: Response) => { /* ... */ };
}
```

Two consumers read that same metadata: the **router builder**, which turns it into
Express handlers (guard → validation → extra middleware → handler), and the
**OpenAPI builder**, which turns it into paths and operations. Having one source
means the documentation cannot drift from the routes — the class of bug where the
spec says `PATCH` and the server wants `PUT` simply cannot occur.

Route methods are **property decorators on arrow functions**, not method
decorators. Handlers are arrow-function properties so they keep `this` when Express
calls them detached; a method decorator would never see them.

Routes are sorted by specificity before mounting, so `/branches/active` is
registered before `/branches/:id` regardless of declaration order, and duplicates
are detected at startup rather than shadowing each other silently.

### Middleware order

Order is not cosmetic:

```
disable("x-powered-by")     don't advertise the stack
trust proxy                 a number, never `true` — see security.config
requestContext              first, so even a malformed body gets a requestId
helmet
rate limit                  /health* exempt, so a probe cannot be rate-limited out
cors                        allowlist from CORS_ORIGINS
express.json / urlencoded   extended: false
http logger
express.static
…routes…
notFoundHandler             404 in the same envelope, code ROUTE_NOT_FOUND
errorHandler                always last
```

`notFoundHandler` and `errorHandler` go **after** the documentation routes. An
Express error handler only covers what was registered before it, and a 404 handler
placed too early swallows Swagger.

---

## `monolite-crud` — five endpoints, all overridable

`@Crud()` registers `list`, `getOne`, `create`, `update` and `softDelete` for an
entity, each with validation, pagination and an OpenAPI entry. The decorator only
fills gaps: declare a method with the same name and yours wins. Add
`verbs: ["list", "getOne"]` and it registers only those.

`@Transactional()` opens a transaction around a BLL method and publishes it to
the ambient `ITransactionContext`, so every repository called inside joins it
without being passed anything. It *joins* an existing transaction rather than
nesting a second one.

`lockRow(transactions, entity, id)` is a standalone function rather than a base
class method, because a BLL that needs it may already extend something else and
TypeScript has no multiple inheritance. Taking a row lock as the first statement of
the transaction matters on MySQL, where REPEATABLE READ pins the snapshot at the
first read.

---

## `monolite-di` — a leaf on purpose

tsyringe resolves by string token, which means a typo in `@inject("IUsersServcie")`
compiles cleanly and only explodes when that class is constructed. `TOKENS` exists
so the compiler catches it instead.

Only *framework-level* tokens live in this package. Your feature tokens
(`IUsersBLL`, `IBranchesRepository`) belong to your app, registered from your
own module files, so a module is a file plus a line in the composition root — and
removing one is deleting both.

Lifetimes: plugins are singletons — the request context and the transaction context
*must* be, for the reason given above. Repositories, BLLs and controllers are
transient; they hold no state between requests.

---

## What this architecture costs

Being honest about the trade-offs:

- **A generic repository is not an ORM.** No relation mapping, no lazy loading, no
  migrations. Joins are your SQL, in your repository. That is deliberate — the
  moment the abstraction covers joins it stops being portable across six engines —
  but it is a real limit, not an oversight.
- **Six engines means the contract is the intersection, not the union.** Nothing in
  `IGenericRepository` can rely on a feature MongoDB lacks or Oracle spells
  differently. Engine-specific power is reachable, but only by dropping to the
  executor.
- **Decorator metadata is discovered at import time.** A controller in a file
  nobody imports does not exist. The same applies to DTO registration — this is the
  single most common cause of "my endpoint is missing from the OpenAPI document",
  and the reason generated projects have an explicit barrel file.
- **Ambient transactions are invisible in the signature.** `@Transactional()` reads
  well but does not show in the type of the method it decorates. That is the price
  of not threading a transaction parameter through every layer, and it is a price.

---

## See also

- [Data access](data-access.md) — the repository contract, dialects and filters
- [Decorated routes and OpenAPI](routing.md)
- [Generic CRUD](crud.md)
- [Authentication](authentication.md)
- [Testing](testing.md)
