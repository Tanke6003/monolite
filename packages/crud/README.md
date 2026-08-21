# monolite-crud

The CRUD you stop writing.

`monolite-data` removed the SQL: you describe a table and get a repository.
This package does the same thing one layer up. You supply a repository and a
mapper, and you get the service; you put one decorator on the controller, and
you get the five routes with their validation and their OpenAPI. What
disappears is the pass-through — the `try/catch` that defers to the global error
handler, the id parsing that turns `/users/abc` into a 400, the 404 when there
is no row, the status code of each verb — which every module used to write
identically.

Nothing here is all-or-nothing: any verb can be dropped and declared by hand,
`buildWhere` is the seam for a module's own filtering, and a service with real
business rules overrides the verb that has them and keeps the other four.

## Install

```bash
npm install monolite-crud
```

It expects `express@^5` in the host application, and it builds on
`monolite-core`, `monolite-data` and `monolite-http`.

## Usage

A whole module, end to end.

**1. The mapper** declares once which DTO property comes from which entity
property, and both directions follow from it:

```ts
import { createMapper } from "monolite-crud";

const userMapper = createMapper<IUser, UserDTO>({
  id: "pkUser",
  name: "name",
  email: "email",
  // Computed fields and read-only ones never travel back to the entity.
  displayName: { computed: (user) => `${user.name} <${user.email}>` },
  createdAt: { field: "createdAt", readOnly: true },
});
```

**2. The service** is the repository plus the mapper. Override `buildWhere` when
the listing has to filter:

```ts
import { CrudService } from "monolite-crud";
import type { IGenericRepository, QueryOptions } from "monolite-data";

export class UsersService extends CrudService<IUser, UserDTO> {
  constructor(repository: IGenericRepository<IUser>) {
    super(repository, userMapper, { field: "name", direction: "asc" });
  }

  protected override buildWhere(query: unknown): QueryOptions<IUser>["where"] {
    const { search } = (query ?? {}) as { search?: string };
    return search ? { name: { contains: search } } : undefined;
  }
}
```

**3. The controller** is the declaration. `@Crud()` mounts the routes on the
concrete class — it cannot live on the base, or the routes would register under
the base's name:

```ts
import { Crud, CrudController } from "monolite-crud";
import { ApiController } from "monolite-http";

@ApiController("/users", { tag: "Users" })
@Crud({
  resource: "user",
  dto: "User",
  schemas: { create: createUserSchema, update: updateUserSchema, query: listUsersSchema },
})
export class UsersController extends CrudController {
  constructor(service: UsersService, context: IRequestContext) {
    super(service, context, "user");
  }
}
```

`GET /users`, `GET /users/:id`, `POST /users`, `PUT /users/:id` and
`DELETE /users/:id` are now live, validated by those Zod schemas and documented
from them — the schema exists once, so the documentation cannot drift from what
the endpoint actually accepts.

### Keeping a verb of your own

Drop it from `verbs` and declare it with its own route decorator:

```ts
@Crud({ resource: "user", dto: "User", verbs: ["list", "getOne", "update"] })
export class UsersController extends CrudController {
  constructor(
    private readonly users: UsersService,
    context: IRequestContext
  ) {
    super(users, context, "user");
  }

  @Post("/", { summary: "Register a user", body: registerSchema })
  public override create: CrudHandler = async (req, res, next) => {
    /* ... */
  };
}
```

Declaring it *without* dropping it is a mistake, and it fails at startup: the
duplicate-route detector reports two routes for the same path rather than
letting the second one be silently unreachable.

## Transactions

`@Transactional()` replaces the `unitOfWork.execute(...)` that used to wrap a
method body. If a transaction is already open it joins it instead of nesting
another, so two transactional services calling each other share one commit.

```ts
import { lockRow, Transactional, TransactionalService } from "monolite-crud";

export class AppointmentsService extends TransactionalService {
  @Transactional()
  async book(branchId: number, slot: Date): Promise<void> {
    // Must be the first statement: MySQL fixes the snapshot on the first
    // consistent read, so a plain SELECT before the lock would keep reading
    // stale state even after the lock is granted.
    await this.lockRow("branch", branchId);
    /* ... */
  }
}
```

A service that already extends `CrudService` cannot also extend
`TransactionalService` — TypeScript has no multiple inheritance — so `lockRow`
is exported as a standalone function too, taking the transaction context
explicitly.

## Loading relations

`loadRelated` is EF Core's `Include()` for this architecture: relations between
aggregates are resolved in the application layer, because each repository knows
a single table. The load is batched — one `WHERE key IN (...)` per relation, not
one query per row.

```ts
const branches = await loadRelated(appointments, {
  foreignKey: "fkBranch",
  relatedKey: "pkBranch",
  repository: branchRepository,
});
```

## API

| Export | What it is |
| --- | --- |
| `CrudService`, `ICrudService`, `ListOptions`, `PaginatedDTO`, `EntityMapper` | The service layer and its contracts |
| `CrudController`, `ICrudController` | The five HTTP handlers |
| `Crud`, `CrudOptions`, `CrudVerb` | The decorator that mounts the routes |
| `createMapper`, `Mapper`, `MappingProfile`, `FieldMapping`, `MappedField`, `ComputedField` | Declarative entity <-> DTO mapping |
| `Transactional`, `TransactionalService`, `lockRow` | Ambient transactions |
| `loadRelated`, `IncludeSpec` | Batched loading of an N:1 relation |

## License

MIT
