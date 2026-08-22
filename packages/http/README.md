# monolite-http

The decorator-driven Express layer of the monolite toolkit. A controller
declares its own routes — which verb it serves, on which path, what it validates
and what it answers — and that single declaration produces both the routing and
the OpenAPI document.

Requires Node 20 or newer and Express 5 (a peer dependency, so the application
picks the exact version).

## The idea

The point is not saving the `app.get(...)` calls; that is thirty lines per
module. The point is that **the route, the validation and the documentation stop
being written three times.**

In a hand-documented route file, between 71 % and 77 % of the lines were the
`@openapi` block: a Zod schema said `limit` is an integer between 1 and 100, a
YAML comment repeated it, and nothing forced the two to agree. As soon as one
changed, the other lied. Here only the schema exists — the router validates with
it and the generator documents from it, so they cannot drift.

Comment-based generation also had a failure mode this design removes entirely:
`swagger-jsdoc` read the annotations from `./src/**/*.ts`, which does not exist
in a production container, and `removeComments: true` stripped them from the
compiled output. The documentation was correct in development and empty in
production. Metadata registered at class-load time survives compilation.

## The decorator model

| Decorator | What it declares |
| --- | --- |
| `@ApiController(prefix, { tag, token })` | Marks the class as an HTTP controller, gives it a path prefix, the OpenAPI tag its operations are grouped under, and the DI token that resolves whoever serves it. |
| `@Get` `@Post` `@Put` `@Patch` `@Delete` | The verb, the path, and everything the route promises: `summary`, `description`, `body`, `query`, `params`, `responses`, `public`, `use`. |

Three defaults are worth knowing, because they are what makes the metadata
trustworthy rather than decorative:

- **Every route is authenticated unless it says `public: true`.** If opening a
  route is an oversight, let the oversight be closing it and not the other way
  round. The guard itself arrives as a parameter, so a test can mount the router
  with a double.
- **Routes are mounted from most concrete to most generic**, comparing segment by
  segment. Express keeps the first route that matches, so `/:id` declared before
  `/stats` swallows `"stats"` and treats it as an id; the symptom used to be a
  400 "invalid id" instead of a clear error. Declaration order no longer matters.
- **Two routes with the same verb and path fail at startup.** Express would keep
  the first and never run the second, silently.

The verb decorators decorate *properties*, not prototype methods, because
handlers are declared as arrow functions — that is how `this` stays bound
without a `.bind()`.

## A controller

```ts
import { ApiController, BaseController, Get, Post, defineDto, definePagedDto, parseId } from "monolite-http";
import type { IRequestContext } from "monolite-core";
import { z } from "zod";

const userDto = defineDto(
  "User",
  z.object({ id: z.int(), name: z.string(), email: z.email() })
);
definePagedDto("PaginatedUsers", userDto);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createUser = z.object({
  name: z.string().min(1).max(120),
  email: z.email(),
});

@ApiController("/users", { tag: "Users", token: "IUsersController" })
export class UsersController extends BaseController {
  constructor(context: IRequestContext, private readonly users: IUsersBLL) {
    super(context);
  }

  @Get("/", {
    summary: "Lists users",
    query: listQuery,
    responses: { 200: { description: "Page of users", ref: "PaginatedUsers" } },
  })
  list = async (req: Request, res: Response) => {
    // `validateQuery` already parsed and coerced it; the concrete type is
    // asserted here because each route uses a different schema.
    const query = req.validatedQuery as z.infer<typeof listQuery>;
    res.json(await this.users.list(query));
  };

  @Get("/:id", {
    summary: "Gets one user",
    params: { id: "integer" },
    responses: { 200: { description: "The user", ref: "User" }, 404: "Not found" },
  })
  getOne = async (req: Request, res: Response) => {
    // Express 5 allows a path parameter to repeat, so its declared type is
    // `string | string[]`; a repeated `:id` is not an id.
    const raw = typeof req.params.id === "string" ? req.params.id : undefined;
    res.json(await this.users.getOne(parseId(raw, "user")));
  };

  @Post("/", {
    summary: "Creates a user",
    body: createUser,
    responses: { 201: { description: "Created", ref: "User" } },
  })
  create = async (req: Request, res: Response) => {
    // The body arrived through the schema, so it is already the parsed shape.
    res.status(201).json(await this.users.create(req.body, this.requireUserId()));
  };
}
```

