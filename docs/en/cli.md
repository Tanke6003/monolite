# CLI reference

> 🇪🇸 [Leer en español](../es/cli.md) · package: `monolite-cli`

```bash
npm install -g monolite-cli
monolite new my-api
```

The CLI has **no runtime dependencies**. Flags are parsed with Node's own
`util.parseArgs`, prompts are built on `readline/promises`, and colour is raw ANSI
that switches itself off when `NO_COLOR` is set or stdout is not a terminal. A
scaffolder that pulls in a dependency tree to ask four questions has its priorities
backwards.

---

## `monolite new [name]`

Alias: `monolite init`.

Interactive by default. Every question has a flag, and a question whose flag was
given is not asked. `--yes` answers all of them with their defaults and prompts for
nothing — that is what makes the command usable from CI.

```bash
monolite new billing-api
monolite new billing-api --database=postgres --auth --example --yes
monolite new tiny --database=none --no-auth --no-example --yes --skip-install --skip-git
```

### Project

| Flag | Default | Effect |
| --- | --- | --- |
| `name` (positional) | the target directory's name | `package.json` name, README title |
| `--directory=<path>` | `./<name>` | Where to write |
| `--project-version=<v>` | `0.1.0` | The generated `package.json` version |
| `--description=<text>` | — | `package.json` and the README subtitle |
| `--author=<name>` | — | `package.json` |
| `--license=<id>` | `MIT` | SPDX identifier |
| `--api-prefix=<path>` | `/api/v1` | Where controllers mount |

### Database

| Flag | Default | Effect |
| --- | --- | --- |
| `--database=<engine>` | `postgres` | See the table below |
| `--db-host=<host>` | `localhost` | |
| `--db-port=<port>` | the engine's | Matches the generated `docker-compose.yml` |
| `--db-name=<name>` | | The database; for Oracle, the service name |
| `--db-user=<user>` | | The application user |

Accepted engines, with their aliases:

| Family | Values |
| --- | --- |
| None | `none`, `memory`, `in-memory`, `inmemory`, `dummy` |
| SQL | `oracle`/`oracledb`, `sqlserver`/`sql-server`/`mssql`, `postgres`/`postgresql`/`pg`, `mysql`/`mariadb` |
| NoSQL | `mongo`/`mongodb` |

**There is no `--db-password`, on purpose.** A password passed on the command line
lands in a file that gets committed, and in the shell history on the way there.
`.env.example` ships a placeholder and the closing summary says where to put the
real value.

### Contents

| Flag | Default | Effect |
| --- | --- | --- |
| `--auth` / `--no-auth` | on | Adds `monolite-auth`, a login module and a guard |
| `--example` / `--no-example` | on | A sample CRUD module, end to end |
| `--docs=<reader>` | `swagger` | Which reader is mounted over the OpenAPI document |

The document itself is never optional: it is built from the same decorator
metadata that produced the routes, so it costs nothing to publish and cannot
drift from the implementation. `--docs` chooses what, if anything, is mounted
to read it with.

| `--docs` | Mounts | Notes |
| --- | --- | --- |
| `swagger` | Swagger UI at `/docs` | Bundles its own assets, so it works offline |
| `scalar` | Scalar at `/docs` | Loads the reader from a CDN; point `cdn` at a local copy if there is no outbound internet |
| `both` | Swagger UI at `/docs` and Scalar at `/reference` | Two pages over one document; they fetch it rather than carry a copy |
| `none` | nothing | `/openapi.json` is still served |

Both readers are pointed at `/openapi.json` rather than handed the document, so
there is one source for it. `DOCS_ENABLED` governs the whole lot and is on
outside production — the document describes the entire surface of the API,
validation rules included.

### Afterwards

| Flag | Default | Effect |
| --- | --- | --- |
| `--pm=<npm\|pnpm\|yarn>` | `npm` | Which lockfile and install command |
| `--install` / `--skip-install` | install | |
| `--git` / `--skip-git` | init | |
| `--force` | off | Write into a directory that is not empty |
| `-y`, `--yes` | | Take every default, ask nothing |

The generator refuses to write into a non-empty directory without `--force`, and
prints every file it created plus the next steps.

---

## What you get

