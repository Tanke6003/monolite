# @monolite/di

The toolkit's dependency-injection wiring, on [tsyringe](https://github.com/microsoft/tsyringe).

Requires Node 20 or newer.

## Why the container is a package of its own

A container is a preference, not a requirement. Every other package of the
toolkit takes its dependencies as constructor arguments and never mentions a
container: the kernel, the data layer, the HTTP layer and the feature packages
can all be assembled with plain `new` calls, or with Awilix, or with
InversifyJS. Nothing in them knows this package exists.

Keeping the wiring here is what makes that true and keeps it true. `tsyringe`
and `reflect-metadata` appear in exactly one `package.json` in the whole
monorepo — this one — so a consumer who prefers a different container simply
never installs it, and a consumer who is happy with tsyringe gets the tokens,
the factories and the composition-root helpers already written.

The split also draws the line the framework cares about most: **the framework
scaffolding is registered here; your features are registered by you.** The two
modules this package ships (`registerPlugins` and `registerPersistence`) cover
the cross-cutting services and the persistence layer, which every application
needs and no application wants to write again. Your repositories, services and
controllers stay in your own modules, in your own repository, and go on the same
container right after.

## What it exports

### Tokens

| Export | What it is |
| --- | --- |
| `TOKENS` | The framework-level identifiers: `IEnvs`, `ILogger`, `IRequestContext`, `ITransactionContext`, `IHealthProbe`, `ITokenService`, `IFileStorage`, `IDbPlugin`, `IUnitOfWork`, `IAuditTrail`, `IAuditLogStore`. |
| `Token`, `TokenName` | The value and the key types of the table. |
| `storeToken` | The token an entity's generic repository is registered under (`USERS` → `USERSStore`). |

tsyringe resolves by string, so a typo in an `@inject("ILoger")` compiles and
blows up at run time, with the process already up. Going through `TOKENS` means
the compiler sees the typo. Feature tokens are *not* here on purpose: your
service, your repository and your controller belong to your application, and
hosting them here would make every consumer inherit a vocabulary of entities it
does not have. Declare your own table and use both side by side.

### Container helpers

| Export | What it does |
| --- | --- |
| `container` | tsyringe's root container, re-exported. |
| `createContainer` | A child container, isolated from the global one — what a test wants. |
| `registerInstance` | Binds an already-built object (the logger, a store). |
| `registerSingleton` | Binds a class that must exist exactly once in the process. |
| `registerClass` | Binds a class rebuilt on every resolution — the right default for a feature's three layers. |
| `registerFactory` | Binds a token to whatever a factory returns. |
| `registerBinding` | Binds an instance or a class, whichever was passed. |
| `Binding`, `Constructor` | The types those helpers speak. |
| `CompositionRoot`, `createCompositionRoot` | The entry-point shape: the container plus the resources the process owns. |
| `IManagedConnection` | Something with `authenticate()` and `close()` — a connection pool. |

Importing anything from this package loads `reflect-metadata` once, so no
consumer has to remember the import and no other package has to carry the
dependency.

### Factories

| Export | What it does |
| --- | --- |
| `createPersistenceLayer` | Builds the generic repository of every entity, the unit of work, the change log and the connection, on the engine the configuration names. |
| `resolveDriver`, `isOracleDriver` | Resolve `DATA_SOURCE` (and its aliases) into a driver, failing loudly on an unknown value. |
| `buildOracleConfig`, `buildSequelizeConfig`, `buildMongoConfig` | Read each engine's own variable prefix, with defaults aligned with the reference compose file. |
| `createLogger` | Picks the logging backend named by `LOG_DRIVER` out of the ones the application registered. |

### Modules

| Export | What it registers |
| --- | --- |
| `registerPlugins` | `IEnvs`, `ILogger`, `IRequestContext`, `ITransactionContext` and, if given, `ITokenService` and `IFileStorage`. |
| `registerPersistence` | One store per entity, `IUnitOfWork`, `IAuditTrail`, `IAuditLogStore` and `IHealthProbe`. Returns the whole layer, because the connection is not a dependency: it is a resource of the process. |

## Building a composition root

The composition root is the one place that knows which implementation covers
each interface, and the only place allowed to know it. It fixes the order —the
environment before the logger, because the log driver is read from it; the
request context before persistence, because the user of the audit columns comes
from it— and then hands over.

