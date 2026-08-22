# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once they reach `1.0.0`.

Until then all packages share one version number and the public API may change in
a minor release. Pin exact versions.

## [Unreleased]

### Fixed

Everything in this section was found the same way: by running the packages
against the five engines they claim to support, which had never happened. The
unit suite verified them against an array and two doubles, and each of these
passed every one of those tests.

- **The SQL driver never wrote the soft-delete flag.** A row inserted without it
  landed `NULL` — neither the active value nor the deleted one — so
  `WHERE ACTIVE = 1` never matched it: the insert reported success and the row
  was invisible to every read that followed. The memory driver filled the
  property and the MongoDB one wrote the state into the document, with a comment
  saying the repository is what completes it. The driver that speaks to four of
  the six engines was the one that did not, and the shared contract had only
  ever been run against the two that were already right.
- **`ON DELETE RESTRICT` is not valid on two of the four SQL engines**, and
  `restrict` is the default every relation gets — so **no generated schema
  could be created on SQL Server at all**. T-SQL has no `RESTRICT`; Oracle has
  neither that nor `NO ACTION` and expresses the same thing by omitting the
  clause. The rule is now the dialect's to spell, like every other difference
  between engines.
- **`executeRaw` could not call a stored procedure on MySQL.** The documented
  escape hatch, on one of the six engines. `CALL` answers with more than one
  result set, and one that only writes answers with none at all — which reached
  `results.map` inside Sequelize and threw. The affected-row count was worse
  than broken: for an INSERT the driver answers `[insertId, affected]`, so the
  connector was reading a row's id and reporting it as a count. A bulk insert of
  two rows reported nine, which was simply where the auto-increment happened to
  be.
- **`like` was case-insensitive on MySQL and SQL Server.** The filter language
  promises `like` distinguishes case and `ilike` does not; both engines default
  to a case-insensitive collation, so the two operators quietly meant the same
  thing there. One operator meaning two things depending on the engine is
  precisely what the shared contract exists to forbid. MySQL now casts the
  pattern and SQL Server collates the column, each through its own dialect.
- **A `CREATE PROCEDURE` run through the connector came back corrupted on SQL
  Server.** `expects: "none"` appends `; SELECT @@ROWCOUNT` to read the count
  back, and a T-SQL procedure body extends to the end of its batch — so the
  probe was compiled *into* the procedure, which then returned a spurious row to
  every caller forever. Statements that own their batch skip the probe.
- **An audit of every markdown file.** The mechanical checks came back clean —
  every link resolves, every path cited exists, every documented symbol is still
  exported — and reading found the rest: `README.es.md` three changes behind
  the English one, a wizard question table that had authentication defaulting to
  yes when it defaults to no and omitted a whole prompt, a `README.md`
  announcing version 0.1.0, and `monolite-http` — the largest surface of the
  seven packages — with no export table at all.
- **The MongoDB connector accepted no connection options.** No
  `directConnection`, no `replicaSet`, no `tls`, no `readPreference` — the URI
  was built from host, port and credentials and nothing else. That made every
  replica set behind a port mapping, a tunnel or a load balancer unreachable,
  which is every one a developer runs locally; and since a MongoDB transaction
  *requires* a replica set, the engine's transaction support was documented
  while the standard way of running one could not be connected to.
  `MongoConnectionConfig.options` and `MONGO_OPTIONS` carry the query string.
### Added

- **The rest of what a public repository needs.** The enhancement form told
  people to open a bug report instead, and there was no bug report — that was
  the entire issue-template set. There is now one for a bug, one for
  documentation, a pull-request template asking for the three things reviews
  here keep asking for, a security policy that routes a vulnerability somewhere
  other than a public issue, and a code of conduct written for a project that
  argues about design in the open.
