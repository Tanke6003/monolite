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
parameters into a filter.

```ts
protected override buildWhere(query: ListQuery): WhereFilter<IBranch> {
  const where = super.buildWhere(query);
  // Only the caller's own branches, whatever else they asked for.
  return { $and: [where, { fkOwner: Number(this.context.getCurrentUserId()) }] };
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
    repository: IGenericRepository<IAppointment>,
    // Injected rather than inherited: `lockRow` is a standalone function exactly
    // so that a BLL already extending `CrudBLL` is not forced into a
    // second base class. See the note below.
    private readonly transactions: ITransactionContext
  ) {
    super(repository, appointmentMapper);
  }

  @Transactional()
  public async book(input: BookInput): Promise<AppointmentDto> {
    // Locking the branch row is the first statement on purpose — see below.
    await lockRow(this.transactions, ENTITY.BRANCHES, input.fkBranch);

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

That resolution is what `registerPersistence` wires when it is given a
`transactions` context — every store it binds joins whatever transaction is open
and falls back to the pool when there is none. Generated projects pass it, so it
is already true of yours. A composition root written by hand that omits it gets
stores that write on their own connection regardless of the decorator, which is
the quiet kind of wrong: three auto-commits look exactly like one transaction
until something in the middle throws.

Three things about it that are decisions rather than accidents:

**It joins rather than nests.** A `@Transactional()` method called from inside
another one reuses the open transaction. Nesting a second one would deadlock
against the first on the rows it already holds.

**It rejects rather than throws when there is no unit of work.** A configuration
with the in-memory driver and no unit of work registered gets a rejected promise
with a clear message, not a synchronous throw from inside a decorator, which is
much harder to trace back.

**`lockRow` is a standalone function, not a base-class method.** A BLL that
needs a row lock may already extend `CrudBLL`, and TypeScript has no multiple
inheritance. Passing the transaction context explicitly costs one argument and
avoids forcing an inheritance chain on anyone.

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
| `create(input)` | Insert, then map to the DTO |
| `update(id, input)` | |
| `softDelete(id)` | |
| `buildWhere(query)` | Protected hook: query parameters → `WhereFilter<T>` |
| `resolveQuery(query)` | Protected hook, async: completes the query before `buildWhere` reads it |
| `includes` | Relations resolved on every verb, declared at construction with `include()` |
| `mapper` | `EntityMapper<TEntity, TDto>` — entity ↔ DTO in one place |

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
