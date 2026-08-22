/**
 * `@Crud()` is the whole promise of this package: one line over a class that
 * extends `CrudController` and the resource has its five routes, validated and
 * documented from the same schemas.
 *
 * The claim that matters most is not that it generates routes but that it
 * generates them **without taking the class over**. Nothing here is
 * all-or-nothing: a verb can be dropped and written by hand, and a handler the
 * class declares itself is the one that answers.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { IRequestContext } from "monolite-core";
import {
  ApiController,
  Get,
  getControllerMetadata,
  registerController,
  sortedRoutes,
  type RouteMetadata,
} from "monolite-http";
import { Crud, CrudController, type ICrudBLL } from "monolite-crud";
import { serve } from "./support/http-client.js";

interface ItemDTO {
  id: number;
  name: string;
}

const createSchema = z.object({ name: z.string().min(1) });
const updateSchema = z.object({ name: z.string().min(1).optional() });
const querySchema = z.object({ page: z.coerce.number().int().min(1).optional() });

let service: jest.Mocked<ICrudBLL<ItemDTO>>;

const anonymous = { getCurrentUser: () => null } as unknown as IRequestContext;

@ApiController("/items")
@Crud({
  resource: "item",
  dto: "Item",
  schemas: { create: createSchema, update: updateSchema, query: querySchema },
})
class ItemsController extends CrudController {
  constructor() {
    super(service, anonymous, "item");
  }
}

@ApiController("/partials")
@Crud({ resource: "partial", dto: "Item", verbs: ["list", "getOne"] })
class PartialsController extends CrudController {
  constructor() {
    super(service, anonymous, "partial");
  }
}

const buildApp = (type: new (...args: never[]) => object, instance: object): Express => {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  registerController(router, type, instance, (_req, _res, next) => next());
  app.use(router);

  return app;
};

beforeEach(() => {
  service = {
    list: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, pages: 0 }),
    get: jest.fn().mockResolvedValue({ id: 1, name: "one" }),
    create: jest.fn().mockResolvedValue({ id: 1, name: "one" }),
    update: jest.fn().mockResolvedValue({ id: 1, name: "one" }),
    softDelete: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<ICrudBLL<ItemDTO>>;
});

/** The registered routes as `VERB path -> handler`, in the order they mount. */
const routesOf = (type: object, name: string): string[] =>
  sortedRoutes(getControllerMetadata(type)!, name).map(
    (route) => `${route.method.toUpperCase()} ${route.path} -> ${route.handler}`
  );

const routeFor = (type: object, handler: string): RouteMetadata =>
  getControllerMetadata(type)!.routes.find((route) => route.handler === handler)!;