- **An integration suite over every engine, and a CI job that runs it.**
  `docker/integration/docker-compose.yml` brings up PostgreSQL, MySQL, SQL
  Server, MongoDB and Oracle Free; `npm run test:integration` runs 270 checks
  across all five. It applies the schema `emitSchema` generates — so a green run
  is a statement about the DDL generator too — then runs the shared repository
  contract, multi-table transactions committing and rolling back, row locks, and
  stored procedures that read, that write, and that get rolled back with the
  transaction that called them.

  An engine that was asked for and is not reachable **fails** the run rather
  than skipping it. A suite that quietly verifies nothing is worse than one
  nobody runs, because CI goes on reporting that it passed.

### Changed

- **The application layer is called the BLL now, everywhere.** `CrudService` is
  `CrudBLL`, `ICrudService` is `ICrudBLL`, `CrudServiceOptions` is
  `CrudBLLOptions`, `TransactionalService` is `TransactionalBLL`, and in
  `monolite-auth` `AuthService`, `IAuthService`, `AuthServiceOptions`,
  `ITokenService`, `JwtTokenService` and `JwtTokenServiceOptions` follow the
  same rule. Generated projects get `application/bll/<name>.bll.ts`, a
  `<ENTITY>_TOKENS.bll` key, and `monolite generate bll`.

  **This is a breaking change** and it is a rename, nothing else: no signature,
  no behaviour and no wiring moved. Upgrading is a find-and-replace of the names
  above plus the directory. `monolite generate service` still resolves, to
  `bll`, and says what it resolved to — an unrecognised subcommand is the worse
  answer when the thing it asks for still exists.

  Three uses of the word survive untouched because they are not the layer:
  `SERVICE_NAME` and the logger field built from it, docker-compose's
  `services:`, and Oracle's own term for a database.

  **Upgrading an existing project**, in the order the compiler will ask for it.
  Applied to the reference demo, it was these six substitutions, a directory
  rename, and nothing else — 36 files, no behaviour touched:

  | From | To |
  | --- | --- |
  | `CrudService`, `ICrudService`, `CrudServiceOptions` | `CrudBLL`, `ICrudBLL`, `CrudBLLOptions` |
  | `TransactionalService` | `TransactionalBLL` |
  | `AuthService`, `IAuthService`, `AuthServiceOptions` | `AuthBLL`, `IAuthBLL`, `AuthBLLOptions` |
  | `ITokenService`, `JwtTokenService`, `JwtTokenServiceOptions` | `ITokenBLL`, `JwtTokenBLL`, `JwtTokenBLLOptions` |
  | `AUTH_TOKENS.ITokenService`, `AUTH_TOKENS.IAuthService` | `AUTH_TOKENS.ITokenBLL`, `AUTH_TOKENS.IAuthBLL` |
  | `src/application/services/*.service.ts` | `src/application/bll/*.bll.ts` |

  The one that is easy to miss is your **own** token tables: the key is
  `service` and its value is usually `"I<Plural>Service"`, and both are yours
  rather than the framework's. Rename them to `bll` / `"I<Plural>BLL"` to stay
  with what the generator now writes — nothing forces you to, since they are
  only strings, but a project where half the tokens read one way is worse than
  either.

### Added

- **`monolite generate repository <entity>`.** An existing entity's store plus
  its own queries, on `executeRaw` — the escape hatch for the entity you *own*,
  where `generate query` is the one for an answer computed across several. It
  extends `BaseModuleRepository`, so the whole contract is forwarded and every
  call is wrapped in a guard that logs the driver's error and re-throws a
  neutral one.

  It is deliberately not part of `generate module`: `defineEntity` already
  produces a working repository, and a class that forwards seventeen methods and
  adds nothing is a layer for the sake of having one.

  The binding it needs goes into a file you already own, so it goes through a
  marker of its own — `// monolite:bindings`, which `generate module` now
  writes into every module's `register` function. No marker, no edit: the two
  lines are printed instead. The token was already declared by `generate
  module` and simply goes unbound until there is something to bind to it, which
  saves the generator from reopening the token table.

### Fixed