`BaseController` publishes the identity of the request — `currentUser`,
`userId`, `userName`, `userEmail`, `userRoles`, `requestId`, and a
`requireUserId()` that fails with a 401 rather than carrying on with `null`. It
is the equivalent of `BaseApiController` in .NET; the difference is where the
claims come from: there `HttpContext.User`, here the ambient request context
opened by the middleware and filled in by the auth guard.

## The chain each route gets

`registerController` is the only place that translates metadata into Express, so
the order is decided once and holds for every module:

```
JWT guard  ->  body/query validation  ->  the route's own `use`  ->  handler
```

Validation goes *after* the guard on purpose: whoever is not authenticated is
not told which fields the endpoint expects.

Validation failures never reach the handler — they become an `AppError` with
code `VALIDATION_ERROR` and travel through the global error handler, so a bad
field answers with the same envelope (code, request id, timestamp) as every
other failure in the API.

## OpenAPI from the same metadata

`buildOpenApiDocument()` walks the very registry the router mounts from, so the
document cannot describe a route that does not exist or miss one that does.

```ts
import { buildOpenApiDocument } from "monolite-http";

const spec = buildOpenApiDocument({
  title: "Appointments API",
  version: "1.4.0",
  description: "REST API on Node.js, Express 5 and TypeScript",
  apiPrefix: "/api/v1",
});
```

What it assembles:

- **`paths`** from the route metadata. `/users/:id` becomes `/users/{id}`, the
  query schema becomes one parameter per property, and the handler name becomes
  the `operationId` — which is what client generators use to name the method.
- **Schemas** from Zod. Request bodies are generated in `input` mode, because
  the documentation describes what the client *sends*, not what the validator
  returns after its transformations; it is also the only mode that can represent
  a `.transform()`, which is how a query string becomes a number. DTOs are
  generated in `output` mode, because a DTO describes what the API *returns*.
- **`components.schemas`** from the DTO registry. `defineDto(id, schema)`
  publishes a schema as a component and returns it unchanged, so it is used
  inline in the declaration and `z.infer` still gives the TypeScript type.
  Zod resolves references between registered DTOs on its own, so a DTO inside a
  DTO comes out as a `$ref` instead of being copied.
- **The things that are always true**, added once instead of on every route: a
  401 on any route that goes through the guard, and the shared `ErrorResponse`
  envelope on every 4xx and 5xx that does not describe its own body.

The document is OpenAPI **3.1** and not 3.0 because 3.1's schema *is* JSON
Schema 2020-12, which is exactly what Zod emits. With 3.0 every generated schema
would need translating into its differences (`nullable`, boolean
`exclusiveMinimum`…) — precisely the kind of code this replaces.

## Standing up an application

`createApp` applies the middleware chain in the order the pieces assume, mounts
the controllers and returns a server you can start and stop.

```ts
import { createApp, controllersFromRegistry } from "monolite-http";
import { AsyncRequestContext, HealthProbe } from "monolite-core";

// Importing a controller is what runs its decorators and registers it. That one
// line per module is the only list left.
import "./controllers/users.controller.js";

const { app, listen, close } = await createApp({
  logger,
  context: new AsyncRequestContext(),
  guard: jwt.middleware,
  controllers: controllersFromRegistry((token) => container.resolve(token)),
  healthProbe: new HealthProbe({ dataSource: "postgres", connection }),
  staticDir: "public",
  afterRoutes: (app) => mountDocs(app, spec),
});

await listen(3000);

process.on("SIGTERM", async () => {
  probe.beginShutdown();
  await close();
});
```

