# monolite-cli

Scaffolds and extends backend projects built on the [monolite](../../README.md) toolkit —
Express 5 and TypeScript, laid out as Clean Architecture, with one generic repository over
Oracle, SQL Server, PostgreSQL, MySQL, MongoDB or memory.

It has no runtime dependencies. Argument parsing is `node:util`'s `parseArgs`, the prompts
are `node:readline/promises`, and the colour is four escape codes; a tool whose whole
promise is that one global install gets you started should not drag a dependency tree in
behind it.

## Install

```bash
npm install -g monolite-cli
monolite --version
```

Or without installing:

```bash
npx monolite-cli new my-api
```

Requires Node 20 or newer.

## Commands

| Command | Alias | What it does |
| --- | --- | --- |
| `monolite new [name]` | `init` | Scaffolds a new project |
| `monolite generate <schematic> <name>` | `g` | Adds code to an existing project |
| `monolite help [command]` | | Same as `--help` |

Global flags: `-v` / `--version`, `-h` / `--help`, `--no-color`.

Colour is off automatically when `NO_COLOR` is set (any value), when `TERM=dumb`, or when
stdout is not a terminal. `FORCE_COLOR` turns it back on for a CI runner that does render
escapes.

---

## `monolite new [name]`

Interactive by default. Every question also has a flag, and **a question whose flag was
given is not asked** — mixing `--database=postgres` with the wizard is the normal way to
use it. `--yes` answers all of them with their defaults and prompts for nothing, which is
what makes the command usable from CI.

```bash
monolite new billing-api
monolite new billing-api --database=postgres --auth --example --yes
monolite new . --directory=./services/billing --database=mongodb --pm=pnpm --yes
```

If stdin is not a terminal and `--yes` was not passed, the command fails immediately
rather than hanging on a question nobody is there to answer.

### The questions, and what each answer changes

| # | Question | Flag | Effect on the output |
| --- | --- | --- | --- |
| 1 | Project name | positional, or the directory name | `name` in `package.json`, the README title, `SERVICE_NAME` in `.env.example`, the container names in `docker-compose.yml`. Validated as an npm package name; something like `My App` is normalised to `my-app` and the CLI says so |
| 2 | Version | `--project-version` (also `--version` after `new`) | `version` in `package.json`. Default `0.1.0` |
| 3 | Description | `--description` | `description` in `package.json` and the README subtitle |
| 3 | Author | `--author` | `author` in `package.json` |
| 3 | License | `--license` | `license` in `package.json` and the README footer. Default `MIT` |
| 4 | Database family → engine | `--database` | See the table below. This is the single biggest branch in the output |
| 5 | Host, port, database, user | `--db-host`, `--db-port`, `--db-name`, `--db-user` | Defaults in `.env.example`, defaults in `data-source.ts`, and the published port in `docker-compose.yml`. Only asked for a real engine |
| 6 | Authentication | `--auth` / `--no-auth` | Adds `monolite-auth` to the dependencies, `src/auth/seed-user.provider.ts`, the `registerAuth` call in the composition root, the guard in `routes.ts`, and `JWT_SECRET` / `JWT_EXPIRES_IN` in `.env.example`. Default: no |
| 7 | Example CRUD module | `--example` / `--no-example` | Adds a `product` module — entity, table mapping, DTO with validation, service, controller, tokens and registration — plus its import in `routes.ts` and its `registerProducts()` in the container. Default: yes |
| 8 | API prefix | `--api-prefix` | `API_PREFIX` in `.env.example`, the fallback baked into `resolveApiPrefix`, and the URLs in the README. Normalised, so `api/v1` and `/api/v1/` both become `/api/v1`. Default `/api/v1` |
| 9 | Package manager | `--pm` | Every command printed in the README and in the `check` script, and which binary the install step runs. `npm`, `pnpm` or `yarn`. Default `npm` |
| 10 | Initialise git | `--git` / `--skip-git` | Runs `git init` in the new directory. Default: yes |
| 10 | Install dependencies | `--install` / `--skip-install` | Runs the package manager's install. Default: yes |

Other flags:

| Flag | Effect |
| --- | --- |
| `--directory=<path>` | Where to write. Defaults to `./<name>` |
| `--force` | Write into a directory that is not empty, overwriting collisions |
| `-y`, `--yes` | Take every default, ask nothing |
| `-h`, `--help` | Per-command help |

There is deliberately **no `--db-password`**. Anything the CLI accepted there would end up
in `.env.example`, which is a committed file. The template ships `change_me` and the
summary tells you to put the real value in `.env`, which the generated `.gitignore`
excludes.

### Engines

`--database` accepts any of the spellings in the last column.

| Engine | Driver added | Default port | Env prefix | Compose service | Aliases |
| --- | --- | --- | --- | --- | --- |
| Oracle | `oracledb` | 1521 | `ORACLE_` | `oracle` | `oracle`, `oracledb` |
| SQL Server | `sequelize`, `tedious` | 1434 | `DB_` | `mssql` | `sqlserver`, `sql-server`, `mssql` |
| PostgreSQL | `sequelize`, `pg` | 5433 | `POSTGRES_` | `postgres` | `postgres`, `postgresql`, `pg` |
| MySQL / MariaDB | `sequelize`, `mysql2` | 3307 | `MYSQL_` | `mysql` | `mysql`, `mariadb` |
| MongoDB | `mongodb` | 27017 | `MONGO_` | `mongo` | `mongo`, `mongodb` |
| In-memory | none | — | — | none | `none`, `memory`, `in-memory`, `dummy` |