- **The generated project's README described a layout it had not had since
  0.5.0.** It told the reader the CLI prints three lines to add by hand in
  `composition/entities.ts`, `composition/container.ts` and
  `presentation/routes.ts` — a file that no longer exists and a workflow the
  module descriptor replaced with one line the generator inserts itself. Its
  directory tree listed `entities.ts` too, and the module the generator writes
  still told you to add its registration there.
- **The package documentation was missing everything shipped in 0.6.0 and
  0.7.0.** `transactionAware`, `IRawQueryable` / `asRawQueryable`,
  `RelationMetadata` / `IndexMetadata`, the whole schema-generation surface,
  `MonoliteModule` / `entitiesOf` / `registerModules` and the fact that
  `registerPersistence` wraps the stores it binds are all in the READMEs now,
  with the guides they belong to linked from them.

- **The scaffold suite could fail on a mistake the previous run made.** It
  generated into one fixed directory and removed it on the way out, and on
  Windows a directory a just-closed server still holds is briefly undeletable —
  so `rmSync` threw part way through and left a tree with some of its folders
  gone. The next run generated into what was left and failed an assertion about
  files the generator had written perfectly well, which is two runs of debugging
  the wrong thing. Each run now works inside a directory named after its own
  process, and prunes on the way in as well as out.

- **`@Transactional()` opened a transaction the repositories did not join.** The
  guides have always said that every repository called inside one joins it and
  that nothing is passed. Only `BaseModuleRepository` did, and a module has to
  extend it; the stores the container binds are the driver's own, on
  auto-commit. So a service that injected one and decorated its method opened a
  transaction and then wrote outside it, on another connection — three
  statements on three auto-commits, which look exactly like one transaction
  until something in the middle throws and half the work is already committed
  with nothing left to roll back. It did not reproduce in memory either, where
  the transaction hands back the very same repository object, so a generated
  suite passed and the same code lost writes the first time it met a real
  engine. `registerPersistence` now wraps every store it binds in
  `transactionAware`, which resolves the live one per call: the transaction's
  while one is open, the pool's otherwise. Layers built without a transaction
  context are untouched and keep the plain store.

- **The release could publish and then fail to record what it published.** It
  pushed the version commit *after* the seven `npm publish` calls, on the
  reasoning that the irreversible step should go last. The reasoning had the
  trade backwards: a push is not a formality that either works or is worth
  retrying — it can be **rejected**, permanently, because somebody merged while
  the run was building. That is what happened to v0.4.0: seven packages on the
  registry, a tag pointing at a commit no branch contained, and a manifest still
  saying 0.3.0. The push now comes first and is `--atomic`, so the branch and
  the tag succeed or fail together; a rejection ends the run with nothing
  published and leaves the release to the newer push, which has a run of its
  own.
- **A half-finished release used to be unrecoverable without hand surgery.** The
  next version was computed from the manifest alone, so a manifest left behind
  by an interrupted run made every subsequent run decide on a version that was
  already tagged, and die on it — for ever. The base is now the higher of the
  manifest and the newest tag, which turns exactly that state into the next
  release instead of a loop.
- **`monolite-data/testing` resolves.** The manifest declared only `"."`, so the
  subpath the testing guide had always told readers to import from was
  resolvable by nobody. The kit keeps its root export as well, so nothing that
  already imports it has to move.

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

