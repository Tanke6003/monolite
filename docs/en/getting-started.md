# Getting started

> 🇪🇸 [Leer en español](../es/getting-started.md)

Two ways in: let the CLI scaffold a project, or add one package to something you
already have. Both are supported; neither is a lesser path.

---

## Requirements

- **Node.js 20 or newer.** The packages use `AsyncLocalStorage`, `node:util`
  `parseArgs` and `structuredClone` without polyfills.
- **npm 10+**, pnpm or yarn. The monorepo itself uses npm workspaces.
- A database, if you want one. Every engine is optional; the in-memory driver
  needs nothing installed.

---

## Path A — scaffold a new project

```bash
npm install -g monolite-cli
monolite new my-api
```

The CLI asks, in order:

| Question | Default | What it changes |
| --- | --- | --- |
| Project name | the directory argument | `package.json` name, the README title |
| Version | `0.1.0` | `package.json` |
| Description / author / license | — / — / MIT | `package.json`, `LICENSE` |
| Database family | SQL | which of the next questions you see |
| Engine | PostgreSQL | the driver dependency, the docker service, the SQL dialect, the seed schema |
| Connection details | per-engine defaults | `.env.example` (never a real password) |
| Authentication | yes | adds `monolite-auth`, a login module and a guard on the example routes |
| Example CRUD module | yes | one entity end to end, so the pattern is visible |
| API prefix | `/api/v1` | `API_PREFIX` in the environment |
| Package manager | npm | lockfile and the install command it runs |
| Git init / install now | yes / yes | whether it leaves you ready to run |

Then:

```bash
cd my-api
cp .env.example .env      # fill in the password
npm run dev
```

`GET /health/ready` answers once the database is reachable — `/health` and
`/health/live` answer too. The OpenAPI document is at `/openapi.json`, generated
from the route decorators, and the reader chosen at the prompt is mounted over it
at `/docs`.

### Without prompts

Every answer has a flag, and `--yes` accepts the defaults for anything you leave
out:

```bash
monolite new my-api --database=postgres --auth --example --yes
monolite new tiny-api --database=none --no-auth --yes --skip-install --skip-git
```

Full flag list in the [CLI reference](cli.md).

---

## Path B — add a package to an existing app

The packages do not require each other's presence beyond their declared
dependencies, and none of them require the CLI.

### Just the data layer

```bash
npm install monolite-core monolite-data pg
```

```ts
import { EntitySchema, SqlGenericRepository, postgresDialect } from "monolite-data";

const USERS = {
  table: "USERS",
  key: { property: "pkUser", column: "PK_USER" },
  columns: { name: "NAME", email: "EMAIL", isActive: "IS_ACTIVE" },
  softDelete: { column: "IS_DELETED" },
  audit: { createdBy: "CREATED_BY", updatedBy: "UPDATED_BY" },
} as const;

const users = new SqlGenericRepository<User>(executor, USERS, logger, postgresDialect);

await users.getAll({
  where: { isActive: true, name: { contains: search } },
  orderBy: { field: "name" },
  page: { number: 1, size: 20 },
});
```

Swapping to MySQL later is `postgresDialect` → `mysqlDialect` plus the connection
string. Swapping to MongoDB is `SqlGenericRepository` → `MongoGenericRepository`;
the filter above is unchanged, because it compiles to a query document instead of
to SQL.

### Just the routing and OpenAPI

```bash
npm install monolite-core monolite-http express zod
```

```ts
import { ApiController, Get, buildOpenApiDocument, registerController } from "monolite-http";

@ApiController("/reports", { tag: "Reports" })
export class ReportsController {
  @Get("/:id", { params: idParamSchema })
  getOne = async (req, res) => res.json(await load(req.params.id));
}
```

`registerController` mounts it on an Express router; `buildOpenApiDocument` turns
the same metadata into the spec. You keep your own `app`, your own bootstrap and
your own everything else.

### Just the errors and request identity

`monolite-core` has no dependencies at all, so it is safe to adopt in isolation
for `AppError` + `normalizeError` + the `AsyncLocalStorage` request context, even
in a project that will never use the rest.

---

## Configuration

Generated projects read configuration from the environment. The names that matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` hides stack traces and disables SQL logging |
| `PORT` | `3000` | |
| `API_PREFIX` | `/api/v1` | Where controllers mount |
| `API_LEGACY_PREFIX` | — | A second mount point during a version migration; `off` disables |
| `DATA_SOURCE` | `memory` | `memory` \| `oracle` \| `mssql` \| `postgres` \| `mysql` \| `mongo` |
| `LOG_DRIVER` | `pino` | `pino` \| `winston` |
| `LOG_LEVEL` | `debug` in dev | |
| `CORS_ORIGINS` | — | Comma-separated allowlist. `*` allows everything — do not use it in production with credentials |
| `CSP_ENABLED` | `false` | Off by default because a Content-Security-Policy tuned for an HTML app breaks an API's doc UIs |
| `RATE_LIMIT_MAX` | engine default | `0` disables the limiter entirely |
| `TRUST_PROXY` | `0` | A **number** of hops. `true` makes every client able to spoof its own IP |
| `BODY_LIMIT` | `1mb` | |
| `DOCS_ENABLED` | on outside production | |
| `SHUTDOWN_DELAY_MS` | `5000` | How long readiness stays false before the server stops accepting |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Watchdog; the process exits even if a connection will not drain |

`TRUST_PROXY` deserves the emphasis. Setting it to `true` tells Express to believe
the left-most `X-Forwarded-For` entry, which any client can write — that makes the
rate limiter trivially bypassable and every logged IP a fiction. Set it to the
number of proxies actually in front of you.

---

## Graceful shutdown

`SIGTERM` runs four steps, in this order, and the order is the point:

1. `healthProbe.beginShutdown()` — readiness flips to false immediately, so the
   load balancer stops sending new work.
2. Wait `SHUTDOWN_DELAY_MS`. The balancer needs time to notice; closing the
   listener now would reject requests that were already routed here.
3. `server.close()` plus `closeIdleConnections()` — stop accepting, let in-flight
   requests finish, and drop keep-alive sockets that are idle rather than waiting
   out their timeout.
4. Close database connections, then exit.

A `SHUTDOWN_TIMEOUT_MS` watchdog forces the exit if step 3 or 4 hangs, because a
pod that will not terminate is worse than one that terminates rudely.

---

## Next

- [Architecture](architecture.md) — how the packages fit and what the design costs
- [Data access](data-access.md) — the repository contract in depth
- [Decorated routes and OpenAPI](routing.md)
- [Generic CRUD](crud.md)
- [Testing](testing.md)
