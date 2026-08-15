# Decorated routes and OpenAPI

> 🇪🇸 [Leer en español](../es/routing.md) · package: `@monolite/http`

A controller declares its own routes. **Three** things come out of that single
declaration at once: the Express routing, the request validation, and the OpenAPI
document. You do not write them separately, and they cannot disagree.

---

## What it looks like

```ts
@ApiController("/users", { tag: "Users", token: TOKENS.IUsersController })
export class UsersController extends BaseController {
  constructor(private readonly users: IUsersService, context: IRequestContext) {
    super(context);
  }

  @Get("/", {
    summary: "Paginated list of users",
    query: paginationSchema,
    responses: { 200: { ref: "PaginatedUsers" } },
  })
  public getAll = async (req: Request, res: Response, next: NextFunction) => {
    // ...
  };

  @Post("/", {
    summary: "Create a user",
    body: createUserSchema,
    responses: { 201: { ref: "User" }, 400: "Validation error" },
  })
  public create = async (req: Request, res: Response, next: NextFunction) => {
    // ...
  };
}
```

Mounting is generic — nothing per module:

```ts
for (const [type, metadata] of registeredControllers()) {
  registerController(router, type, container.resolve(metadata.token), authGuard);
}
```

The only requirement is that the class is **loaded**, which its `import` takes care
of. A controller in a file nobody imports does not exist, because the decorator
never runs.

---

## The decorators

| Decorator | What it declares |
| --- | --- |
| `@ApiController(prefix, { tag, token })` | Path prefix, the OpenAPI tag, and the token the container resolves the instance with |
| `@Get` `@Post` `@Put` `@Patch` `@Delete` | Verb and path, relative to the prefix |

Route options:

| Option | Effect on routing | Effect on the document |
| --- | --- | --- |
| `body` | Mounts `validateBody(schema)` | `requestBody` from the validator's JSON Schema |
| `requestBody` | — | A non-JSON body described by hand — a `multipart/form-data` upload, for instance |
| `query` | Mounts `validateQuery(schema)` | One `parameter` per property of the schema |
| `params` | — | One required path `parameter` per entry |
| `public: true` | Does **not** mount the auth guard | Omits `security` and the automatic 401 |
| `use` | Extra middleware, after validation | — |
| `summary` / `description` | — | What a reader sees in the UI |
| `responses` | — | Status codes, their description and their body (`ref` to a component, or a Zod `schema`) |

A 4xx or 5xx that declares no body references the `ErrorResponse` component — the
envelope the global error handler actually returns. The client therefore sees, in
the documentation, the stable `code` to branch on and the `requestId` to quote to
support.

The mounted chain is always the same, in this order:

```
auth guard  →  validation  →  your middleware  →  handler
```

Validation goes **after** the guard deliberately: an unauthenticated caller is not
told which fields the endpoint expects.

---

## Two details worth knowing

**Routes are declared on properties, not on methods.** Handlers are written as
arrow-function properties (`public getAll = async (req, res, next) => {}`), which
binds `this` without a `.bind()` call — necessary because Express invokes the
handler detached from its object. A property decorator receives the prototype and
the name, which is all the registry needs; the handler itself is read from the
instance later.

**Order is decided by specificity, not by source position.** Routes mount from most
concrete to most generic: `/users/stats` beats `/users/:id` even when declared
after it. Ties keep declaration order.

The earlier rule was "source order wins", and it worked right up until it didn't:
moving a method could make a static route unreachable, and the symptom was a
confusing `400 invalid id` rather than a clear error. Specificity ordering removes
that failure mode entirely, and it is also what lets a base class declare `/:id`
without shadowing whatever a subclass adds — which is precisely what
[`@Crud()`](crud.md) relies on.

What *is* a mistake is caught at startup: two routes with the same verb and path
throw, instead of the second one being silently dead.

---

## Why the document comes from the schema

In the template this was extracted from, the `@openapi` comment block in a route
file was between **71% and 77%** of its lines, restating by hand what the Zod
validator already said. Nothing forced them to agree; the moment one changed, the
other lied silently.

Now `parameters` and `requestBody` are generated with `z.toJSONSchema()` over the
very same schema that validates the request. If the validator says `limit` tops out
at 100, that is what the documentation says, because it is literally the same
object.

Three technical decisions behind that:

- **Generation runs in `input` mode.** The documentation describes what the client
  sends, not what the validator returns after its `.transform()` calls. It is also
  the only mode that works with transforming schemas — several query schemas
  convert a URL string to a number — since output mode fails outright with
  `Transforms cannot be represented in JSON Schema`.
- **The document is OpenAPI 3.1, not 3.0.** The 3.1 schema object *is* JSON Schema
  2020-12, which is exactly what Zod emits. Targeting 3.0 would mean translating
  every schema into its differences (`nullable`, boolean `exclusiveMinimum`, …) —
  the class of code this design exists to delete. Both Swagger UI and Scalar
  support 3.1.
- **The 401 is not written on each route.** The guard adds it, so the generator
  adds it too, on every route that is not marked `public`.

---

## DTOs are declared once as well

```ts
export const userDto = defineDto("User", z.object({
  pkUser: z.number().int(),
  name: z.string(),
  email: z.email(),
}));

export type UserDto = z.infer<typeof userDto>;

export const paginatedUsersDto = definePagedDto("PaginatedUsers", userDto);
```

`defineDto` publishes the OpenAPI component and `z.infer` gives the TypeScript
type. Previously this was an interface plus an `@openapi` block restating it in
YAML, with nothing keeping the two in step.

`definePagedDto` wraps a DTO in the standard paginated response, referencing the
item schema rather than inlining it.

**The one gotcha:** a DTO registers when its module is **loaded**, and the rest of
the code imports DTOs as *types*, which TypeScript erases at compile time. That is
why generated projects have a `dtos/index.ts` barrel and why the document builder
imports it. A DTO missing from the barrel is missing from the documentation, and
the failure is silent.

---

## Adding a module

1. Decorate the controller with `@ApiController("/whatever", { tag, token })` and
   each handler with its verb.
2. Declare its DTOs with `defineDto` and add them to the barrel.
3. Add one `import` line where controllers are collected — that is what runs the
   decorators and puts the class in the registry.

Nothing else: no route file, no documentation file, no module table.

---

## What this does not solve

The controller still has a `try/catch` and a `Number(req.params.id)` in every
handler, and in a module without rules the service is still a pass-through to the
repository. That is a different kind of repetition, and it is attacked by a generic
CRUD layer on top of the generic repository — see [crud.md](crud.md) — not by more
decorators.