- **DDL from the entity metadata: `db:sql` and `db:migration`.** This was the
  largest gap in the toolkit. `defineEntity` already carried every fact a
  `CREATE TABLE` needs — physical names, types, the key and whether it is
  generated, the soft-delete flag, the timestamps, the audit columns and, since
  relations were declared, the foreign keys — and none of it was used for that.
  So the schema was maintained twice: once as metadata the code reads, once as
  SQL written by hand, with nothing checking that the two agreed.

  They disagree in ways that are hard to guess at. The mapping writes a boolean
  as `1` and `0`, so a column declared `BOOLEAN` in PostgreSQL rejects every
  insert the repository makes — a demo lost an afternoon to exactly that before
  the column became `SMALLINT`, which is what the generator emits. Oracle,
  SQL Server, PostgreSQL and MySQL each get their own type map;
  `ddlDialectFor` answers `null` for the two engines that have no schema
  rather than pretending to have one.

  A generated project gets two scripts over the same `MODULES` list the
  application is built from: `db:sql` writes the whole schema, and
  `db:migration -- <name>` writes what changed since the last one. They live in
  the project because `monolite-cli` has no runtime dependencies and cannot
  load your entities; your project already has them.

  **When nothing changed, no migration is written** — a tool that emits an empty
  file every run teaches people to stop reading its output. Anything that
  destroys data is written commented out. And a rename is emitted as a drop and
  an add with a note saying so, because nothing in the mapping distinguishes the
  two and guessing would silently drop a populated column.

  **There is no runner, on purpose.** The output is plain SQL for umzug,
  node-pg-migrate, Flyway or `psql < file`. Owning a runner means owning an
  applied-migrations table, locking, ordering and rollback, and a toolkit you
  adopt one package at a time should not make you switch migration tools to use
  its entity mapping. Generating at startup was rejected for a shorter reason: a
  process that alters a schema on boot alters production on a bad deploy.

  Verified against PostgreSQL 16 end to end — script applied, columns, keys,
  constraints and indexes read back from `information_schema`, and a generated
  migration applied to a live table.
- **Five optional fields on the mapping, read by the generator and nothing
  else.** `length` (255, or `"max"`), `precision`/`scale`, `nullable` (true,
  except the key), `unique`, `default` (literal SQL), plus `indexes` on the
  entity for the composite case. An entity that sets none of them still maps,
  queries and writes exactly as before.
- **`monolite generate query <name> --over <entity>`.** The shape you reach for
  when the generic API runs out — aggregations, `GROUP BY`, views, stored
  procedures — is four files written from a blank page: a small interface of
  your own, an implementation on `executeRaw`, a service, a controller. It is
  also the only place in a monolite project where the layering can go wrong, and
  it did: writing a report by hand, the repository went into the controller and
  returned the shape the client sees. Every `@Crud` module has it right without
  anyone thinking about it, because `CrudController` takes an `ICrudService`
  and will not take anything else. The schematic writes the four files with the
  layering already correct, plus the tokens and a module descriptor, and wires
  it into `composition/modules.ts` like any other. `--over` names the entity it
  reads, which is the one thing that cannot be derived from the name typed; the
  generated repository narrows that store with `asRawQueryable` and ships the
  in-process fallback, so it answers on the in-memory driver too.
- **`IRawQueryable<T>` and `asRawQueryable(store)`, in `monolite-data`.**
  `executeRaw` is the documented escape hatch and it lived on no interface, so a
  module injecting its store as `IGenericRepository<T>` — which is what the
  container binds — could not see it, and every project needing a report would
  invent its own narrowing. It is not on `IGenericRepository` because the
  in-memory and MongoDB drivers have no SQL to run and a contract whose
  implementations throw is not a contract; `asRawQueryable` returns `null`
  there, which is what tells a report to use its fallback.
- **A module may own no table.** `MonoliteModule.registration` is optional and
  `entitiesOf` filters rather than maps, so a report, a search across several
  tables, a dashboard, an import job or a webhook receiver joins the one list
  instead of being registered by hand in the composition root. Nothing that has
  an entity changes.
- **The layering rule is written down.** `docs/{en,es}/architecture.md` stated
  the dependency rule, which is about direction — and a controller reaching past
  the application layer into infrastructure obeys it as written. It now says the
  other thing, with the reason: what a client may see and what the answer means
  both belong a layer below where a controller sits.
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
- **`CrudService.resolveQuery`**, an asynchronous hook that runs before
  `buildWhere` and hands it a completed query. `buildWhere` stays synchronous on
  purpose — it is the hook every module overrides, and one that could await would
  put a query in front of every listing in the project. Some filters do have to
  read somewhere else first, though ("books whose author is called Le Guin" is
  two steps, not one), and without a seam for that step a module had to override
  `list` itself and copy the paging, the ordering and `withDeleted` along with
  it. Overriding nothing costs nothing.
