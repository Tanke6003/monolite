# Generic CRUD

> 🇪🇸 [Leer en español](../es/crud.md) · package: `monolite-crud`

`monolite-data` removed the repetition below the BLL: one repository
implementation instead of six. `monolite-crud` removes what was left above it —
the controller that parses an id, wraps everything in `try/catch` and calls a
BLL that only forwards to the repository.

---

## The whole of a module

```ts
@injectable()
@ApiController("/branches", { tag: "Branches", token: BRANCH_TOKENS.controller })
@Crud({ resource: "branch", dto: "Branch", schemas: branchSchemas })
export class BranchesController extends CrudController {
  constructor(
    @inject(BRANCH_TOKENS.bll) bll: BranchesBLL,
    @inject(TOKENS.IRequestContext) context: IRequestContext
  ) {
    super(bll, context, "branch");
  }
}
```

```ts
export class BranchesBLL extends CrudBLL<IBranch, BranchDTO> {
  constructor(@inject(BRANCH_TOKENS.store) store: IGenericRepository<IBranch>) {
    super(store, branchMapper, { field: "pkBranch", direction: "asc" });
  }
}
```

That is five endpoints:

| Verb | Path | Handler |
| --- | --- | --- |
| `GET` | `/branches` | `list` — paginated, filterable, `withDeleted` optional |
| `GET` | `/branches/:id` | `getOne` — 404 `NOT_FOUND` when absent |
| `POST` | `/branches` | `create` — 201 with the created resource |
| `PUT` | `/branches/:id` | `update` |
| `DELETE` | `/branches/:id` | `softDelete` |

Each one arrives with validation, the paginated envelope, error mapping and an
OpenAPI entry, because `@Crud()` registers exactly the same route metadata a
hand-written controller would.

---

## Options

| Option | Meaning |
| --- | --- |
| `resource` | Singular name, used in messages and in generated summaries. No article: the decorator builds the prose around it |
| `dto` | **The name of the OpenAPI component** the responses reference — a string, not the schema object |
| `paged` | Name of the page's component. Defaults to `Paginated<dto>` |
| `schemas` | `{ create, update, query }` — the Zod schemas mounted as validation |
| `verbs` | Which of the five to register. Omit for all of them |

`dto` is a name and not a schema because the decorator only writes a `$ref` with
it. Registering the component is a separate step, and a required one:

```ts
export const branchDto = defineDto("Branch", z.object({ /* ... */ }));
export const paginatedBranchesDto = definePagedDto("PaginatedBranch", branchDto);
```

Skip it and the document still serves, with every operation pointing at a
component that does not exist — Swagger UI shows an empty body and Scalar shows
nothing. `mountDocs` in a generated project checks for exactly this at startup
and logs the missing names; `missingSchemaRefs(document)` is the same check, for
a test.

```ts
// A read-only resource: two endpoints, and nothing can write to it through HTTP.
@Crud({ resource: "audit log", dto: "AuditLog", verbs: ["list", "getOne"] })
```

---

## Overriding

The decorator only fills gaps. Declare a method with the same name and yours wins —
no flag, no opt-out list:

```ts
@ApiController("/appointments", { tag: "Appointments", token: APPOINTMENT_TOKENS.controller })
@Crud({ resource: "appointment", dto: "Appointment", schemas })
export class AppointmentsController extends CrudController {
  constructor(
    private readonly appointments: AppointmentsBLL,
    context: IRequestContext
  ) {
    super(appointments, context, "appointment");
  }

  // Replaces the generic create: booking has a rule the generic one cannot know.
  @Post("/", {
    body: bookSchema,
    responses: { 201: { ref: "Appointment" }, 409: "Slot taken" },
  })
  public override create: CrudHandler = async (req, res, next) => {
    try {
      res.status(201).json(await this.appointments.book(req.body));
    } catch (error) {
      next(error);
    }
  };

  // And adding an endpoint the generic set does not have is just a decorator.
  @Get("/upcoming", { query: upcomingSchema })
  public upcoming = async (req: Request, res: Response) => { /* ... */ };
}
```

This works because routes are mounted [by specificity](routing.md), so
`/appointments/upcoming` is registered ahead of `/appointments/:id` regardless of
where the decorator put it.

