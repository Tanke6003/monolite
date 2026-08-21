# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once they reach `1.0.0`.

Until then all packages share one version number and the public API may change in
a minor release. Pin exact versions.

## [Unreleased]

### Fixed

- **Thirty-two documented examples that did not compile.** The two worth naming:
  `docs/{en,es}/testing.md` told readers to
  `import { runRepositoryContract } from "monolite-data/testing"`, and neither
  half of that works — the package declares only `"."` in its `exports`, and the
  function is `runGenericRepositoryContract`, which takes the driver's name
  first; and `getting-started.md` described entity metadata that had been
  superseded entirely, then paged with a `page: { number, size }` that
  `QueryOptions` has never had. The rest were a `toDto` for `toDTO`, four
  `responses` refs missing the required `description`, module tokens looked for
  on the framework's `TOKENS`, controllers with no constructor to decorate, and
  `AuthService` called with an object where it takes positional arguments.
- **The generated API documentation.** Three separate faults, each of which
  served a 200 while showing nothing useful:
  - The DTO the scaffold writes was a plain TypeScript interface, so `Product`
    and `PaginatedProduct` were referenced by every operation of the example
    module and declared by none. It now goes through `defineDto` /
    `definePagedDto`, and `monolite-http` exports `missingSchemaRefs(document)`
    to name any reference that does not resolve — the generated `mountDocs`
    runs it at startup and logs what is missing, instead of leaving it to a
    reader to shrug at.
  - The generated `server.ts` called `helmet()` with its defaults, whose
    `script-src 'self'` blocks Scalar's CDN bundle and its inline bootstrap: the
    page came out blank. It now uses `buildHelmetOptions`, which leaves the CSP
    off until `CSP_ENABLED=true`, and the new `docsCspDirectives(reader)` widens
    the policy for the reader the project was scaffolded with when it is on.
  - A project generated with `--no-auth` documented an "Authorize" button, a
    `bearerAuth` scheme and a 401 on every operation, none of which exist.
    `buildOpenApiDocument` and `buildOpenApiPaths` take `secured: false`, and
    the scaffold passes it.
- **Scalar on Node 20.** The reader is an ESM-only package and the generated
  project compiles to CommonJS, so the static import became a `require()` of an
  ES module — which only works from Node 22. It is loaded with a dynamic
  `import()` now, which works on both.
- **`@Crud` prose.** The generated resource label carried an article, producing
  "No the product found with that id" in every document. The label is now bare.
- **The documented `@Crud` API.** Both READMEs and `docs/{en,es}/crud.md` showed
  `dto: branchDto, paged: true` and a generic `CrudController<T, TDto>`; none of
  the three has ever existed. `dto` is the *name* of an OpenAPI component,
  `paged` renames the page's component, and `CrudController` takes no type
  arguments.

### Added

- The generated project now uses the hardening `monolite-http` already shipped
  instead of a thinner copy of it: the per-IP rate limiter (health checks
  exempt), the allow-list CORS that exposes `X-Request-Id` and reports a blocked
  origin as the API's own error shape, `httpLogger` for one access line per
  request, and `healthRoutes` — which adds `/health` as an alias for readiness,
  the path a load balancer configured with the bare one expects.
- A project scaffolded with `--auth` puts the narrower login limiter on
  `POST /auth/login`, which is what `AuthController`'s second argument was for.
- `RATE_LIMIT_*`, `AUTH_RATE_LIMIT_*` and `CSP_ENABLED` are documented in the
  generated `.env.example` and README.
- **`monolite-di`** — `missingDataSourceEnv` names the variables the engine
  `DATA_SOURCE` picks cannot connect without, and `validateDataSourceEnv` throws
  with the list. Only the configured engine is checked, and only passwords are
  required: host, port, user and database all default to what the compose files
  in this repository serve. MongoDB asks for nothing, since its development
  container runs with authentication off — what it does reject is the halfway
  state, a `MONGO_USER` with no `MONGO_PASSWORD`.
- The generated composition root now always validates its environment, and asks
  `monolite-di` about the engine as well. A `POSTGRES_PASSWORD` left out of
  `.env` is a line in the boot log naming it, rather than a driver error on the
  first request that reaches for the database. Previously the hook checked
  `JWT_SECRET` alone, and only in a project scaffolded with authentication.
- `--docs=both` serves Swagger UI at `/docs` and Scalar at `/reference`. Both
  fetch `/openapi.json` rather than carrying a copy, so there is still one
  description of the API, and the CSP takes the wider of the mounted readers'
  policies — a project serving Scalar needs the CDN allowed whether or not
  Swagger UI is beside it.
