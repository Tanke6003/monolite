# monolite-data

One repository contract over six engines: **in-memory, Oracle, SQL Server,
PostgreSQL, MySQL/MariaDB and MongoDB**.

A module describes its table once, with `EntityMetadata`, and gets the whole
CRUD for free — reads, writes, projections, pagination, soft delete, audit
columns and a change log — plus a chainable query API in the style of LINQ's
`IQueryable<T>`. Which engine is underneath is a wiring decision, not a code
decision: nothing above the repository changes when it changes.

Depends only on [`monolite-core`](../core). Every database driver is an
**optional** peer dependency, so a project on PostgreSQL never downloads Oracle.

Requires Node 20 or newer.

## The idea

Most "database-agnostic" layers agree on the easy half — `findAll`, `findById` —
and leak on the hard half. The interesting part of this package is the hard half,
and it is what the three query compilers exist for:

- **`SqlWhereCompiler`** turns a `WhereFilter<T>` into standard SQL with named
  binds.
- **`toMongoFilter`** turns the *same* filter into a MongoDB query document.
- **`matchesFilter`** evaluates the *same* filter in memory.

Keeping the three aligned is what lets a module be written against the in-memory
driver and behave identically once it is pointed at a real engine. It is not a
promise made in a README: `runGenericRepositoryContract` is the one suite every
driver has to pass, and it ships with the package so you can point it at a driver
of your own.