The order of the chain is half the work, since each piece assumes the previous
ones already ran:

1. `x-powered-by` disabled — naming the framework only helps whoever is looking
   for a known vulnerability.
2. `trust proxy` set to a **number** of hops, never `true`: with `true` Express
   believes any `X-Forwarded-For`, and the rate limiter then counts against an
   IP the client picks.
3. **Request context**, before even the body parser, so a malformed JSON is
   still rejected with a request id and every later layer sees the context.
4. **helmet**, before anything that answers, so the headers accompany a 429 or a
   CORS rejection too.
5. **Rate limiter**, before the parsing: a request about to be rejected does not
   get its body read, which is the work an abuse is trying to cause. Health
   checks are exempt — a load balancer probing every few seconds would exhaust
   the quota of its own IP and get the instance marked down for being healthy.
6. **CORS**, also before the body: a preflight carries none.
7. **`json` / `urlencoded`**, capped at `BODY_LIMIT` (1 MB by default).
8. **Access log**, one record per finished request, at a level chosen from the
   status so that grepping for errors finds them.
9. **Static files**, when a directory is given.

Then the controllers under `API_PREFIX` (and the unversioned alias), the health
routes, the caller's `afterRoutes` hook, and finally the 404 and the error
handler — registered last because a handler mounted before a route does not
cover it, and the 404 would swallow the documentation.

`close()` does more than `server.close()`: with keep-alive an idle client holds
its connection open and `close()` alone would never settle, so
`closeIdleConnections()` drops exactly the connections with no request in
progress and lets the rest finish.

### Health

Liveness and readiness are two different questions and an orchestrator does
opposite things with each: if the process is not *alive* it restarts it, if it
is not *ready* it takes traffic away. With the database down the right answer is
the second — restarting does not fix someone else's database.

- `GET /health/live` — never touches the database.
- `GET /health/ready` and `GET /health` — 503 with the database down or while
  draining, and they publish the resolved `apiPrefix` so a client can discover
  where the API is mounted instead of assuming it.

## What it exports

The six other packages list theirs; this one did not, and it has the largest
surface of the seven. Grouped by what you would be reaching for.

### Declaring routes

| Export | What it is |
| --- | --- |
| `ApiController`, `Get`, `Post`, `Put`, `Patch`, `Delete` | The decorators. One declaration produces the route, its validation and its slice of the OpenAPI document, so the three cannot disagree. |
| `RouteOptions`, `ResponseSpec`, `RouteMetadata`, `ControllerMetadata`, `HttpMethod`, `PathParamType` | What a decorator accepts and what it records. |
| `BaseController`, `parseId` | The little a hand-written controller shares: the id in the path, parsed and refused if it is not one. |
| `registerControllers`, `registeredControllers`, `getControllerMetadata`, `ControllerType`, `ControllerRegistration` | The registry the router is built from. Exported because a project that mounts its own router needs the same list. |
| `sortedRoutes`, `bySpecificity`, `joinPath` | Mounting order. `/books/featured` has to be tried before `/books/:id`, or the literal path is swallowed by the parameter. |

### The document

| Export | What it is |
| --- | --- |
| `buildOpenApiDocument`, `BuildOpenApiDocumentOptions`, `OpenApiServer` | OpenAPI 3.1 from the same metadata that produced the routes. |
| `buildOpenApiPaths`, `BuildPathsOptions`, `OpenApiPaths` | The paths alone, for a document assembled elsewhere. |
| `defineDto`, `definePagedDto`, `buildDtoComponents` | A Zod schema published as a component, so an operation references it instead of repeating its shape. |
| `missingSchemaRefs` | Every `$ref` in the document that resolves to nothing. The generated `mountDocs` runs it at startup, because a dangling reference still serves a 200 and only the reader notices. |
| `DEFAULT_SECURITY_SCHEMES`, `ERROR_RESPONSE_SCHEMA`, `ERROR_SCHEMA_NAME` | The pieces every document here carries. |
| `DocsReader`, `areDocsEnabled`, `docsCspDirectives`, `SCALAR_CDN_ORIGIN` | Which reader is mounted, and the policy it needs in order not to come out blank. |