Choosing an engine changes exactly four things: the driver in `dependencies`, the body of
`src/infrastructure/persistence/data-source.ts`, the connection block in `.env.example`,
and whether there is a `docker-compose.yml` at all. In-memory gets no compose file and no
driver — that is the point of it.

The ports are the host-side ones the generated compose file publishes, deliberately offset
from the defaults (5433, not 5432) so a new project does not collide with a database
already running locally.

### Safety

The command refuses to write into a directory that is not empty unless `--force` is given,
and it prints every file it created, followed by the next steps for the choices that were
actually made — the compose service only if there is one, the `JWT_SECRET` reminder only
if auth was included.

---

## `monolite generate <schematic> <name>`

Adds code to an existing project. The project is located by walking up from the working
directory looking for a `monolite` key in `package.json`, so the command works from any
subdirectory — and **refuses to run outside a monolite project**, with a message that says
what it looked for. Without that check, a mistyped `cd` scatters files across an unrelated
repository.

```bash
monolite generate module invoice
monolite g entity payment-method
monolite g service invoice --force
```

| Schematic | Files written (under the project's `sourceRoot`) |
| --- | --- |
| `entity` | `domain/models/<name>.model.ts`, `infrastructure/persistence/entities/<name>.entity.ts`, `composition/modules/<name>.tokens.ts` |
| `service` | `application/dtos/<name>.dto.ts`, `application/services/<name>.service.ts` |
| `controller` | `presentation/controllers/<name>.controller.ts` |
| `module` | all of the above, plus `composition/modules/<name>.module.ts` |

`module` is a composition of the other three rather than a fourth copy of them, which is
what guarantees that `generate module invoice` and `generate entity invoice` produce the
same entity file. The `--example` module of `monolite new` goes through the very same
path, so the sample code you read on day one is what the generator hands you on day two.

Names are derived, not asked: `payment-method` becomes the class `PaymentMethod`, the file
`payment-method.model.ts`, the table `PAYMENT_METHODS`, the key `pkPaymentMethod` /
`PK_PAYMENT_METHOD` and the route `/payment-methods`. They are not independent choices —
a project whose route, table and class disagree is a project nobody can navigate.

Existing files are never overwritten without `--force`. After a `module`, the CLI prints
the two lines you add yourself, in `composition/container.ts` and `presentation/routes.ts`;
a generator that edits your own files is a generator that eventually mangles them.

---

## Templates

Templates live in `templates/` as real files, outside `src/` so this package's `tsconfig`
never tries to compile them — they import `monolite-*` packages the CLI does not depend
on, and they contain placeholders that are not valid syntax. Both `dist` and `templates`
are listed in `files`.

```
templates/
  base/              always written
  db/<engine>/       memory | oracle | mssql | postgres | mysql | mongo
  auth/              only with --auth
  generate/
    entity/  service/  controller/  module/
```

### Placeholders

`__token__` is replaced by the value of `token`, in file contents **and in path segments**
— `__entityKebab__.model.ts` becomes `invoice.model.ts`. An unknown token is a hard error,
not a silent pass-through: the failure mode of letting one through is a generated project
whose README says `__apiPrefix__`.

### Conditionals

A line that reads `#if <flag>`, `#elif <flag>`, `#else` or `#endif` — optionally behind a
`//` or an HTML comment, so the template stays readable in its own language — includes or
drops everything up to the matching directive. `#` is already a comment in YAML, `.env`
and `.gitignore`, so those carry the directive bare. Blocks nest, and a condition can be
negated (`#if !example`) or OR-ed (`#if postgres || mysql`).

Flags: `auth`, `example`, `memory`, `db`, `docker`, `sql`, `nosql`, and the engine id
(`oracle`, `mssql`, `postgres`, `mysql`, `mongodb`).

Anything coarser than a line is expressed by *where the file lives* instead. That rule is
what keeps the renderer thirty lines of logic rather than a template engine: the moment a
whole file wants wrapping in a conditional, it belongs in a conditional directory.

### Dotfiles

npm rewrites a published `.gitignore` to `.npmignore`, so a template shipping one under
its real name arrives renamed and the generated project ends up with no ignore file. It is
stored as `gitignore` and renamed on write; `env.example`, `editorconfig`, `npmrc` and
`dockerignore` get the same treatment so nobody has to remember which names npm is
opinionated about.

### `package.json`

The one generated file whose commas depend on which branches survived. Rather than
contorting the template so every branch ends without one, the rendered output has its
dangling commas stripped and is then re-parsed and re-printed. That is also why the
dependency lists are injected as `__dependencies__` / `__devDependencies__` instead of
being assembled with `#if` blocks.

## Programmatic use

```ts
import { run } from "monolite-cli";

await run(["new", "demo", "--database=postgres", "--yes", "--skip-install"]);
```

`run` returns the exit code instead of calling `process.exit`, so it can be driven from a
test.

## License

MIT