```
my-api/
├── .editorconfig
├── .env.example              placeholders, never a real secret
├── .gitignore
├── docker-compose.yml        only the chosen engine — absent for in-memory
├── eslint.config.mjs
├── jest.config.js
├── package.json              only the driver the engine needs
├── tsconfig.json
├── README.md
├── src/
│   ├── main.ts               bootstrap and the four-step graceful shutdown
│   ├── server.ts             the middleware chain and where controllers mount
│   ├── composition/          the container and the token table
│   ├── config/env.ts
│   ├── infrastructure/
│   │   ├── logger.ts
│   │   └── persistence/data-source.ts   the engine-specific wiring
│   ├── composition/modules.ts        the one list a module is added to
│   ├── scripts/              db:sql and db:migration, over that same list
│   └── presentation/routes.ts           mounts every decorated controller
└── tests/smoke.test.ts       passes on the first run
```

The project builds and its test suite passes before you write a line. That is the
contract the CLI holds itself to, and CI checks it on every push by generating two
projects and running them.

---

## The scripts a project ships with

Two of them are not about running the application, and they are the reason the
scaffold no longer tells you to go and write the schema yourself.

| Script | What it does |
| --- | --- |
| `npm run db:sql` | `CREATE TABLE` for every registered entity, per dialect |
| `npm run db:migration -- <name>` | What changed since the last one, as a timestamped `.sql` |

```bash
npm run db:sql -- --out db/schema.sql
npm run db:migration -- add-invoice-notes
```

They live in the project rather than in the CLI, and that is not an accident:
`monolite-cli` has **no runtime dependencies** and therefore cannot load your
entities. Your project already has them. See
[data access](data-access.md) for what the mapping needs to say, for why there is
no migration runner, and for the one thing a diff cannot see.

---

## `monolite generate <schematic> <name>`

Alias: `monolite g`.

```bash
monolite generate module invoice
monolite g entity payment-method
monolite g query revenue --over invoice
```

| Schematic | What it writes |
| --- | --- |
| `module` | Entity + store registration + BLL + controller, wired with `@Crud` |
| `entity` | The domain interface and its table mapping |
| `bll` | A `CrudBLL` subclass for an existing entity |
| `controller` | A `CrudController` subclass for an existing BLL |
| `query` | Repository + BLL + DTO + controller, for what the generic API cannot express |
| `repository` | An existing entity's store plus its own queries, on `executeRaw` |

### `generate query`

Aggregations, `GROUP BY`, views and stored procedures are outside the generic
API on purpose — expressing them would turn it into an ORM. What you write
instead is four files: a small interface of your own, an implementation on
`executeRaw`, a BLL, a controller.

```bash
monolite g query revenue --over invoice
```

```
src/infrastructure/persistence/revenue.repository.ts   interface + implementation
src/application/dtos/revenue.dto.ts                    the published shape
src/application/bll/revenue.bll.ts                     rows -> DTO
src/presentation/controllers/revenue.controller.ts     injects the BLL
src/composition/modules/revenue.tokens.ts              its three identifiers
src/composition/modules/revenue.module.ts              its bindings, no registration
```

`--over` is required and names the entity the query reads: it is the one thing
that cannot be derived from the name you typed. The generated repository injects
that entity's store, narrows it with `asRawQueryable` and ships the in-process
fallback for the drivers that have no SQL — which is the branch your generated
test suite actually runs.

The module it writes carries **no registration**, because a query owns no table.
It still goes in `composition/modules.ts` like everything else, which is the
whole reason it can be generated at all.

The aggregate it computes — how many rows, the lowest and highest id — is a
placeholder, true of any table so that the module answers before you have
written a line. Replace it. What is worth keeping is the shape around it: binds
instead of concatenation, column names out of the mapping, and a controller that
talks to the BLL.

That last one is the reason this schematic exists at all. Every `@Crud` module
keeps the layering right without anyone thinking about it, because
`CrudController` takes an `ICrudBLL` and will not take anything else. A
query is the one place in a monolite project where all four files are written
from a blank page, so it is the only place the rule can be broken — see
[architecture](architecture.md).

### `generate repository`

You do not need one to do CRUD, and that is worth saying first: `defineEntity`
already produced a repository that selects, inserts, updates, pages, filters and
soft-deletes on every engine. A module that only does those should inject it
directly. A class that forwards seventeen methods and adds nothing is a layer
for the sake of having one, which is why this is not part of `generate module`.

Generate one the day the module needs a query the generic API deliberately does
not express — an aggregate, a `GROUP BY`, a view, a stored procedure:

```bash
monolite g repository invoice
```

```
src/infrastructure/persistence/invoice.repository.ts   the interface and the class
```