The BLL side works the same way: override `create` in your `CrudBLL`
subclass, or override the `buildWhere` hook to change how `list` translates query
parameters into a filter. Filters that are only a mapping — this parameter, that
column — are better [declared](#filtering-the-listing); the hook is for the ones
that are a rule. `super.buildWhere(query)` hands back the declared ones, and
`allOf` combines them with yours:

```ts
protected override buildWhere(query: ListQuery): WhereFilter<IBranch> | undefined {
  // Only the caller's own branches, whatever else they asked for.
  return allOf(super.buildWhere(query), { fkOwner: Number(this.context.getCurrentUserId()) });
}
```

`buildWhere` is synchronous on purpose. It is the hook every module overrides, and
one that could `await` would put a query in front of every listing in the project —
paid for by all of them, needed by few.

Some filters do have to read somewhere else first, though. "Books whose author is
called Le Guin" is two steps: the keys of the authors whose name matches, then the
books holding those keys. That step goes in **`resolveQuery`**, which runs before
`buildWhere` and hands it a completed query:

```ts
protected override async resolveQuery(query: unknown): Promise<unknown> {
  const { author } = (query ?? {}) as { author?: string };
  if (!author) return query;

  const matches = await this.authors.find({ where: { name: { contains: author } } });
  // A name nobody is called must not become an empty filter: `{ in: [] }` filters
  // nothing away on some drivers, and a failed search would answer with the lot.
  return { ...query, authorIds: matches.length ? matches.map((a) => a.pkAuthor) : [-1] };
}
```

The point of the seam is what you keep: paging, the default ordering and
`withDeleted` all still come from the base class. Overriding `list` to make room
for the lookup means copying all three, and each copy is a place to drop one.

---

## Filtering the listing

Most of a listing's filters are a mapping: `clientId` is equality on `clientId`,
`q` searches `reference`, `from` and `to` bound `paymentDate`. Declare the mapping
next to the query schema instead of coding it in the BLL:

```ts
import { contains, eq, filtersFor, gte, lte } from "monolite-crud";

export const paymentFilters = filtersFor<IPayment, z.infer<typeof paymentQuerySchema>>({
  q:        contains(["reference", "notes"]),
  clientId: eq("clientId"),
  methodId: eq("methodId"),
  from:     gte("paymentDate", { boundary: "startOfDay" }),
  to:       lte("paymentDate", { boundary: "endOfDay" }),
});
```

and tell the BLL which one it uses:

```ts
constructor(@inject(PAYMENT_TOKENS.store) store: IGenericRepository<IPayment>) {
  super(store, paymentMapper, {
    orderBy: { field: "paymentDate", direction: "desc" },
    filters: paymentFilters,
  });
}
```

The default `buildWhere` answers with them, so the module writes no `buildWhere` at
all. What you get for free:

- **The assembly.** No parameter present is `undefined` — no filter, not an empty
  `$and`. One is the bare clause, not a one-element `$and`, so the SQL does not
  change when a module migrates from a hand-written `buildWhere`. Several are an
  `$and`, in the order the rules are declared. Absent means `undefined`, `null` or
  the empty string a blank search box submits; `0` and `false` are values.
- **Several columns in one search.** `contains(["reference", "notes"])` is an `$or`
  of one case-insensitive `contains` per column — the reason so many modules used
  to search only the first column somebody thought of.
- **The date-range convention, named.** `startOfDay` is `T00:00:00.000Z`,
  `endOfDay` is `T23:59:59.999Z`: the same decision in every module, and the one
  that changes in one place if the application ever gets a timezone. The parameter
  must be a calendar date (`YYYY-MM-DD`, or a `Date` read by its UTC day);
  anything else — a timestamp, `2026-02-30` — is refused with a 400 naming the
  parameter rather than becoming a filter that silently matches nothing.
- **Compile-time checks.** A rule naming a property `IPayment` does not have fails
  the build. Pass the query's type as the second type argument and a parameter the
  schema does not have fails it too — the drift a hand-written cast used to hide.

The builders are `eq`, `contains`, `gte`, `lte`, `gt` and `lt`. The map is declared
rather than inferred from the schema on purpose: `from` and `to` do not name their
column, `q` maps to a different one in every module, and a parameter that shares a
name with a column is not always a filter on it.

A filter that is logic — "overdue" meaning a date *and* a status *and* no payment
against it — is not a mapping and stays an overridden `buildWhere` (see
[Overriding](#overriding)), combining its rule with the declared filters through
`allOf(super.buildWhere(query), rule)`.

---

## Relations

A book carries its author's *name*, not just the key — the key is what a client
sends back when it edits, the name is what it has to print, and a listing that
carries only the key costs a request per row.

Declare the relation once, where the BLL is built:

```ts
export class BooksBLL extends CrudBLL<IBook, BookDTO> {
  constructor(books: IGenericRepository<IBook>, authors: IGenericRepository<IAuthor>) {
    super(books, bookMapper, {
      orderBy: { field: "name", direction: "asc" },
      includes: [
        include<BookDTO, IAuthor>({
          key: "authorId",       // the DTO property holding the foreign key
          relatedKey: "pkAuthor",
          repository: authors,
          into: "author",        // the DTO property the name goes into
          pick: (author) => author.name,
        }),
      ],
    });
  }
}
```

and mark the field it fills in the mapper, so that nothing writes it back and
everybody can see where it comes from:

```ts
const bookMapper = createMapper<IBook, BookDTO>({
  id: { field: "pkBook", readOnly: true },
  name: "name",
  authorId: "authorId",
  author: hydrated(),
});
```

That is the whole of it. `list`, `getOne`, `create` and `update` all resolve it,
because they all go through one place inside `CrudBLL` — and **a field
declared with `hydrated()` that no include fills stops the BLL from being
constructed**, naming the field. The mistake this replaces is not hypothetical:
calling `loadRelated` by hand in each of the four verbs and remembering only two
produces a resource that carries its author when it was read and not when it was
written, with a DTO that says the field is there either way.

One batched query per relation per page — `WHERE key IN (…)`, the same thing
EF Core's `Include()` does — and none at all when every key is null. Soft-deleted
parents are included on purpose: a book has to keep showing its author after that
author is withdrawn, or a historical row becomes unreadable.

`loadRelated` is still exported for the cases this does not cover: a relation
that is not one-to-one with a DTO field, or one resolved inside a verb the module
wrote itself.

---

## Transactions

A use case that writes in more than one place needs a transaction. Threading one
through controller → BLL → repository would put a parameter in every signature
for the benefit of the few methods that use it, so the transaction is **ambient**:

```ts
export class AppointmentsBLL extends CrudBLL<IAppointment, AppointmentDto> {
  constructor(
    // The store carries the unit of work it joins, so this is the whole
    // constructor: no second base class, nothing else to inject.
    @inject(APPOINTMENT_TOKENS.store) repository: IGenericRepository<IAppointment>
  ) {
    super(repository, appointmentMapper);
  }

  @Transactional()
  public async book(input: BookInput): Promise<AppointmentDto> {
    // Locking the branch row is the first statement on purpose — see below.
    await lockRow(this, ENTITY.BRANCHES, input.fkBranch);

    const clash = await this.repository.firstOrDefault({
      where: { fkBranch: input.fkBranch, startsAt: input.startsAt },
    });
    if (clash) {
      throw new AppError(`The branch already has appointment #${clash.pk} in that slot`, 409, true, {
        code: "APPOINTMENT_OVERLAP",
      });
    }

    return this.mapper.toDTO(await this.repository.insert(input));
  }
}
```

`@Transactional()` opens a unit of work and publishes it to the ambient
`ITransactionContext`. Every repository called inside — including ones several
layers down that were never told about it — resolves its store through that
context and joins the same transaction. Nothing is passed.

**`CrudBLL` carries the seam.** The decorator needs a unit of work to open the
transaction and a transaction context to tell whether one is already open, and a
`CrudBLL` subclass has both without asking: they come with the store it was
handed. That resolution is what `registerPersistence` wires when it is given a
`transactions` context — every store it binds joins whatever transaction is open,
falls back to the pool when there is none, and carries the unit of work it joins.
Generated projects pass it, so it is already true of yours.

A composition root written by hand that omits the context gets stores that write
on their own connection, and no seam: `@Transactional()` then rejects at the
first call, naming what is missing, rather than running the method on
auto-commit — three auto-commits look exactly like one transaction until
something in the middle throws. The same goes for the in-memory driver in a unit
test built over a bare store.

A class can still supply the two members itself — extend `TransactionalBLL`, or
inject `IUnitOfWork` and `ITransactionContext` and keep them as `unitOfWork` and
`transactions`, with `implements TransactionalHost` to make a missing one a
compile error. When it does, its own members are the ones used. That was the
only shape for a `CrudBLL` subclass before
[#33](https://github.com/Tanke6003/monolite/issues/33), and it keeps compiling
unchanged.

**The default writes are atomic.** `create`, `update` and `softDelete` in
`CrudBLL` run in a transaction whenever there is a unit of work to open one with.
Each is one call and several statements underneath — the row, its change-log
entry, the read back — and the cost of the default is a transaction around a
single insert, where the cost of the opposite default was every generated module
being silently non-atomic. Called from inside a `@Transactional()` override,
`super.create(...)` joins the override's transaction, so this is enough to keep a
check and the insert together:

```ts
export class PaymentsBLL extends CrudBLL<IPayment, PaymentDto> {
  @Transactional()
  override async create(dto: Partial<PaymentDto>): Promise<PaymentDto> {
    await this.assertConsistent(dto);
    return super.create(dto);
  }

