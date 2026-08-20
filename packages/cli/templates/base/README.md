# __projectName__

__projectDescription__

Scaffolded with [`monolite-cli`](https://www.npmjs.com/package/monolite-cli). It runs on
Express 5 and TypeScript, laid out as Clean Architecture, and persists through __engineSentence__.

## Getting started

```bash
__pmInstall__
cp .env.example .env
<!-- #if docker -->
docker compose up -d __dockerService__
<!-- #endif -->
__pmRun__ dev
```

Then:

```bash
curl http://localhost:3000/health/ready
curl http://localhost:3000/openapi.json
<!-- #if example -->
curl http://localhost:3000__apiPrefix__/products
<!-- #endif -->
```
<!-- #if docs -->

The API describes itself:
<!-- #if swagger -->

- Swagger UI — [http://localhost:3000__swaggerPath__](http://localhost:3000__swaggerPath__)
<!-- #endif -->
<!-- #if scalar -->
- Scalar — [http://localhost:3000__scalarPath__](http://localhost:3000__scalarPath__)
<!-- #endif -->
- the document itself — [http://localhost:3000/openapi.json](http://localhost:3000/openapi.json)

The readers fetch that same document rather than carrying a copy, and it is
generated from the decorator metadata that produced the routes, so none of the
three can drift from the API or from each other.

All of them are governed by `DOCS_ENABLED`, on outside production.
<!-- #else -->

`/openapi.json` is the API's own description, generated from the decorator metadata
that produced the routes. Nothing is mounted to read it with — point Swagger UI or
Scalar at it, or scaffold with `--docs=` next time. It is governed by `DOCS_ENABLED`,
on outside production.
<!-- #endif -->

<!-- #if docker -->
> `.env.example` ships placeholder credentials. Put the real password in `.env`, which is
> git-ignored — that is the whole reason the two files exist.

<!-- #endif -->
<!-- #if auth -->
> Set `JWT_SECRET` in `.env` before starting. Generate one with `openssl rand -hex 32`.

<!-- #endif -->

## Scripts

| Script | What it does |
| --- | --- |
| `__pmRun__ dev` | Runs `src/main.ts` through `tsx`, restarting on change |
| `__pmRun__ build` | Compiles to `dist/` |
| `__pmRun__ start` | Runs the compiled build |
| `__pmRun__ test` | Jest |
| `__pmRun__ lint` | ESLint over `src` and `tests` |
| `__pmRun__ typecheck` | `tsc --noEmit` |
| `__pmRun__ check` | Typecheck, lint and test — what CI should run |

## Tests

`__pmRun__ test` runs both suites and needs nothing running: `tests/setup/test-env.ts`
forces `DATA_SOURCE=memory`, so the end-to-end tests get the real repository, the real
services and the real routes without a container to bring up first. Point that variable
at an engine to run the very same tests against one.

They drive the application in memory through supertest — no port is bound, so the suite
runs beside a `__pmRun__ dev` that is already going. What they exercise is everything
above the socket: the middleware chain in its real order, the routes the decorators
produced, the validation, the error envelope and the document.

## Layout

```
src/
  main.ts                     Startup, graceful shutdown
  server.ts                   Middleware chain and the health endpoints
  config/env.ts               Reading configuration; pure, and unit tested
  composition/
    container.ts              Composition root: what implements what
    entities.ts               The entities the persistence layer is built from
<!-- #if auth -->
    auth.module.ts            Login, token service and hasher, wired up
<!-- #endif -->
    modules/                  One registration file per feature module
  domain/models/              Entities, as plain interfaces
  application/
    dtos/                     What crosses the HTTP boundary, plus its validation
    services/                 Use cases
  infrastructure/
    logger.ts                 ILogger over stdout, dependency free
    persistence/entities/     Entity to table mapping
  presentation/
    routes.ts                 Mounts every decorated controller
    controllers/              One controller per module
<!-- #if auth -->
  auth/
    seed-user.provider.ts     Where the login looks users up. Replace this.
<!-- #endif -->
tests/
  setup/test-env.ts           The environment every test runs in
  smoke.test.ts               Configuration helpers, with nothing standing up
  e2e/
    support/api.ts            The application, configured once and never listening
    health.e2e.test.ts        Liveness, readiness and the shape of a failure
    openapi.e2e.test.ts       The document, and that every `$ref` in it resolves
<!-- #if auth -->
    auth.e2e.test.ts          Login, and the guard in front of everything else
<!-- #endif -->
<!-- #if example -->
    product.e2e.test.ts       The example module, through the whole chain
<!-- #endif -->
```

<!-- #if !example -->
The module directories are empty for now: this project was generated without the example
module. `monolite generate module <name>` fills them in.
<!-- #endif -->

The layering rule is the usual one and it is worth keeping: `domain` knows nothing,
`application` knows `domain`, `infrastructure` and `presentation` know both, and only
`composition` knows all four. Anything importing in the other direction is the first
sign of a module that wants to be split.

## Configuration

Everything is read from the environment through `src/config/env.ts`. The variables that
matter, with the defaults this project was generated with:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port the HTTP server binds |
| `API_PREFIX` | `__apiPrefix__` | Where the API is mounted |
| `DATA_SOURCE` | `__dataSource__` | Which driver `monolite-data` builds |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma separated. Empty = same origin only |
| `BODY_LIMIT` | `1mb` | Maximum JSON body |
| `TRUST_PROXY_HOPS` | `0` | Trusted proxies in front of the app |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window of the per-IP quota |
| `RATE_LIMIT_MAX` | `120` | Requests per window. `0` disables the limiter |
| `CSP_ENABLED` | `false` | Content-Security-Policy. Off so the docs page renders |
| `DOCS_ENABLED` | unset | Empty = on everywhere except production |
| `LOG_LEVEL` | `debug` | `trace` to `error` |
| `SHUTDOWN_DELAY_MS` | `0` | Gap before the socket closes, for rolling deploys |
<!-- #if auth -->
| `JWT_SECRET` | placeholder | Signing key. Required |
| `AUTH_RATE_LIMIT_MAX` | `10` | Login attempts per window. `0` disables it |
<!-- #endif -->

The health checks are exempt from the limiter, so a load balancer probing every few
seconds does not exhaust the quota of its own address.
<!-- #if db -->

The process refuses to start when a variable the configured engine cannot connect
without is missing — `DATA_SOURCE=__engineId__` needs its password — and says which
one in the boot log. Only the engine in `DATA_SOURCE` is checked; the others are
nobody's problem until they are chosen.
<!-- #endif -->

Changing `API_PREFIX` moves the whole surface; it does not create a version. A real v2
means a second router, because the contract is the code.

## Adding a module

```bash
npx monolite generate module invoice
```

That writes the entity, its table mapping, the DTO with its validation, the service, the
controller and the registration file — the same seven files the example module is made
of. The CLI prints the three lines you then add yourself, in `composition/entities.ts`,
`composition/container.ts` and `presentation/routes.ts`: a generator that edits your own
files is a generator that eventually mangles them.

The entity has to be listed in `composition/entities.ts` rather than registering itself,
and that is not an oversight: the unit of work indexes the repositories by entity name
when the persistence layer is assembled, so an entity that arrived later would have a
store and no seat in any transaction.

The individual pieces are available too: `generate entity`, `generate service`,
`generate controller`.

## How a module fits together

A plain CRUD module writes no query and no route:

- **`domain/models/*.model.ts`** — the entity, as an interface. No decorators, no base
  class, nothing from the framework.
- **`infrastructure/persistence/entities/*.entity.ts`** — `defineEntity` maps it to a
  table. This is the only file that names a column; from here `monolite-data` generates
  the whole CRUD.
- **`application/services/*.service.ts`** — extends `CrudService`, which already knows
  how to page, map and soft delete. A module with a real rule overrides the one verb
  that has it and keeps the rest.
- **`presentation/controllers/*.controller.ts`** — `@ApiController` gives it a prefix,
  `@Crud` mounts the five routes with their validation and their documentation. To take
  over one verb, drop it from `verbs` and declare it by hand with `@Get` / `@Post`.

<!-- #if docker -->
## The database

`docker-compose.yml` brings up __engineLabel__ and nothing else — the compose file was
generated for the engine this project chose. The application never creates tables: the
generic repository reads and writes them, so the schema is yours to manage, by migration
or by hand.
<!-- #endif -->
<!-- #if memory -->
## The database

There is none. `DATA_SOURCE=memory` keeps everything in the process, which is what makes
this project runnable with nothing installed and its tests fast. The data is gone when
the process is.

Moving to a real engine is: add the driver, set the connection variables, and change
`DATA_SOURCE`. Nothing in `application/` or `presentation/` changes — that is the point
of the generic repository.
<!-- #endif -->

## License

__projectLicense__