```ts
import type { IHealthProbe } from "@monolite/core";
import {
  createCompositionRoot,
  createLogger,
  registerPersistence,
  registerPlugins,
  TOKENS,
} from "@monolite/di";
import { USERS_ENTITY, USERS_SEED, AUDIT_LOG_ENTITY } from "./infrastructure/entities.js";
import { DotenvEnvs } from "./infrastructure/dotenv.js";
import { PinoLogger } from "./infrastructure/pino.js";
import { validateCriticalEnvs } from "./config/env.validation.js";
import { registerUsers } from "./modules/users.module.js";

const envs = new DotenvEnvs();

export const root = createCompositionRoot((root) => {
  const plugins = registerPlugins({
    container: root.container,
    envs,
    // The logger arrives built: choosing a backend is a configuration read, not
    // a dependency the container can resolve.
    logger: createLogger({ envs, drivers: { pino: (s) => new PinoLogger(s) } }),
    // Fails loudly when a critical secret is missing, rather than starting with
    // an insecure default nobody notices.
    validate: validateCriticalEnvs,
  });

  const persistence = registerPersistence({
    container: root.container,
    ...plugins,
    entities: [
      { name: "USERS", metadata: USERS_ENTITY, seed: USERS_SEED, token: "UsersStore" },
    ],
    auditLog: AUDIT_LOG_ENTITY,
  });

  // The connection is not registered in the container — nobody injects it — but
  // the process owns it, so the root opens and closes it.
  root.manage(persistence.connection);

  // From here on order stops mattering: a module declares its classes and
  // tsyringe resolves the dependencies when somebody asks for them.
  registerUsers(root.container);
});

// In `main.ts`
await root.warmUp(); // a bad password shows up in the boot log, not in request #1

process.on("SIGTERM", async () => {
  // Readiness turns to false before the process stops accepting traffic, so the
  // load balancer takes it out of rotation first.
  root.container.resolve<IHealthProbe>(TOKENS.IHealthProbe).beginShutdown();
  await root.shutdown();
});
```

A feature module of your own is three lines, and it never mentions an engine:

```ts
import { registerClass } from "@monolite/di";
import type { DependencyContainer } from "@monolite/di";
import { APP_TOKENS } from "./tokens.js"; // your own table, next to TOKENS

export function registerUsers(container: DependencyContainer): void {
  // `UsersRepository` injects "UsersStore" and never learns which engine is
  // underneath. Transient on purpose: these three keep no state between
  // requests, so a singleton would save nothing and would hide an accidental
  // shared state the day somebody adds a field to the class.
  registerClass(container, APP_TOKENS.IUsersRepository, UsersRepository);
  registerClass(container, APP_TOKENS.IUsersService, UsersService);
  registerClass(container, APP_TOKENS.IUsersController, UsersController);
}
```

## Swapping the engine

`createPersistenceLayer` is the piece that makes changing database a change of
configuration. It accepts `memory`, `oracle`, `mssql` (`sqlserver`), `postgres`
(`postgresql`), `mysql` (`mariadb`) and `mongodb` (`mongo`), reading
`DATA_SOURCE` unless the caller names one, and it validates the value against
that table instead of falling back to memory: a misspelled
`DATA_SOURCE=postgress` would otherwise start in memory and the failure would
surface much later, as data that does not persist.

Whichever engine comes out, the services receive exactly the same
`IGenericRepository<T>`. The in-memory driver is the one that makes the test
suite run without bringing a container up, and it is the reason `connection` is
optional: there is nothing to open and nothing to close.

Connection settings can also be passed explicitly (`oracle`, `sequelize`,
`mongo`), which is what an application configured from something other than
environment variables does.

## Logging backends

`createLogger` keeps the selection logic —`LOG_DRIVER` with pino as the default,
and a loud failure on an unknown value— but the backends are handed to it rather
than imported:

```ts
createLogger({
  envs,
  drivers: {
    pino: (settings) => new PinoLogger(settings),
    winston: (settings) => new WinstonLogger(settings),
  },
});
```

Importing both here would put both in the dependency tree of everyone who
installs this package, to run one of them at most. The part worth sharing is the
selection; the implementations stay where they are already paid for.

## The rest of the framework works without this

Nothing outside this package imports `tsyringe` or `reflect-metadata`. If you
would rather not use a container at all, build the same objects by hand — the
factories here are plain functions and are perfectly usable on their own:

```ts
import { createPersistenceLayer } from "@monolite/di";

const persistence = createPersistenceLayer({ envs, logger, entities, auditLog });
const users = new UsersService(persistence.store("USERS"), persistence.unitOfWork);
```

And if you would rather not install this package either, `@monolite/core` and
`@monolite/data` know nothing about it: the wiring is yours to write.

## License

MIT