### The chain

| Export | What it is |
| --- | --- |
| `createApp`, `CreateAppOptions`, `HttpApp` | The whole middleware chain in the order that makes it work, which is the order this README argues for. |
| `errorHandler`, `notFoundHandler`, `ErrorHandlerOptions` | One place anything thrown becomes a response, and an unknown route answers in the same shape as a known one. |
| `requestContext`, `REQUEST_ID_HEADER`, `toCurrentUser`, `currentUserName`, `TokenClaims` | The request identity, over `AsyncLocalStorage`, so nothing has to thread a user through four layers. |
| `httpLogger`, `HttpLoggerOptions` | One access line per request. |
| `healthRoutes`, `HealthRoutesOptions` | Readiness, liveness, and `/health` as the alias a load balancer configured with the bare path expects. |
| `validateBody`, `validateQuery` | Zod at the boundary, for a route declared by hand. |

### Security and configuration

| Export | What it is |
| --- | --- |
| `buildHelmetOptions`, `DEFAULT_CSP_DIRECTIVES`, `SECURITY_DEFAULTS` | The headers, and the CSP that stays off until `CSP_ENABLED=true` — see the note above about a blank documentation page. |
| `buildCorsOptions`, `resolveAllowedOrigins` | An allow-list rather than a wildcard, answering a blocked origin in the API's own error shape. |
| `buildRateLimiter`, `buildAuthRateLimiter` | Per-IP, with the health checks exempt and the login endpoint on a tighter budget than the rest. |
| `resolveApiPrefix`, `resolveLegacyPrefix`, `DEFAULT_API_PREFIX`, `DEFAULT_LEGACY_PREFIX` | Where the API is mounted, and the older prefix kept alive beside it. |
| `resolveBodyLimit`, `resolveTrustProxy` | The two that are wrong by default in every framework: an unbounded body and a blindly trusted `X-Forwarded-For`. |
| `EnvSource`, `processEnv` | Where all of the above is read from. |

## Configuration

Everything is read through `EnvSource`, a one-method interface (`getEnv(key)`)
so the package never imposes how configuration is loaded. `processEnv` is the
built-in adapter over `process.env`.

| Variable | Default | What it does |
| --- | --- | --- |
| `API_PREFIX` | `/api/v1` | Where the current version is mounted. It identifies the *contract*: pointing it at `/api/v2` does not create a version 2, it renames version 1. |
| `API_LEGACY_PREFIX` | `/api` | Unversioned alias. `off` disables it. |
| `BODY_LIMIT` | `1mb` | Maximum request body. |
| `TRUST_PROXY_HOPS` | `0` | Trusted proxies in front. |
| `CORS_ORIGINS` | *(none)* | Comma-separated allow-list. `*` accepts any origin. Requests with no `Origin` are always accepted — those are curl, Postman or a health probe, and CORS does not protect against them anyway. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `120` | General limiter. `0` disables it. |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX` | `900000` / `10` | Limiter for credential-issuing routes, far narrower: a token is the only thing that opens the rest of the API. |
| `CSP_ENABLED` | `false` | Content-Security-Policy. It ships off because helmet's default policy breaks Swagger UI and Scalar at once, and a freshly cloned project with blank screens is the surest way to get the policy disabled wholesale instead of tuned. Helmet's other dozen headers always apply. |
| `DOCS_ENABLED` | on outside production | Whether the documentation is published. The document describes the whole surface of the API, validation rules included. |

## License

MIT