  private async assertConsistent(dto: Partial<PaymentDto>): Promise<void> {
    // The reads against the other tables; a throw here rolls the insert back.
  }
}
```

For the part of a method rather than all of it — a method that reads first and
only then decides what to write — `this.tx(() => ...)` runs the callback in a
transaction, joining one already open, and refuses without a unit of work just
as the decorator does. It is also the one place the default writes go through,
so a module that wants them on auto-commit after all (a hot insert path, or
MongoDB without a replica set, where there is no transaction to open) overrides
it:

```ts
protected override tx<R>(fn: () => Promise<R>): Promise<R> {
  return fn();
}
```

Three things about it that are decisions rather than accidents:

**It joins rather than nests.** A `@Transactional()` method called from inside
another one reuses the open transaction. Nesting a second one would deadlock
against the first on the rows it already holds.

**It rejects rather than throws when a member is missing.** A configuration with
the in-memory driver and no unit of work registered gets a rejected promise
naming the member and both ways of supplying it, not a synchronous throw from
inside a decorator, which is much harder to trace back.

**`lockRow` is a standalone function, not a base-class method.** A BLL that
needs a row lock may already extend `CrudBLL`, and TypeScript has no multiple
inheritance. It takes the service itself — `lockRow(this, ...)` finds the context
the way the decorator did — or the transaction context explicitly, which costs
one argument and avoids forcing an inheritance chain on anyone.

### Why the lock goes first

On MySQL, `REPEATABLE READ` pins the transaction's snapshot at its **first read**.
A check-then-write that reads before locking reads the pre-lock snapshot, so both
concurrent transactions see "no clash" and both insert. Taking the lock as the
first statement is what makes the subsequent read see committed reality.

The lock also needs a partial unique index behind it as a backstop — the lock
serialises the two transactions, and the index catches the case the lock cannot
cover, such as two different application instances racing before either takes it.
Generated projects ship that index in every engine's schema.

---

## What `CrudBLL` gives you

| Member | Purpose |
| --- | --- |
| `list(options)` | Paginated read; `options.withDeleted` includes soft-deleted rows, `options.query` feeds `buildWhere` |
| `getOne(id)` | `null` when absent — the controller turns that into a 404, so the BLL stays HTTP-free |
| `create(input)` | Insert — in a transaction when there is a unit of work — then map to the DTO |
| `update(id, input)` | In a transaction when there is a unit of work |
| `softDelete(id)` | In a transaction when there is a unit of work |
| `buildWhere(query)` | Protected hook: query parameters → `WhereFilter<T>`; by default, the declared `filters` |
| `filters` | The listing's filters, declared at construction with `filtersFor()` |
| `resolveQuery(query)` | Protected hook, async: completes the query before `buildWhere` reads it |
| `includes` | Relations resolved on every verb, declared at construction with `include()` |
| `mapper` | `EntityMapper<TEntity, TDto>` — entity ↔ DTO in one place |
| `tx(fn)` | Protected: runs `fn` in a transaction, joining one already open; overridden to `return fn()`, it puts the default writes back on auto-commit |

The BLL knows nothing about HTTP: it returns `null`, not a 404, and throws
`AppError`, not a response. That is what lets the same BLL back a CLI command,
a scheduled job or a message consumer without carrying Express into them.

---

## When not to use it

`@Crud()` is right for a resource whose five basic operations are genuinely
generic. It is the wrong tool when:

- **Every verb has a rule.** If you override all five, the decorator is adding
  indirection and removing nothing. Write the controller.
- **The resource is not a row.** A report, a search across three aggregates, or an
  action endpoint (`POST /orders/:id/ship`) is not CRUD and should not pretend to
  be.
- **The list needs a join.** `buildWhere` filters one table. A list that must join
  belongs in a repository method with real SQL — see
  [data-access.md](data-access.md) on why the generic repository stops at joins.