- **An end-to-end suite in every generated project.** It drives the application
  rather than its helpers: health and the shape of a failure, the OpenAPI
  document and that every `$ref` in it resolves, the example module through
  create, read, update and soft delete, and — with `--auth` — the login route
  plus the guard in front of everything else, authenticating the way a client
  does instead of signing a token of its own. `tests/setup/test-env.ts` forces
  `DATA_SOURCE=memory` before a module loads, so the suite needs nothing
  installed; point the variable at an engine and the same tests run against it.
  `Server.configure()` is `run()` without the listening, so supertest drives the
  Express instance directly and the suite binds no port — it runs beside a `dev`
  server instead of fighting it for 3000.
- **The documentation's TypeScript is compiled in CI.** `scripts/docs` extracts
  every block from the guides, both root READMEs and each package's, and puts
  the self-contained ones through the compiler with `monolite-*` pointed at the
  sources in this tree — 82 of 88 blocks. The other six are fragments and are
  parsed rather than padded out. A second, cheaper check keeps the English and
  Spanish pages structurally in step, since a correction applied to one and not
  the other is the second way these pages have drifted.

## [0.1.0] — 2026-08-15

First extraction. The toolkit was pulled out of a working Express 5 + TypeScript
template and split into packages that can be adopted independently.

### Added

- **`monolite-core`** — `AppError` with a stable `code` and an `isOperational`
  flag; `normalizeError`, which turns any thrown value into a status plus a code,
  walking the `cause` chain so a driver error nested three levels deep is still
  classified; the `ILogger` and `IRequestContext` contracts; `AsyncRequestContext`,
  the `AsyncLocalStorage` request identity, with `SYSTEM_USER` for work outside a
  request; and `HealthProbe`, a cached readiness check with a timeout and a
  `beginShutdown()` that flips readiness before the process stops accepting.
  The package has no runtime dependencies.
- **`monolite-data`** — one `IGenericRepository<T>` implemented by three drivers
  (SQL, MongoDB, in-memory) covering six engines; `SqlDialect` isolating the
  per-engine differences (paging, identity retrieval, row locking, booleans);
  declarative filters compiled to SQL binds, a Mongo query document or an
  in-memory predicate; entity metadata as the single mapping, including soft
  delete, audit columns and an audit-trail opt-in; a unit of work per engine with
  `lockRow`; and a repository contract test kit any custom driver can run.
- **`monolite-http`** — `@ApiController` and the verb decorators, a router
  builder that turns their metadata into Express handlers, and an OpenAPI 3.1
  builder that turns the *same* metadata into the specification, so the two cannot
  drift; Zod validation middleware; a single error handler rendering the shared
  envelope; security defaults (helmet, an allowlist CORS, a rate limiter that
  exempts health probes, a numeric `trust proxy`); and an app factory that applies
  the middleware chain in an order that is load-bearing rather than cosmetic.
- **`monolite-crud`** — `CrudService` and `CrudController` plus a `@Crud()`
  decorator registering five endpoints per entity, each overridable by declaring a
  method of the same name; `@Transactional()` for ambient transactions that a
  repository joins without being handed a connection; and `lockRow` as a standalone
  function, so a service that needs it is not forced into a base class.
- **`monolite-auth`** — optional authentication: a login service that answers
  identically for an unknown email and a wrong password (and spends the same time
  doing it), JWT issuing and verification, a scrypt password hasher behind a
  swappable interface, and `requireAuth` / `requireRoles` guards that fail through
  `AppError` so the existing handler formats them.
- **`monolite-di`** — the tsyringe composition root, the framework-level token
  table, and the factories that turn `DATA_SOURCE` into a repository and
  `LOG_DRIVER` into a logger. Nothing else depends on this package.
- **`monolite-cli`** — `monolite new`, an interactive scaffolder that asks for
  SQL, NoSQL or no database, then the engine, then authentication and an example
  module; every answer also settable by flag, with `--yes` for a zero-prompt run.
  Plus `monolite generate` for modules, controllers, services and entities.
- Bilingual documentation under `docs/en/` and `docs/es/`.

### Notes

- Everything in the source is in English — identifiers, comments, messages. The
  original template was written in Spanish; the translation preserved the
  reasoning the comments carry rather than paraphrasing them.
- Database drivers are optional peer dependencies of `monolite-data`. A
  PostgreSQL project does not download the Oracle client.
