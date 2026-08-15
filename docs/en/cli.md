# CLI reference

> 🇪🇸 [Leer en español](../es/cli.md) · package: `@monolite/cli`

```bash
npm install -g @monolite/cli
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
| `--auth` / `--no-auth` | on | Adds `@monolite/auth`, a login module and a guard |
| `--example` / `--no-example` | on | A sample CRUD module, end to end |

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
│   └── presentation/routes.ts           the imports that run the decorators
└── tests/smoke.test.ts       passes on the first run
```

The project builds and its test suite passes before you write a line. That is the
contract the CLI holds itself to, and CI checks it on every push by generating two
projects and running them.

---

## `monolite generate <schematic> <name>`

Alias: `monolite g`.

```bash
monolite generate module invoice
monolite g entity payment-method
```

| Schematic | What it writes |
| --- | --- |
| `module` | Entity + store registration + service + controller, wired with `@Crud` |
| `entity` | The domain interface and its table mapping |
| `service` | A `CrudService` subclass for an existing entity |
| `controller` | A `CrudController` subclass for an existing service |

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
  TypeScript for the *generated* project — they import `@monolite/*` packages that
  are not dependencies here, and they contain placeholders that are not valid
  syntax until rendered.