describe("@Crud", () => {
  it("registers the five routes against the five handlers of the base class", () => {
    expect(routesOf(ItemsController, "ItemsController")).toEqual([
      "GET / -> list",
      "POST / -> create",
      "GET /:id -> getOne",
      "PUT /:id -> update",
      "DELETE /:id -> softDelete",
    ]);
  });

  it("registers them on the concrete class and not on the base", () => {
    // A decorator written on `CrudController` would register itself under the
    // base's name, and the module extending it would expose no routes at all.
    expect(getControllerMetadata(CrudController)).toBeNull();
  });

  it("attaches each schema to the verb that takes it", () => {
    // One schema, two jobs: it validates the request and it describes it. There
    // is no second copy to fall out of step.
    expect(routeFor(ItemsController, "create").body).toBe(createSchema);
    expect(routeFor(ItemsController, "update").body).toBe(updateSchema);
    expect(routeFor(ItemsController, "list").query).toBe(querySchema);
    expect(routeFor(ItemsController, "getOne").body).toBeUndefined();
  });

  it("declares the id as an integer path parameter wherever there is one", () => {
    for (const handler of ["getOne", "update", "softDelete"]) {
      expect(routeFor(ItemsController, handler).params).toEqual({ id: "integer" });
    }
    expect(routeFor(ItemsController, "list").params).toBeUndefined();
  });

  it("points the listing at the paged component and the rest at the item one", () => {
    expect(routeFor(ItemsController, "list").responses?.[200]).toEqual({
      description: "Page of results",
      // The page's component follows the convention unless one is named.
      ref: "PaginatedItem",
    });
    expect(routeFor(ItemsController, "getOne").responses?.[200]).toEqual({
      description: "Found",
      ref: "Item",
    });
  });

  it("accepts a page component that does not follow the convention", () => {
    @ApiController("/oddly-paged")
    @Crud({ resource: "thing", dto: "Thing", paged: "ThingPage" })
    class OddlyPagedController extends CrudController {
      constructor() {
        super(service, anonymous, "thing");
      }
    }

    expect(routeFor(OddlyPagedController, "list").responses?.[200]).toMatchObject({
      ref: "ThingPage",
    });
  });

  it("names the resource in the prose, so the documentation reads as the module's", () => {
    expect(routeFor(ItemsController, "list").summary).toBe("Paginated list: item");
    expect(routeFor(ItemsController, "getOne").responses?.[404]).toBe(
      "No item found with that id"
    );
  });

  it("leaves the routes closed: no verb is marked public", () => {
    for (const route of getControllerMetadata(ItemsController)!.routes) {
      expect(route.public).toBeUndefined();
    }
  });

  describe("verbs", () => {
    it("narrows the set to the ones that were asked for", () => {
      expect(routesOf(PartialsController, "PartialsController")).toEqual([
        "GET / -> list",
        "GET /:id -> getOne",
      ]);
    });

    it("mounts nothing at all for an empty list", () => {
      @ApiController("/nothing")
      @Crud({ resource: "nothing", dto: "Nothing", verbs: [] })
      class NothingController extends CrudController {
        constructor() {
          super(service, anonymous, "nothing");
        }
      }

      expect(getControllerMetadata(NothingController)!.routes).toEqual([]);
    });

    /**
     * Which verbs are open is a per-module decision, and dropping one is how a
     * module keeps it for itself. Declaring it by hand **without** dropping it
     * is a mistake, and it is caught at startup rather than leaving the
     * hand-written route silently unreachable behind the generated one.
     */
    it("collides on purpose when a verb is both generated and declared by hand", () => {
      @ApiController("/clashing")
      @Crud({ resource: "clash", dto: "Clash" })
      class ClashingController extends CrudController {
        constructor() {
          super(service, anonymous, "clash");
        }

        @Get("/:id", { summary: "Mine" })
        public mine = (_req: Request, res: Response) => res.json({});
      }

      expect(() =>
        registerController(
          express.Router(),
          ClashingController,
          new ClashingController(),
          (_req, _res, next) => next()
        )
      ).toThrow(/declares GET \/clashing\/:id twice/);
    });
  });

  /**
   * The important one.
   *
   * The generated route names the verb — `list` — and the router looks that name
   * up **on the instance**, so whatever the instance carries under it is what
   * answers. A module therefore overrides a verb by declaring it, and keeps the
   * route, the validation and the documentation `@Crud` produced for it.
   *
   * The override has to be an instance property, exactly like the base's own
   * handlers: class fields are assigned in construction order, so the
   * subclass's runs after `CrudController`'s and wins. Written as a prototype
   * method it would be the other way round — the base's field would shadow it,
   * and the generic implementation would answer instead.
   */
  describe("a hand-declared method", () => {
    @ApiController("/overridden")
    @Crud({ resource: "overridden", dto: "Item" })
    class OverriddenController extends CrudController {
      constructor() {
        super(service, anonymous, "overridden");
      }

      public override list = async (
        _req: Request,
        res: Response,
        _next: NextFunction
      ): Promise<void> => {
        res.json({ who: "hand written" });
      };
    }

    it("wins over the generated one", async () => {
      const served = await serve(
        buildApp(OverriddenController as never, new OverriddenController())
      );

      try {
        const res = await served.client.get("/overridden");

        expect(res.body).toEqual({ who: "hand written" });
        // The generic implementation is the one that would have called the
        // service; it never ran.
        expect(service.list).not.toHaveBeenCalled();
      } finally {
        await served.close();
      }
    });

    it("keeps the generated route, its schema and its documentation", async () => {
      // Overriding the implementation is not opting out of the declaration:
      // there is still exactly one `GET /overridden`, described by `@Crud`.
      expect(routesOf(OverriddenController, "OverriddenController")).toContain(
        "GET / -> list"
      );
      expect(routeFor(OverriddenController, "list").summary).toBe(
        "Paginated list: overridden"
      );
    });

    it("leaves the verbs it did not touch on the generic implementation", async () => {
      const served = await serve(
        buildApp(OverriddenController as never, new OverriddenController())
      );

      try {
        expect((await served.client.get("/overridden/1")).status).toBe(200);
        expect(service.get).toHaveBeenCalledWith(1);
      } finally {
        await served.close();
      }
    });
  });
});