- **Relations declared once instead of hydrated by hand.** `include()` describes
  a relation where a service is constructed, and `CrudService` resolves it in the
  one place `list`, `getOne`, `create` and `update` all go through.
  `loadRelated` was always the right primitive; where it had to be *called* was
  the problem — four sites, none of them enforced, and forgetting two produces a
  resource that carries its relation when it was read and not when it was
  written, with a DTO that says the field is there either way. The mapper marks
  such a field with `hydrated()`, and a field carrying that marker with no
  include behind it **stops the service being constructed**, naming the field,
  while the container is still being assembled. Still one batched
  `WHERE key IN (…)` per relation per page, and none at all when every key is
  null. The third constructor argument keeps accepting a bare `OrderByClause`,
  so nothing already written has to change.
- **The documentation's TypeScript is compiled in CI.** `scripts/docs` extracts
  every block from the guides, both root READMEs and each package's, and puts
  the self-contained ones through the compiler with `monolite-*` pointed at the
  sources in this tree — 82 of 88 blocks. The other six are fragments and are
  parsed rather than padded out. A second, cheaper check keeps the English and
  Spanish pages structurally in step, since a correction applied to one and not
  the other is the second way these pages have drifted.
- **A documented response that names a component no longer has to describe
  itself.** `{ 201: { ref: "Appointment" } }` is enough; OpenAPI still requires a
  description on a response object and the builder emits one from the status
  code's reason phrase. `description` remains available and wins when given, and
  a code the table does not know says `Status 418` rather than a confidently
  wrong phrase. Four documented examples had been written in the short form and
  none of them compiled, which was the argument.
- **`monolite-data/testing`**, the repository contract kit on a subpath of its
  own. It is a test kit rather than part of the runtime surface, and the guide
  had been pointing at that path since before it existed.
- **`CrudHandler`**, the type of the five CRUD handlers. Overriding a verb is the
  documented way to give a module a rule `@Crud` cannot know, and it used to mean
  repeating a signature down to the Express generics — both documented examples
  got it wrong. `public override create: CrudHandler = async (req, res, next) =>`
  infers all three parameters.
- **Relations declared in the entity metadata.** `relations: { author: { to,
  localKey, foreignKey, onDelete } }` gives a foreign key a name, where before it
  was a `kind: "number"` column that happened to look like one. It is
  declarative and inert — the repository does not read it, knows one table and
  fires no join — and `onDelete` is what the generated DDL should say and
  nothing more, since there is no cascade to run at query time. What it replaces
  is one fact stated three times: the constraint in generated DDL, the relation
  the module generator needs to scaffold a related module, and the keys a reader
  would otherwise find by reading two files. A relation pointing at an entity
  nobody registered fails while the persistence layer is being assembled, naming
  both sides — not later, when something follows it, because nothing does.
- **`monolite generate module` wires the module it wrote.** A generated module
  used to need three lines in three files — its registration in `entities.ts`,
  its bindings in `container.ts`, an import in `routes.ts` — none of them a
  decision, and any of them forgettable into a module that compiles perfectly
  and is never served. A `MonoliteModule` carries all three together, so
  `composition/modules.ts` is now the only list and wiring is one line in it,
  which is small enough for a generator to insert and a reviewer to check. What
  made the old version unsafe to automate was never the editing; it was that the
  edits were spread out. The licence comes from a `// monolite:modules` marker
  the scaffold writes: move it, rename it or delete it and nothing is touched,
  and the command prints the line as it always did. `--no-wire` says the same on
  purpose. No AST is involved, deliberately — the CLI has no runtime
  dependencies and adding one to insert a line would spend that promise on the
  cheapest edit in the project. `src/composition/entities.ts` is gone.

### Removed

- **`composition/entities.ts`** in generated projects. Its one list is derived
  from `MODULES` now. Projects generated before this keep working exactly as
  they are; nothing in the packages reads the file.

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
