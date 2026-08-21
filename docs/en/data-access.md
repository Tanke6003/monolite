# Data access

> 🇪🇸 [Leer en español](../es/data-access.md) · package: `monolite-data`

Describe a table once and you get classic CRUD, a declarative filter language,
chainable LINQ-style queries, paging, logical delete and transactions — without
writing SQL. Six engines implement that one contract, and choosing between them is
configuration, not code.

---

## The shape of it

```
IGenericRepository<T>              ← what services see. Identical on every engine.
        │
        ├── SqlGenericRepository     ── SqlDialect ── oracle · mssql · postgres · mysql
        ├── MongoGenericRepository
        └── MemoryGenericRepository
                    │
            IDbPlugin                ← connection lifecycle
            └── ISqlDbPlugin         ← + execute statements and open transactions
```

**The uniformity lives at the top.** Services see `IGenericRepository<T>`, and there
every engine behaves the same. The connector contract underneath is deliberately
thinner: `IDbPlugin` covers only `engine`, `authenticate` and `close`, because that
is all a relational store and a document store genuinely share. Pretending to unify
further would mean pretending MongoDB can be sent SQL.

The four SQL engines share **one** `SqlGenericRepository`; everything that differs
between them is isolated in a `SqlDialect`. Four near-identical subclasses would be
duplication, not abstraction.

A module gets that repository through `BaseModuleRepository`, which delegates every
generic method to the configured store and adds error logging, so no per-method
`try/catch` is needed:

```ts
export class BranchesRepository
  extends BaseModuleRepository<IBranch>
  implements IBranchesRepository
{
  constructor(store: IGenericRepository<IBranch>, logger: ILogger) {
    super(store, logger, "BranchesRepository");
  }
}
```

Failures are logged with the driver's detail and re-thrown as
`BranchesRepository.<operation> failed.` with the original error in `cause` — so
`normalizeError` can still recognise a unique-constraint violation and answer 409
instead of a blanket 500.

### The guarantee that the engines agree

`monolite-data` exports a **repository contract kit**: the set of assertions every
implementation must pass, invoked by each driver with its own factory. Insert
semantics, filter operators, ordering, paging, projections, idempotent soft delete,
`hardDeleteWhere` reaching logically deleted rows — asserted once and replayed per
driver. That is what turns "all engines behave alike" into something checked rather
than promised.

---

## Describing an entity

The domain model stays a plain interface. The mapping is the only place a column
name appears:

```ts
export const BRANCHES_ENTITY = defineEntity<IBranch>({
  table: "BRANCHES",
  primaryKey: "pkBranch",
  identity: true,
  columns: {
    pkBranch:  { name: "PK_BRANCH", kind: "number", insertable: false, updatable: false },
    name:      { name: "NAME",      kind: "string" },
    address:   { name: "ADDRESS",   kind: "string" },
    available: { name: "AVAILABLE", kind: "boolean" },
    createdAt: { name: "CREATED_AT", kind: "date", updatable: false },
    updatedAt: { name: "UPDATED_AT", kind: "date" },
    createdBy: { name: "CREATED_BY", kind: "string", updatable: false },
    updatedBy: { name: "UPDATED_BY", kind: "string" },
  },
  softDelete: { property: "available", activeValue: 1, deletedValue: 0 },
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  audit: { createdBy: "createdBy", updatedBy: "updatedBy" },
  auditTrail: true,
});
```

`columns` must cover every property of the model — TypeScript enforces it.
Renaming a physical column is a one-line change.

| Field | Meaning |
| --- | --- |
| `identity` | `true` (default): the database generates the PK. `false`: the caller must supply it, and an insert without it throws. |
| `insertable` / `updatable` | `false` for columns the database owns (identity PKs, `CREATED_AT`). Default `true`. |
| `kind` | Drives conversion in both directions: `boolean` ↔ `1/0`, `date` ↔ `Date`, `number`, `string`. Defaults to `string`. |
| `softDelete` | The column marking a row logically deleted. Omit it and the entity simply has no logical delete. `activeValue`/`deletedValue` default to `1`/`0`. |
| `timestamps` | `createdAt` / `updatedAt`. Never taken from the request body. |
| `audit` | `createdBy` / `updatedBy`, filled from the request context — the identity in the token, never the body, so a client cannot claim to be someone else. Outside a request the value is `System`. |
| `auditTrail` | `true` to write a line to the change log on every write. Opt-in per entity: the log table itself must not enable it, and not every entity is worth an extra row per operation. |

