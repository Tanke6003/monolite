# monolite-core

The kernel of the monolite toolkit. Every other package depends on it, which is
exactly why it depends on nothing: no Express, no database driver, no DI
container, no runtime dependencies at all. Anything added here becomes
mandatory for every package downstream, so only the shared vocabulary lives in
it — the error type BLLs throw, the mapper that turns anything thrown into
an HTTP-shaped answer, the contracts other packages implement, and the two
implementations that need nothing beyond Node's standard library.

Requires Node 20 or newer.

## What it exports

### Errors

| Export | Kind | What it is |
| --- | --- | --- |
| `AppError` | class | The error BLLs throw on purpose. Carries an HTTP status, a stable `code` for the client to branch on, optional field-level `errors`, and an ES2022 `cause` so the original failure is never lost. |
| `AppErrorOptions` | type | `code`, `errors` and `cause` for the `AppError` constructor. |
| `ErrorDetail` | type | A single `{ field, message }` validation detail. |
| `normalizeError` | function | Turns anything thrown — `AppError`, a Zod failure, a JWT error, a body-parser error, a raw driver error — into a `NormalizedError`. |
| `NormalizedError` | type | `{ statusCode, code, message, errors?, isOperational }`. |
| `causeChain` | function | Walks the `cause` chain of an error, depth-bounded. |

`normalizeError` is where the toolkit's promise that a module behaves the same
on any engine is actually kept. Oracle, PostgreSQL, MySQL/MariaDB, SQL Server
and MongoDB failures are all folded into the same six outcomes (unique
violation, missing required field, check violation, dangling reference,
reference still in use, value too large) plus "database unavailable", so a
duplicate key answers `409 DB_UNIQUE_VIOLATION` whichever engine raised it. It
identifies drivers by the fingerprint they leave on the error object, and it
follows `cause`, `parent` and `original` to find it, because repositories — and
Sequelize — wrap the real error several layers deep.

Zod failures are recognised structurally rather than with `instanceof`, so the
kernel maps them without depending on Zod.

### Contracts

| Export | What implements it |
| --- | --- |
| `ILogger` | The logging backend. Levels only — request-logging middleware belongs to the HTTP package. |
| `CurrentUser`, `RequestContextData`, `IRequestContext` | The ambient request context. `CurrentUser` carries `id`, `name`, `email` and `roles`; the auth package fills `roles` in while decoding the token. |
| `HealthReport`, `IHealthProbe` | Liveness and readiness, kept apart on purpose: a process whose database is down is alive but not ready. |
| `IConnectionCheck` | The one method the health probe needs from a connection: `authenticate()`. |
| `HealthProbeOptions` | Configuration for `HealthProbe`. |

### Implementations

| Export | What it does |
| --- | --- |
| `AsyncRequestContext` | `IRequestContext` on top of `AsyncLocalStorage`. Node's equivalent of `IHttpContextAccessor`: the store survives every `await`, so a repository three layers down still sees the user of the request without being handed it. |
| `SYSTEM_USER` | The audit name (`"System"`) used when there is no request in flight — startup, scheduled jobs, seeds. |
| `HealthProbe` | `IHealthProbe` with a short result cache and a bounded wait, so probing from several replicas does not become real load and a hung database does not hang the check. It never throws: a failed check *is* the answer. |

## Usage

```ts
import {
  AppError,
  AsyncRequestContext,
  HealthProbe,
  normalizeError,
  SYSTEM_USER,
} from "monolite-core";

const context = new AsyncRequestContext();

// Anything run inside `run` — however deep, however async — sees this user.
await context.run(
  {
    requestId: "3f9c1a7e",
    user: { id: "42", name: "ada", email: "ada@example.com", roles: ["admin"] },
  },
  async () => {
    context.getCurrentUserName(); // "ada", or SYSTEM_USER outside a request

    try {
      throw new AppError("Appointment overlaps another one", 409, true, {
        code: "APPOINTMENT_OVERLAP",
      });
    } catch (error) {
      const normalized = normalizeError(error);
      // { statusCode: 409, code: "APPOINTMENT_OVERLAP", isOperational: true, ... }
      console.log(normalized.statusCode, normalized.code);
    }
  }
);

// Readiness for a load balancer. `connection` is anything with `authenticate()`;
// leave it out for an in-memory data source and `database` reports
// "not_applicable".
const probe = new HealthProbe({ dataSource: "postgres", connection: sequelize });

await probe.report();
// { ready: true, dataSource: "postgres", database: "up", shuttingDown: false }

process.on("SIGTERM", () => {
  // From here on the probe reports `ready: false` immediately, so traffic is
  // taken away before the process actually stops accepting it.
  probe.beginShutdown();
});
```

## License

MIT
