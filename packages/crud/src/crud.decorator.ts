import type { ZodType } from "zod";
import { Delete, Get, Post, Put, type RouteOptions } from "@monolite/http";

/** The five verbs `CrudController` implements. */
export type CrudVerb = "list" | "getOne" | "create" | "update" | "softDelete";

const ALL_VERBS: CrudVerb[] = ["list", "getOne", "create", "update", "softDelete"];

export interface CrudOptions {
  /** The resource's name, singular, for the prose: "user". */
  resource: string;
  /** OpenAPI component of a single item. `Paginated<dto>` for the page. */
  dto: string;
  /** Name of the page's component, when it does not follow the convention. */
  paged?: string;
  /** Zod schemas: they validate and they document. */
  schemas?: { create?: ZodType; update?: ZodType; query?: ZodType };
  /** Verbs to expose. All five by default. */
  verbs?: CrudVerb[];
}

/**
 * Mounts the CRUD routes on the class that already extends `CrudController`.
 *
 * It is a class decorator rather than something baked into the base for two
 * reasons. One, practical: a decorator written on the base would register
 * itself under the base's name, and the module extending it would expose no
 * routes at all. The other, by design: which verbs are open is a per-module
 * decision, and here it can be read at a glance.
 *
 * To keep a verb of your own, drop it from `verbs` and declare it by hand with
 * its own decorator. Declaring it **without** dropping it is a mistake, and it
 * fails at startup: the duplicate-route detector reports two routes for the
 * same path.
 */
export function Crud(options: CrudOptions) {
  const { resource, dto, paged = `Paginated${dto}`, schemas = {}, verbs = ALL_VERBS } = options;

  const has = (verb: CrudVerb): boolean => verbs.includes(verb);
  const idParam = { id: "integer" } as const;
  const notFound = `No ${resource} found with that id`;

  return function (target: new (...args: never[]) => object): void {
    // The route decorators are applied as if they had been written on the
    // class; the prototype is what they expect as their `target`.
    const on =
      (route: (path: string, options?: RouteOptions) => PropertyDecorator) =>
      (path: string, routeOptions: RouteOptions, handler: CrudVerb) =>
        route(path, routeOptions)(target.prototype as object, handler);

    if (has("list")) {
      on(Get)(
        "/",
        {
          summary: `Paginated list: ${resource}`,
          ...(schemas.query ? { query: schemas.query } : {}),
          responses: { 200: { description: "Page of results", ref: paged } },
        },
        "list"
      );
    }

    if (has("getOne")) {
      on(Get)(
        "/:id",
        {
          summary: `Get ${resource} by id`,
          params: idParam,
          responses: { 200: { description: "Found", ref: dto }, 404: notFound },
        },
        "getOne"
      );
    }

    if (has("create")) {
      on(Post)(
        "/",
        {
          summary: `Create ${resource}`,
          ...(schemas.create ? { body: schemas.create } : {}),
          responses: {
            201: { description: "Created", ref: dto },
            400: "Validation error",
          },
        },
        "create"
      );
    }

    if (has("update")) {
      on(Put)(
        "/:id",
        {
          summary: `Update ${resource}`,
          params: idParam,
          ...(schemas.update ? { body: schemas.update } : {}),
          responses: { 200: { description: "Updated", ref: dto }, 404: notFound },
        },
        "update"
      );
    }

    if (has("softDelete")) {
      on(Delete)(
        "/:id",
        {
          summary: `Soft delete: ${resource}`,
          params: idParam,
          responses: { 204: "Soft deleted", 404: notFound },
        },
        "softDelete"
      );
    }
  };
}