A column definition can be just its name (`name: "NAME"`) when every default suits
it.

At runtime the metadata is wrapped in an `EntitySchema`, which resolves those
shortcuts, indexes columns case-insensitively (Oracle returns identifiers
uppercased, PostgreSQL lowercased — the same mapping resolves both) and centralises
the conversions. Its `columnOf()` **throws when a property is not mapped**, and that
is the barrier keeping an arbitrary name out of a generated query.

---

## CRUD

```ts
getAll(options?: QueryOptions<T>): Promise<T[]>
getPaged(page, limit, options?): Promise<PagedResult<T>>       // { items, total, page, limit, pages }
getById(id, options?): Promise<T | null>
find(options: QueryOptions<T>): Promise<T[]>
firstOrDefault(options?): Promise<T | null>
count(where?, withDeleted?): Promise<number>
exists(where, withDeleted?): Promise<boolean>

insert(entity: Partial<T>): Promise<T>              // the persisted entity, PK included
insertMany(entities: Partial<T>[]): Promise<number> // rows written
update(id, changes: Partial<T>): Promise<T | null>  // null if the row does not exist
updateWhere(where, changes): Promise<number>        // rows affected

softDelete(id): Promise<boolean>
restore(id): Promise<boolean>
hardDelete(id): Promise<boolean>
hardDeleteWhere(where): Promise<number>

query(): IQueryable<T>
```

`QueryOptions<T>` carries `where`, `orderBy`, `skip`, `take`, `select` and
`withDeleted`.

Behaviour worth knowing, identical on every engine and pinned down by the contract
suite:

- **Reads exclude logically deleted rows by default.** Pass `withDeleted: true` to
  include them — the equivalent of EF Core's `IgnoreQueryFilters()`.
- **`insert` re-reads the row it wrote** and returns that, so the caller gets the
  generated PK and every default the database applied. An insert with nothing to
  write is an error, not an empty row.
- **`update` with no updatable change is not an error**: it returns the current
  state. Returning `null` would be read as "does not exist". A PK arriving in the
  change set is ignored.
- **`updateWhere` does not reach logically deleted rows**; `hardDeleteWhere`
  deliberately does — skipping already-flagged rows would leave orphans pointing by
  foreign key at something that just disappeared.
- **Timestamps and audit columns are never taken from the payload.** On the SQL
  engines they are written with the server's own expression, so they do not depend
  on the Node process clock.
- **`select` projects**: columns not asked for are absent from the result rather
  than present as `undefined`.

---

## The filter language

Declarative, not stringly-typed. Every value travels as a named bind and every
column name is resolved through the entity mapping, so user input never reaches the
statement text.

```ts
await branches.find({ where: { name: "Downtown" } });

await appointments.find({
  where: {
    fkBranch: 1,
    durationMin: { gte: 30, lte: 90 },
    status: { notIn: ["CANCELLED", "DONE"] },
    guestName: { contains: "walk-in" },
    fkClient: { isNull: true },
    scheduledAt: { between: [from, to] },
  },
});

await branches.getPaged(page, limit, {
  where: { $or: [{ name: { contains: search } }, { address: { contains: search } }] },
});
```

| Operator | SQL | MongoDB | In memory |
| --- | --- | --- | --- |
| `eq` `ne` `gt` `gte` `lt` `lte` | `=` `<>` `>` `>=` `<` `<=` | `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` | comparison on a normalised value |
| `like` / `notLike` | `LIKE` / `NOT LIKE` | anchored `$regex` / `$not` | anchored `RegExp` |
| `ilike` | `UPPER(col) LIKE UPPER(:bind)` | `$regex` with the `i` flag | case-insensitive `RegExp` |
| `contains` | `UPPER(col) LIKE UPPER(:bind) ESCAPE '!'` | escaped `$regex`, `i` flag | `String.includes`, lowercased |
| `in` / `notIn` | `IN (…)` / `NOT IN (…)` | `$in` / `$nin` | `some` / `every` |
| `between` | `BETWEEN … AND …` | `$gte` + `$lte` | both bounds |
| `isNull` | `IS NULL` / `IS NOT NULL` | `$eq: null` / `$ne: null` | `null` or absent |
| `$and` `$or` `$not` | nested groups | `$and`, `$or`, `$nor` with one member | recursive evaluation |