What genuinely differs between the four SQL engines is small and lives in one
place, `SqlDialect`: how a generated PK comes back (`RETURNING ... INTO`,
`OUTPUT INSERTED`, `RETURNING`, or the driver's `LAST_INSERT_ID()`), how the
server date is spelled, how pagination is written, and how a row is locked. The
rest of the SQL is generated exactly once, in `SqlGenericRepository`.

## What it exports

### Contracts

| Export | What it is |
| --- | --- |
| `IGenericRepository<T, TKey>` | The contract. CRUD, the declarative filter language, soft delete and `query()`. |
| `IQueryable<T>`, `QueryOptions<T>`, `WhereFilter<T>`, `FieldOperators<V>`, `OrderByClause<T>`, `PagedResult<T>`, `FieldFilter<V>`, `SortDirection` | The query vocabulary. |
| `IUnitOfWork`, `ITransactionScope` | Transactions with an explicit boundary: `execute(scope => ...)`, commit at the end, rollback on throw, `lockRow` when a decision depends on what was just read. |
| `ITransactionContext` | The ambient transaction, so a repository joins it without being handed it. |
| `IRawQueryable<T>`, `asRawQueryable` | The escape hatch as a contract: `executeRaw` and `schema`, on the stores that have SQL to run. `asRawQueryable` answers `null` on the in-memory and MongoDB drivers, which is what tells a module it needs a fallback. |
| `IAuditTrail`, `AuditEntry`, `AuditActor`, `AuditAction`, `AUDIT_ACTIONS`, `IAuditLog` | The change log written by the repository after every write. |
| `ISqlExecutor`, `SqlExecuteOptions`, `SqlExecuteResult` | The minimum needed to talk to a SQL engine, implemented by both a pool and a transaction. |
| `IDbPlugin`, `ISqlDbPlugin`, `DbEngine` | The connector lifecycle: open, check, close. |

### Metadata

| Export | What it is |
| --- | --- |
| `defineEntity` | Identity helper; it only exists so TypeScript infers `T` and checks that `columns` covers the model. |
| `EntityMetadata<T>`, `ColumnMetadata`, `ColumnDefinition`, `ColumnKind`, `SoftDeleteMetadata<T>`, `TimestampMetadata<T>`, `AuditMetadata<T>` | The mapping vocabulary: EF Core's `ModelBuilder` without decorators, so domain models stay pure interfaces. |
| `RelationMetadata<T>`, `IndexMetadata<T>` | What a foreign key points at, and the composite indexes. Declarative and inert — the repository reads neither; the include a BLL declares and the generated DDL do. |
| `EntitySchema<T>` | The normalized view every driver reads: resolves shorthands, indexes by column, converts values both ways. `columnOf` throws on an unmapped property, which is the barrier that keeps arbitrary names out of the generated query. |

### Query

| Export | What it is |
| --- | --- |
| `QueryBuilder` | The shared, immutable `IQueryable<T>`. Knows nothing about any engine: it accumulates options and delegates the terminal operators. |
| `SqlWhereCompiler`, `CompiledWhere` | Filter → SQL + named binds. |
| `toMongoFilter`, `MongoQuery` | Filter → MongoDB query document. |
| `matchesFilter`, `compareBy` | Filter → in-memory predicate and ordering. |
| `isOperatorObject`, `normalizeOrderBy`, `likeToRegExp`, `escapeRegExp`, `containsPattern`, `LIKE_ESCAPE`, `OPERATOR_KEYS` | Shared helpers, exported because a custom driver needs the same ones. |

### Drivers, dialects and connectors

| Export | What it is |
| --- | --- |
| `MemoryGenericRepository`, `MemorySnapshot` | The array-backed driver. A complete development mode without Docker. |
| `SqlGenericRepository` | The single implementation behind all four SQL engines. Also `lockById` and `executeRaw`, the escape hatch for what the generic API deliberately does not express. |
| `MongoGenericRepository`, `IMongoDataSource` | The document driver, same contract. |
| `oracleDialect`, `sqlServerDialect`, `postgresDialect`, `mysqlDialect`, `SqlDialect` | What differs between SQL engines, and nothing else. |
| `OracleConnector`, `SequelizeConnector`, `MongoConnector` | The connectors. Sequelize covers SQL Server, PostgreSQL and MySQL/MariaDB in one, because what differs lives in the dialect. |
| `MemoryUnitOfWork`, `SqlUnitOfWork`, `MongoUnitOfWork` | One unit of work per family, all behind `IUnitOfWork`. |
| `AsyncTransactionContext` | `ITransactionContext` on `AsyncLocalStorage`. |
| `MemoryAuditTrail`, `SqlAuditTrail`, `MongoAuditTrail` | The change log, written through the same scope as the audited operation, so it lands in the same commit. |
| `BaseModuleRepository` | Optional base class for a per-module repository: forwards the whole contract to the store and logs failures without a try/catch in every method. `monolite generate repository` writes one. |
| `transactionAware` | Wraps a store so it resolves through `ITransactionContext` on every call — the transaction's when one is open, the pool's otherwise. `registerPersistence` applies it to every store it binds, which is what makes `@Transactional()` true of the repositories a module actually injects. |

### Schema generation

| Export | What it is |
| --- | --- |
| `emitSchema`, `emitTable`, `TableDdl`, `EmitOptions` | `CREATE TABLE` from the same mapping the repository reads, so the schema and the code that queries it stop being two descriptions kept in agreement by hand. Tables first, then constraints: a foreign key can point at a table declared later. |
| `DdlDialect`, `ddlDialectFor`, `DDL_DIALECTS`, `oracleDdl`, `sqlServerDdl`, `postgresDdl`, `mysqlDdl` | What differs between engines when *creating* a schema, kept apart from `SqlDialect` because it is read once by a command rather than on every statement. `ddlDialectFor` answers `null` for the engines that have no schema. |
| `snapshotOf`, `diffSnapshots`, `emptySnapshot`, `SchemaSnapshot`, `TableSnapshot`, `ColumnSnapshot`, `ForeignKeySnapshot`, `IndexSnapshot`, `DiffOptions` | The migration half. Against a committed snapshot, never the live database; nothing at all when nothing changed; and anything that destroys data emitted commented out. |

A generated project drives both through `npm run db:sql` and
`npm run db:migration -- <name>`. See
[data access](../../docs/en/data-access.md#generating-the-schema).

### Testing

| Export | What it is |
| --- | --- |
| `runGenericRepositoryContract` | The full contract suite. Give it a factory and it verifies the promise. |
| `CONTRACT_ENTITY`, `ContractItem`, `ContractSetup` | The minimal entity and setup shape the suite operates on. |

## Example

Describe the table once:

```ts
import { defineEntity } from "monolite-data";

interface Branch {
  pkBranch: number;
  name: string;
  city: string;
  active: boolean;
  createdAt: Date;
  createdBy: string;
}

export const BRANCH_ENTITY = defineEntity<Branch>({
  table: "BRANCHES",
  primaryKey: "pkBranch",
  identity: true,
  columns: {
    pkBranch: { name: "PK_BRANCH", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string" },
    city: { name: "CITY", kind: "string" },
    active: { name: "ACTIVE", kind: "boolean" },
    createdAt: { name: "CREATED_AT", kind: "date", updatable: false },
    createdBy: { name: "CREATED_BY", kind: "string", updatable: false },
  },
  softDelete: { property: "active", activeValue: 1, deletedValue: 0 },
  timestamps: { createdAt: "createdAt" },
  audit: { createdBy: "createdBy" },
});
```

Pick an engine — this is the only line that knows which one it is:

```ts
import {
  MemoryGenericRepository,
  SequelizeConnector,
  SqlGenericRepository,
  postgresDialect,
  type IGenericRepository,
} from "monolite-data";

declare const useDatabase: boolean;

const repository: IGenericRepository<Branch> = useDatabase
  ? // In production, on PostgreSQL:
    new SqlGenericRepository<Branch>(
      new SequelizeConnector({ engine: "postgres", host, port, username, password, database }, logger),
      BRANCH_ENTITY,
      logger,
      postgresDialect,
      context
    )
  : // In development, with no database at all:
    new MemoryGenericRepository<Branch>(BRANCH_ENTITY, [], context);
```

Swapping `postgresDialect` for `oracleDialect`, `sqlServerDialect` or
`mysqlDialect` — or the whole branch for a `MongoGenericRepository` — is the
entire change.

Everything above the repository is the same code either way:

```ts
const page = await repository.getPaged(1, 20, {
  where: { city: { contains: "sevill" }, active: true },
  orderBy: { field: "name" },
});

const created = await repository.insert({ name: "Nervión", city: "Sevilla" });
await repository.softDelete(created.pkBranch);

// Or with the chainable API, which is lazy and immutable:
const recent = await repository
  .query()
  .where({ createdAt: { gte: lastMonday } })
  .orderByDescending("createdAt")
  .take(10)
  .toList();
```

`contains` is worth pointing at: `like` and `ilike` take a pattern, so a `%` typed
into a search box would return the whole table. `contains` takes literal text and
each driver neutralises it its own way — `LIKE ... ESCAPE` in SQL, an escaped
`$regex` in MongoDB, `includes` in memory — so the caller cannot get it wrong.

### Transactions

A transaction is not opened per operation: a single statement is already atomic
and travels with auto-commit. It is opened when more than one place is written
to, or when a decision depends on what was just read — and then it comes with
`lockRow`, which must be the first statement of the block.

```ts
await unitOfWork.execute(async (scope) => {
  await scope.lockRow("branch", branchId);

  const branches = scope.repository<Branch>("branch");
  const appointments = scope.repository<Appointment>("appointment");

  await branches.softDelete(branchId);
  await appointments.updateWhere({ fkBranch: branchId }, { status: "CANCELLED" });
});
```

### Verifying your own driver

```ts
import { runGenericRepositoryContract, CONTRACT_ENTITY, MemoryGenericRepository } from "monolite-data";

runGenericRepositoryContract("memory", {
  create: () => new MemoryGenericRepository(CONTRACT_ENTITY),
});
```

The suite expects the Jest globals to be in scope, so import it from a test file.

## Optional peer dependencies

`oracledb`, `sequelize`, `tedious`, `pg`, `mysql2` and `mongodb` are declared as
optional peer dependencies: install only the one your project actually uses.

One caveat while this is still `0.1.0`: the connectors and `sql-dialect.ts`
currently import their driver **statically** at the top of the file, so requiring
them pulls the driver in whether or not you use that engine. Each of those files
carries a comment saying exactly which import has to become a lazy
`await import(...)` and where. Until that change lands, importing the package
entry point needs the drivers present; importing a single engine's module keeps
the blast radius to that engine.

## License

MIT
