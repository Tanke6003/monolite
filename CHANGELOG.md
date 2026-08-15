# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once they reach `1.0.0`.

Until then all packages share one version number and the public API may change in
a minor release. Pin exact versions.

## [0.1.0] — 2026-08-15

First extraction. The toolkit was pulled out of a working Express 5 + TypeScript
template and split into packages that can be adopted independently.

### Added

- **`@monolite/core`** — `AppError` with a stable `code` and an `isOperational`
  flag; `normalizeError`, which turns any thrown value into a status plus a code,
  walking the `cause` chain so a driver error nested three levels deep is still
  classified; the `ILogger` and `IRequestContext` contracts; `AsyncRequestContext`,
  the `AsyncLocalStorage` request identity, with `SYSTEM_USER` for work outside a
  request; and `HealthProbe`, a cached readiness check with a timeout and a
  `beginShutdown()` that flips readiness before the process stops accepting.
  The package has no runtime dependencies.
- **`@monolite/data`** — one `IGenericRepository<T>` implemented by three drivers
  (SQL, MongoDB, in-memory) covering six engines; `SqlDialect` isolating the
  per-engine differences (paging, identity retrieval, row locking, booleans);
  declarative filters compiled to SQL binds, a Mongo query document or an
  in-memory predicate; entity metadata as the single mapping, including soft
  delete, audit columns and an audit-trail opt-in; a unit of work per engine with
  `lockRow`; and a repository contract test kit any custom driver can run.
- **`@monolite/http`** — `@ApiController` and the verb decorators, a router
  builder that turns their metadata into Express handlers, and an OpenAPI 3.1
  builder that turns the *same* metadata into the specification, so the two cannot
  drift; Zod validation middleware; a single error handler rendering the shared
  envelope; security defaults (helmet, an allowlist CORS, a rate limiter that
  exempts health probes, a numeric `trust proxy`); and an app factory that applies
  the middleware chain in an order that is load-bearing rather than cosmetic.
- **`@monolite/crud`** — `CrudService` and `CrudController` plus a `@Crud()`
  decorator registering five endpoints per entity, each overridable by declaring a
  method of the same name; `@Transactional()` for ambient transactions that a
  repository joins without being handed a connection; and `lockRow` as a standalone
  function, so a service that needs it is not forced into a base class.
- **`@monolite/auth`** — optional authentication: a login service that answers
  identically for an unknown email and a wrong password (and spends the same time
  doing it), JWT issuing and verification, a scrypt password hasher behind a
  swappable interface, and `requireAuth` / `requireRoles` guards that fail through
  `AppError` so the existing handler formats them.
- **`@monolite/di`** — the tsyringe composition root, the framework-level token
  table, and the factories that turn `DATA_SOURCE` into a repository and
  `LOG_DRIVER` into a logger. Nothing else depends on this package.
- **`@monolite/cli`** — `monolite new`, an interactive scaffolder that asks for
  SQL, NoSQL or no database, then the engine, then authentication and an example
  module; every answer also settable by flag, with `--yes` for a zero-prompt run.
  Plus `monolite generate` for modules, controllers, services and entities.
- Bilingual documentation under `docs/en/` and `docs/es/`.

### Notes

- Everything in the source is in English — identifiers, comments, messages. The
  original template was written in Spanish; the translation preserved the
  reasoning the comments carry rather than paraphrasing them.
- Database drivers are optional peer dependencies of `@monolite/data`. A
  PostgreSQL project does not download the Oracle client.