Details that are easy to get wrong, and are therefore fixed by the contract suite:

- A bare `null` (`{ tag: null }`) means `IS NULL`. On MongoDB it becomes
  `$eq: null`, which also matches documents where the field is absent — what a SQL
  engine understands by "column without a value".
- An **empty list** is not invalid syntax: `in: []` compiles to `1 = 0` and
  `notIn: []` to `1 = 1` on SQL, and to `$in: []` on MongoDB. Dynamic filters hit
  this constantly.
- A **property that is not mapped throws**, rather than silently matching nothing.
- **`contains` is the operator for user input.** `like` and `ilike` take a
  *pattern*, so a `%` or `_` typed into a form becomes a wildcard: searching `%`
  returns the whole table and `a_b` matches `axb`. `contains` takes literal text,
  neutralises the wildcards and declares an `ESCAPE` clause; each driver implements
  the meaning natively, so the caller has no pattern to get wrong. The escape
  character is `!` and not a backslash, because MySQL treats the backslash as an
  escape inside the string literal itself and `ESCAPE '\'` would arrive as an
  escaped quote.
- Filters on the same field never collide: the Mongo translator splits them into
  several documents instead of overwriting a key, and SQL joins them with `AND`.

Three translators keep those semantics aligned — `SqlWhereCompiler`,
`toMongoFilter` and `matchesFilter` — and each resolves field names through
`EntitySchema` and values through `toColumnValue`, so a model boolean is compared
against the stored `1/0` and a date travels as a `Date`.

---

## Chainable queries and paging

`query()` returns an `IQueryable<T>` that mirrors LINQ: lazy, immutable, and only
touching the database on a terminal operator.

```ts
const page = await appointments
  .query()
  .where({ fkBranch: 1 })
  .where({ status: { notIn: ["CANCELLED", "DONE"] } })  // accumulates with AND
  .orderByDescending("scheduledAt")
  .toPagedList(1, 20);

const exists = await branches.query().where({ name: "Downtown" }).any();
```

Composition: `where`, `orderBy`, `orderByDescending`, `select`, `skip`, `take`,
`withDeleted`. Terminal: `toList`, `firstOrDefault`, `count`, `any`, `toPagedList`.
`toOptions()` returns the accumulated `QueryOptions` for debugging or reuse.

Each call returns a **new** query, so a base query can be branched without the
branches contaminating each other. The builder is one class shared by all drivers —
it knows nothing about SQL or documents, it accumulates options and delegates the
terminal call to the repository that created it.

`getPaged(page, limit)` clamps both arguments to at least 1 and returns
`{ items, total, page, limit, pages }` — one count plus one windowed read. When a
paginated query has no `orderBy`, the repository falls back to ordering by the
primary key: neither Oracle nor SQL Server guarantees the order of an
`OFFSET`/`FETCH` without `ORDER BY` (SQL Server rejects it outright) and MongoDB
does not guarantee natural order, so without that fallback two consecutive pages
could repeat or skip rows.

---

## Soft delete, restore and hard delete

```ts
await branches.softDelete(id);                       // true the first time
await branches.softDelete(id);                       // false — nothing to do
await branches.getById(id);                          // null
await branches.getById(id, { withDeleted: true });   // the row, still there
await branches.restore(id);                          // true, and false if repeated
```

Both operations are **idempotent by construction**: the statement carries a
condition on the previous state, so deleting twice returns `false` the second time
instead of pretending it did something. Both count as modifications, so they stamp
`updatedAt` and `updatedBy` — a logical delete is a change and should say who made
it.

Calling `softDelete` or `restore` on an entity whose metadata declares no
`softDelete` throws, with a message telling you to use `hardDelete` or add the
metadata. Silently doing nothing would be worse.

---

## Transactions (unit of work)

**Not everything is wrapped in a transaction.** A single statement is already
atomic and travels with auto-commit; wrapping it would only add a round trip.

A transaction is opened in two cases, and the boundary is the service, not the
repository:

1. **The use case writes in more than one place** and a half-finished result would
   be invalid.