It extends `BaseModuleRepository`, which forwards the whole contract to the
store and wraps every call in a guard that logs the driver's error and re-throws
a neutral one — so an `ORA-00001` stays in the log and never reaches a client.
The example method shows the shape: `asRawQueryable` to ask whether this engine
has SQL to run, the aggregate when it does, and the in-process fallback when it
does not, because the in-memory driver is what your generated suite uses.

The store it injects already joins whatever transaction is open — that has been
true of every bound store since 0.6.0, so nothing here has to be told about one.

**`repository` or `query`?** A repository belongs to one entity and adds
methods to *its* store. A query owns no table and computes an answer across
several, so it comes with a BLL, a DTO and a controller of its own. If you find
yourself giving an entity's repository a method that reads two other tables, the
answer was a query.

#### The binding

```
i Registered in src/composition/modules/invoice.module.ts:
    import { InvoicesRepository } from "../../infrastructure/persistence/invoice.repository";
    container.register(INVOICE_TOKENS.repository, { useClass: InvoicesRepository });
```

Two lines rather than one, because the class has to be imported before it can be
bound. They go above a `// monolite:bindings` marker the module ships with —
and unlike `modules.ts`, this is a file you have almost certainly edited, which
is exactly the situation a generator has to be careful in. Move the marker,
rename it or delete it and nothing is touched: the command prints the two lines
instead.

The token was already declared. `<ENTITY>_TOKENS.repository` is written by
`generate module` and simply goes unbound until there is something to bind to
it, which saves the generator from having to reopen the token table.

What is left to you is one line in the BLL: inject
`<ENTITY>_TOKENS.repository` where it injects `<ENTITY>_TOKENS.store` today,
and widen its type to the new interface. That one is a decision — the BLL may
well want the plain store — so it is printed rather than made.

### Wiring

A generated module is added to one list, and the generator adds it:

```
i Wired into src/composition/modules.ts:
    import { INVOICE_MODULE } from "./modules/invoice.module";
    INVOICE_MODULE,
```

That list is `composition/modules.ts`, and it is the only one. A module used to
be added in three places — its registration to `entities.ts`, its bindings to
`container.ts`, an import to `routes.ts` — none of which was a decision, and
any of which could be forgotten into a module that compiles perfectly and is
never served.

What made the three-file version impossible to automate safely was not the
editing; it was that the edits were spread out. A `MonoliteModule` carries the
registration, the bindings and the controller together, so wiring is one line in
one file, and one line in one file is small enough for a generator to insert and
for a reviewer to check.

The registration is optional. A module that owns no table — a report reading
three entities that already exist, a search across several of them, a dashboard,
an import job, a webhook receiver — leaves it off and joins the same list, which
is the point: the alternative was a second place to register things, and a
second place is the problem this list solved.

The licence to write comes from a marker. `composition/modules.ts` ships with
`// monolite:modules` in it and the entry goes immediately above it. Move that
marker, rename it or delete it and nothing is touched — the command prints the
line for you instead, which is what it always used to do. `--no-wire` says the
same thing on purpose.

No AST is involved, and that is deliberate: the CLI has **no runtime
dependencies**, and pulling in the TypeScript compiler to add a line to an array
would spend that promise on the cheapest edit in the project.

The project is found by walking up from the working directory looking for a
`monolite` key in `package.json`, so the command works from any subdirectory — and
**refuses to run outside a project** rather than scattering files into whatever
happens to be the current folder.

`--force` overwrites files that already exist. Without it, an existing file is left
alone and reported.

---

## Global options

| Flag | Effect |
| --- | --- |
| `-v`, `--version` | Print the CLI version |
| `-h`, `--help` | Show help; `monolite help <command>` for a command |
| `--no-color` | Disable ANSI colour. `NO_COLOR` is honoured too |

---

## Templates

Templates live in `packages/cli/templates/` as real files, rendered by substituting
`__placeholder__` tokens in both the contents and the file names, and selected by
directory (`templates/base/`, `templates/db/<engine>/`, `templates/auth/`,
`templates/example/`). A tiny renderer beats a template engine here: the templates
stay readable as the files they will become.

Two conventions worth knowing if you edit them:

- **`gitignore`, not `.gitignore`.** npm renames a packaged `.gitignore` to
  `.npmignore`, so the template would never reach the tarball under its own name.
  The renderer restores the dot on write.
- **Templates are excluded from this repository's typecheck and lint.** They are
  TypeScript for the *generated* project — they import `monolite-*` packages that
  are not dependencies here, and they contain placeholders that are not valid
  syntax until rendered.
