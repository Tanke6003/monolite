# Monolite

A TypeScript backend toolkit you can adopt one package at a time.

> 🇪🇸 [Leer en español](./README.es.md) · 📚 [Documentation index](./docs/)

---

Monolite is not a framework that owns your `main.ts`. It is a set of small packages
that solve the parts of a backend most templates leave to you: one repository
contract that works across six database engines, HTTP routing that produces its own
OpenAPI document, generic CRUD you opt into per entity, and a CLI that wires the
choice together.

Every package works on its own. Install the one you need and ignore the rest.

## Packages

| Package | What it is | Depends on |
| --- | --- | --- |
| [`monolite-core`](./packages/core) | Errors, logger and request-context contracts, `AsyncLocalStorage` request identity, health probe. Zero dependencies. | — |
| [`monolite-data`](./packages/data) | One `IGenericRepository<T>` over in-memory, Oracle, SQL Server, PostgreSQL, MySQL and MongoDB. Unit of work, SQL dialects, filter compilers. | `core` |
| [`monolite-http`](./packages/http) | `@ApiController` / `@Get` / `@Post` decorators, router builder, Zod validation, error handler, security defaults, OpenAPI 3.1 generation. | `core` |
| [`monolite-crud`](./packages/crud) | Generic `CrudService` / `CrudController` and a `@Crud()` decorator: five endpoints per entity, each one overridable. Ambient transactions via `@Transactional()`. | `core`, `data`, `http` |
| [`monolite-auth`](./packages/auth) | Optional authentication: login, JWT issuing and verification, password hashing, `requireAuth` / `requireRoles` guards. | `core`, `http` |
| [`monolite-di`](./packages/di) | The tsyringe composition root, kept separate so nothing else depends on a container. | `core`, `data` |
| [`monolite-cli`](./packages/cli) | `monolite new` — scaffolds a project and asks which database you want. | — |

## Quick start

```bash
npm install -g monolite-cli
monolite new my-api
```

The CLI asks for the project name and version, whether you want SQL, NoSQL or no
database at all, which engine within that family, whether to include
authentication, and whether to generate an example module. It writes a project
that builds and whose test suite passes on the first run.

Non-interactive, for CI:

```bash
monolite new my-api --database=postgres --auth --example --yes
```

## Or use the packages directly

An existing Express application can adopt a single package. This is the whole of a
CRUD module once `monolite-crud` is in place:

```ts
import { Crud } from "monolite-crud";
import { ApiController } from "monolite-http";

@ApiController("/branches", { tag: "Branches", token: BRANCH_TOKENS.controller })
@Crud({ resource: "branch", dto: "Branch", schemas: branchSchemas })
export class BranchesController extends CrudController {
  constructor(service: BranchesService, context: IRequestContext) {
    super(service, context, "branch");
  }
}
```

Five endpoints — list, get one, create, update, soft delete — with validation,
pagination, error mapping and an OpenAPI entry each. Override any one of them by
declaring a method with the same name; the decorator only fills the gaps.

## Why this exists

Most backend templates make one database decision for you and bury it in three
hundred files. Monolite's `monolite-data` puts every engine behind the same
contract and every engine-specific difference behind a `SqlDialect`, so switching
from Oracle to PostgreSQL is a configuration change plus one dialect object, not a
rewrite. The same idea drives the rest: the OpenAPI document is generated from the
routing metadata rather than maintained beside it, and transactions are ambient
rather than threaded through every method signature.

Read [the architecture guide](./docs/en/architecture.md) for the reasoning behind
each of those decisions, including the trade-offs they cost.

## Documentation

- [Getting started](./docs/en/getting-started.md)
- [Architecture](./docs/en/architecture.md)
- [Data access](./docs/en/data-access.md)
- [Decorated routes and OpenAPI](./docs/en/routing.md)
- [Generic CRUD](./docs/en/crud.md)
- [Authentication](./docs/en/authentication.md)
- [CLI reference](./docs/en/cli.md)
- [Testing](./docs/en/testing.md)

## Development

```bash
npm install
npm run build      # tsc --build across every package
npm run typecheck
npm run lint
npm test
npm run check      # all of the above
```

The repository is an npm workspace. Packages reference each other through
TypeScript project references, so `tsc --build` rebuilds only what changed.

## Status

`0.1.0`. The packages were extracted from a working production-shaped template and
carry its test suite, but the public API is not frozen yet. Pin exact versions.

## License

MIT © 2026 Tanke6003