2. **It decides based on what it just read**, even if it then writes a single row.
   Checking that a slot is free and taking it are two statements, and another
   request fits between them. Here the transaction is not about atomicity but about
   isolation, and it comes with `lockRow`.

The explicit form:

```ts
await unitOfWork.execute(async (scope) => {
  await scope.lockRow("BRANCHES", id);
  await scope.repository<IAppointment>("APPOINTMENTS").hardDeleteWhere({ fkBranch: id });
  await scope.repository<IBranch>("BRANCHES").hardDelete(id);
});
```

`scope.repository(...)` returns the same generic repository bound to the
transaction, memoised per entity. Commit on success, rollback on throw, the
original error propagated untouched. The change log follows the same scope: a
rolled-back operation takes its audit line with it.

The ambient form — `@Transactional()`, in [`monolite-crud`](crud.md) — publishes
the open transaction to an `AsyncLocalStorage` so injected repositories join it
without being handed anything. Same trade-off as the request context: reading
`repository.insert(...)` you cannot tell whether it runs in a transaction. What you
*can* see is the boundary.

How each engine implements it:

| Engine | Implementation |
| --- | --- |
| Oracle | One pooled connection with `autoCommit: false`, commit or rollback around the block. |
| SQL Server · PostgreSQL · MySQL | Sequelize's managed transaction; the block receives an executor bound to it. |
| MongoDB | A `ClientSession` passed to every operation. `withTransaction` **retries** on transient server errors, so the block may run more than once and must not carry side effects outside the database. |
| In memory | Snapshots every store before running and restores them if the block throws. Transactions are queued and run one at a time: Node is single-threaded but that is not isolation — between the `await` of a read and the write that depends on it the event loop serves other requests, and two overlapping snapshots would also break the rollback, since a failure in the second would restore over what the first had already committed. |

### `lockRow(entity, id)`

Locks a row until commit. Transactions asking for the same row queue behind it.

Locking the **parent** row — the branch of an appointment, not the appointment —
serialises only the callers that actually compete, and lets other branches book in
parallel.

**It has to be the transaction's first statement.** MySQL defaults to REPEATABLE
READ and pins the snapshot on the first consistent read; if a plain SELECT runs
before the lock, later reads keep seeing the old state even once the lock is
granted. A locking read does not pin a snapshot, so opening with it makes the
checks see the latest committed data on all four engines.

| Engine | Statement |
| --- | --- |
| Oracle · PostgreSQL · MySQL | `SELECT pk FROM t WHERE pk = :pk FOR UPDATE` |
| SQL Server | `SELECT pk FROM t WITH (UPDLOCK, HOLDLOCK) WHERE pk = :pk` — T-SQL has no `FOR UPDATE`; `HOLDLOCK` is what keeps it until commit |
| MongoDB | No locking read exists. The guarantee comes from a unique index instead, and the driver returns a duplicate-key error the mapper turns into a 409 |
| In memory | Nothing to lock: the whole transaction already runs exclusively |

The lock only reaches the requests of **one process**. With more than one instance
running, the guarantee has to be in the database — a partial unique index on the
columns that must not collide.

---

## Where the generic API stops

### Relations are composed in the service

A repository knows exactly one table. Composing across aggregates is a business
decision, so it happens in the service layer — the equivalent of EF Core's
`Include()`. `loadRelated` resolves an N:1 relation in **one batched query**
(`WHERE key IN (…)`), not one per row:

```ts
const branches = await loadRelated<IAppointment, IBranch>(appointments, {
  foreignKey: "fkBranch",
  relatedKey: "pkBranch",
  repository: branchesRepository,
});
```

Null foreign keys are skipped and nothing is queried when there is nothing to
resolve. `withDeleted` defaults to `true` here: a record should still display its
parent's name after the parent has been logically deleted.

Nothing above reads the metadata, because until now the metadata had nothing to
say about it: a foreign key was a `kind: "number"` column with a name that
happened to look like one. Declaring the relation gives it a name:

```ts
export const BOOKS_ENTITY = defineEntity<IBook>({
  table: "BOOKS",
  primaryKey: "pkBook",
  columns: {
    pkBook: { name: "PK_BOOK", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string" },
    authorId: { name: "FK_AUTHOR", kind: "number" },
  },
  relations: {
    author: { to: "AUTHORS", localKey: "authorId", foreignKey: "pkAuthor", onDelete: "restrict" },
  },
});
```

**The repository still does not read this.** It knows one table, fires no join,
and a relation changes nothing about how a row is selected, inserted or
filtered. `onDelete` is what the generated DDL should say and nothing else —
there is no cascade to run at query time, because nothing looks.

What it buys is one statement of a fact that was being made three times: the
constraint in generated DDL, the relation `monolite generate module` needs in
order to scaffold a related module, and the keys a reader would otherwise have to
find by reading two files. A relation pointing at an entity nobody registered
fails while the persistence layer is being assembled, naming both sides — not
later, when something follows it, because nothing ever does.

The include a service declares still names its own keys. The metadata knows the
*entity* property; an include needs the *DTO* property, and only the mapper knows
how those two correspond.

### A second interface for extra SQL

A module gets the generic repository **plus** its own interface only when it needs
something the generic API cannot express:

```ts
// Enough on its own.
export type IBranchesRepository = IGenericRepository<IBranch>;

// The generic contract plus a GROUP BY.
export interface IAppointmentsRepository extends IGenericRepository<IAppointment> {
  countByStatus(fkBranch?: number): Promise<AppointmentStatusCount[]>;
}
```

Aggregations are outside the filter language on purpose: adding them would turn it
into a full ORM. `SqlGenericRepository.executeRaw()` is the documented escape hatch
for them — and for views and stored procedures. Values still travel as binds, and
physical names still come from the mapping:

```ts
const statusColumn = store.schema.columnOf("status");
const rows = await store.executeRaw<{ STATUS: string; TOTAL: number }>(sql, binds);
```

A module that takes that path usually keeps a JavaScript fallback for the non-SQL
engines, so it still works under the in-memory driver and MongoDB.

---

## The engines

| `DATA_SOURCE` | Engine | Repository | Connector |
| --- | --- | --- | --- |
| `memory`, `dummy` | in-process arrays | `MemoryGenericRepository` | — |
| `oracle` | Oracle 23ai | `SqlGenericRepository` + `oracleDialect` | `OracleConnector` — node-oracledb 7, thin mode |
| `mssql`, `sqlserver` | SQL Server 2022 | `SqlGenericRepository` + `sqlServerDialect` | `SequelizeConnector` — tedious |
| `postgres` | PostgreSQL 16 | `SqlGenericRepository` + `postgresDialect` | `SequelizeConnector` — pg |
| `mysql`, `mariadb` | MySQL 8 | `SqlGenericRepository` + `mysqlDialect` | `SequelizeConnector` — mysql2 |
| `mongo`, `mongodb` | MongoDB 7 | `MongoGenericRepository` | `MongoConnector` — mongodb driver |

An unknown value **fails at startup** instead of falling back to memory: a mistyped
`postgress` would otherwise boot in memory and only surface much later, as data
that does not persist.

Every driver is an **optional peer dependency**. Install the one you use; the
package does not pull the other five.

One connector covers three engines because Sequelize speaks all three. The only
thing it resolves per engine is how to ask the driver for the two things they do
not all report the same way: affected rows and the generated id.

### What a dialect encodes

| | Generated PK | Server "now" | Pagination |
| --- | --- | --- | --- |
| Oracle | `RETURNING … INTO` (out bind) | `SYSTIMESTAMP` | `OFFSET … FETCH NEXT` |
| SQL Server | `OUTPUT INSERTED` | `SYSDATETIME()` | `OFFSET … FETCH NEXT` |
| PostgreSQL | `RETURNING` | `NOW()` | `OFFSET … FETCH NEXT` |
| MySQL / MariaDB | the driver (`LAST_INSERT_ID()`) | `CURRENT_TIMESTAMP(3)` | `LIMIT … OFFSET` |

`OUTPUT INSERTED` is preferred over `SCOPE_IDENTITY()` because it does not depend
on session scope. MySQL is the odd one out twice: it has neither `RETURNING` nor
`OUTPUT`, and it does not understand `OFFSET … FETCH NEXT` — when only an offset is
needed it gets `LIMIT 18446744073709551615`, the trick the MySQL manual itself
documents for "from row N to the end".

That first column is why `ISqlExecutor.execute` takes an `expects` hint
(`rows` | `affected` | `identity`): the repository knows whether a statement yields
a result set, a row count or a generated id, and each connector answers
accordingly. Oracle ignores the hint — it returns all three in one response.

### Three traps worth inheriting

**The timezone trap.** Sequelize escapes a `Date` as *local time with offset*. SQL
Server and MySQL drop that offset when storing it, then read the column back *as if
it were UTC*, so every round trip shifts by the local offset. The symptom is
subtle: an overlap rule silently stops detecting clashes, because the comparison on
the JavaScript side sees times hours apart. Both dialects normalise `Date` binds to
UTC without an offset, which is exactly what the read side assumes. Oracle and
PostgreSQL do not need it — node-oracledb preserves the instant and the PostgreSQL
column is `TIMESTAMPTZ`. **If you add another engine, test a date round trip
explicitly.** This one bit the original codebase twice.

**PostgreSQL folds unquoted identifiers to lowercase**, in the DDL exactly as in
queries. Create the schema *without* quotes, so the uppercase SQL the repository
generates folds to the very same names; column-to-property mapping is
case-insensitive, so results coming back lowercased map cleanly. Quoting the DDL is
precisely what breaks it.

**Sequelize `replacements` are escaped and interpolated, not server-side
parameters.** Sequelize escapes per dialect, so it is safe against injection, but it
does not reuse execution plans the way a real bind would. node-oracledb does use
real binds. Worth knowing before you benchmark.

### Connections

A pooled `connection.close()` returns the connection to the pool; it does not tear
down the socket. Every acquisition is paired with a release in a `finally`, so a
connection is held only for the statement — except inside a transaction, where one
connection is held for the whole block, because a `COMMIT` only makes sense on the
session that did the writes. Keep those blocks short.

Pools and clients are created lazily and memoised, so a burst of requests at
startup opens exactly one. A failed attempt is **not** cached: a transient failure —
the database still booting, a replica still electing a primary — must not poison the
process.

### MongoDB, the one that shares no implementation

It offers exactly the same contract, with four real divergences:

- **Transactions require a replica set.** A standalone `mongod` has no oplog and
  rejects `startTransaction`. Since the repository writes each operation and its
  audit line atomically, the API does not work at all without one.
- **Numeric primary keys come from a `_counters` collection** — the canonical
  sequence pattern, one document per entity, incremented with an atomic
  `findOneAndUpdate`. The reservation deliberately happens *outside* the
  transaction's session: two transactions touching the same counter document would
  conflict and one would abort. A sequence that does not give the number back on
  rollback is exactly how Oracle sequences and SQL Server `IDENTITY` behave, so
  **gaps are possible, and that is the faithful behaviour**.
- **Timestamps are written by the application.** MongoDB has no server-side
  equivalent of `SYSTIMESTAMP` evaluated on write.
- **A `$jsonSchema` validator rejects documents, it does not complete them.**
  Everything the SQL engines fill in with a column `DEFAULT` has to be written by
  the repository. A default the application does not supply simply will not exist
  in the document, so leave such fields out of `required` — demanding them would
  reject an insert the other four engines accept.

MongoDB also has no foreign keys, so referential existence is checked by the
application. `_id` is excluded from every projection: it is Mongo's technical key,
not part of the domain model, and it has no counterpart in the other engines.

---

## Adding a new engine

If it is SQL and Sequelize speaks it, it is a dialect plus a little wiring:

1. Add the dialect — how a generated PK comes back, the server's now expression,
   the pagination clause, the row-lock statement, and any bind conversion the
   driver needs.
2. Register it in the repository factory and in the `SequelizeEngine` union.
3. Add the alias, the environment variables and the schema.

If it is not SQL, it needs its own `IGenericRepository<T>` implementation, its own
filter translator and its own unit of work — that is what MongoDB has.
`MemoryGenericRepository` is the reference: it implements the same contract with no
SQL at all.

Either way:

- **Point the contract kit at it first.** It is the definition of "behaves like the
  others", and it is cheaper to satisfy than to retrofit.
- **Test a date round trip explicitly**, for the reason above.
- **Do not add the alias before the implementation exists.** Listing it early makes
  `DATA_SOURCE` boot in memory and hide the problem, which is the one thing that
  table is there to prevent.
