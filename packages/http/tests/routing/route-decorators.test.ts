/**
 * The route registry: what the decorators actually put in it, and the two rules
 * that turn that metadata into something mountable — specificity ordering and
 * the refusal to register the same route twice.
 *
 * This is the package's central claim: the route, its validation and its
 * documentation are declared once, in one place, and everything else is derived
 * from that single declaration. If the registry is wrong, the router and the
 * OpenAPI document are wrong together and in the same way, which is exactly the
 * failure that is hardest to notice.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import {
  ApiController,
  Delete,
  Get,
  Patch,
  Post,
  Put,
  bySpecificity,
  getControllerMetadata,
  joinPath,
  registeredControllers,
  sortedRoutes,
  type RouteMetadata,
} from "monolite-http";

const querySchema = z.object({ page: z.string().optional() });
const bodySchema = z.object({ name: z.string().min(1) });

@ApiController("/things", { tag: "Things", token: "IThingsController" })
class ThingsController {
  @Get("/", { summary: "List", query: querySchema })
  public list = (_req: Request, res: Response) => res.json({ ok: "list" });

  @Get("/stats", { summary: "Stats", public: true })
  public stats = (_req: Request, res: Response) => res.json({ ok: "stats" });

  @Get("/:id", { summary: "One", params: { id: "integer" } })
  public byId = (_req: Request, res: Response) => res.json({ ok: "byId" });

  @Post("/", { summary: "Create", body: bodySchema })
  public create = (_req: Request, res: Response) => res.status(201).json({});

  @Put("/:id", { summary: "Replace" })
  public replace = (_req: Request, res: Response) => res.json({});

  @Patch("/:id", { summary: "Amend" })
  public amend = (_req: Request, res: Response) => res.json({});

  @Delete("/:id", { summary: "Remove" })
  public remove = (_req: Request, res: Response) => res.status(204).send();
}

/** No `@ApiController`: only the verb decorators ran on it. */
class UndecoratedClass {
  @Get("/orphan")
  public orphan = (_req: Request, res: Response) => res.json({});
}

class NotAControllerAtAll {}

describe("@ApiController", () => {
  it("records the prefix, the tag and the token of the class", () => {
    expect(getControllerMetadata(ThingsController)).toMatchObject({
      prefix: "/things",
      tag: "Things",
      token: "IThingsController",
    });
  });

  it("returns null for a class that was never decorated at all", () => {
    expect(getControllerMetadata(NotAControllerAtAll)).toBeNull();
  });

  /**
   * Method decorators run while the class body is evaluated and the class
   * decorator only afterwards, so by the time `@ApiController` arrives the
   * routes are already there. That is why it fills the prefix in rather than
   * creating the entry — and why a class that forgot it still has its routes
   * registered, under an empty prefix.
   */
  it("leaves the routes of a class that forgot it registered under an empty prefix", () => {
    expect(getControllerMetadata(UndecoratedClass)).toMatchObject({
      prefix: "",
      routes: [{ method: "get", path: "/orphan", handler: "orphan" }],
    });
  });

  it("keys the registry by constructor, so two controllers of the same name coexist", () => {
    // Two modules may each declare a `UsersController`. Indexing by name would
    // have the second silently overwrite the first, and one whole module would
    // vanish from the API with nothing to explain it.
    const makeOne = (prefix: string) => {
      @ApiController(prefix)
      class UsersController {
        @Get("/")
        public list = (_req: Request, res: Response) => res.json({});
      }
      return UsersController;
    };

    const first = makeOne("/a");
    const second = makeOne("/b");

    expect(getControllerMetadata(first)).toMatchObject({ prefix: "/a" });
    expect(getControllerMetadata(second)).toMatchObject({ prefix: "/b" });
  });

  it("lists every decorated controller, which is what the generator walks", () => {
    const types = registeredControllers().map(([type]) => type);

    expect(types).toContain(ThingsController);
    expect(types).toContain(UndecoratedClass);
    expect(types).not.toContain(NotAControllerAtAll);
  });
});

describe("verb decorators", () => {
  const routeFor = (handler: string): RouteMetadata =>
    getControllerMetadata(ThingsController)!.routes.find((route) => route.handler === handler)!;

  /**
   * They decorate properties, not prototype methods, because handlers are
   * declared as arrow functions — which is how `this` stays bound without a
   * `.bind()` at every call site.
   */
  it("registers an arrow-function property under its own name", () => {
    expect(routeFor("list")).toMatchObject({ method: "get", path: "/", handler: "list" });
  });

  it("covers the five verbs", () => {
    const declared = getControllerMetadata(ThingsController)!.routes.map(
      (route) => `${route.method.toUpperCase()} ${route.path}`
    );

    expect(declared).toEqual(
      expect.arrayContaining([
        "GET /",
        "POST /",
        "PUT /:id",
        "PATCH /:id",
        "DELETE /:id",
      ])
    );
  });

  it("carries the options through untouched, schemas included", () => {
    // The same Zod object, not a copy: the schema that validates is the schema
    // that documents, and they cannot drift because there is only one of them.
    expect(routeFor("list").query).toBe(querySchema);
    expect(routeFor("create").body).toBe(bodySchema);
    expect(routeFor("byId").params).toEqual({ id: "integer" });
    expect(routeFor("stats").public).toBe(true);
  });

  it("leaves `public` unset by default, so a route is closed unless it opts out", () => {
    // If forgetting something has to have a consequence, let it be a route that
    // is shut rather than one that is open.
    expect(routeFor("list").public).toBeUndefined();
  });
});

describe("joinPath", () => {
  it("leaves no trailing slash when the route is the controller's root", () => {
    // Express treats `/things` and `/things/` as the same path, but in the
    // OpenAPI document they would be two separate entries.
    expect(joinPath("/things", "/")).toBe("/things");
    expect(joinPath("/things", "")).toBe("/things");
  });

  it("concatenates everything else", () => {
    expect(joinPath("/things", "/:id")).toBe("/things/:id");
    expect(joinPath("/things", "/:id/hard")).toBe("/things/:id/hard");
  });
});

describe("bySpecificity", () => {
  const route = (path: string): RouteMetadata => ({ method: "get", path, handler: "x" });

  it("puts a static segment before a parametric one", () => {
    expect(bySpecificity(route("/stats"), route("/:id"))).toBeLessThan(0);
    expect(bySpecificity(route("/:id"), route("/stats"))).toBeGreaterThan(0);
  });

  it("compares segment by segment, so depth does not decide", () => {
    expect(bySpecificity(route("/:id/hard"), route("/stats"))).toBeGreaterThan(0);
    expect(bySpecificity(route("/a/:id"), route("/a/b"))).toBeGreaterThan(0);
  });

  it("treats two equally concrete paths as a tie", () => {
    expect(bySpecificity(route("/a"), route("/b"))).toBe(0);
    expect(bySpecificity(route("/:a"), route("/:b"))).toBe(0);
  });

  it("puts a catch-all last of all, behind even a parameter", () => {
    // A wildcard matches whatever is left, so anything it precedes is
    // unreachable.
    expect(bySpecificity(route("/:id"), route("/*rest"))).toBeLessThan(0);
    expect(bySpecificity(route("/files"), route("/{anything}"))).toBeLessThan(0);
  });
});

describe("sortedRoutes", () => {
  it("orders from most concrete to most generic, whatever the declaration order", () => {
    // `/:id` is declared *first* here. Express keeps the first route that
    // matches, so left in that order "stats" would be read as an id and the
    // static route would be unreachable — a 400 "invalid id" instead of
    // anything that names the real problem.
    @ApiController("/reversed")
    class ReversedController {
      @Get("/:id")
      public byId = (_req: Request, res: Response) => res.json({});

      @Get("/stats")
      public stats = (_req: Request, res: Response) => res.json({});
    }

    expect(
      sortedRoutes(getControllerMetadata(ReversedController)!, "ReversedController").map(
        (route) => route.path
      )
    ).toEqual(["/stats", "/:id"]);
  });

  it("keeps declaration order among ties, because the sort is stable", () => {
    @ApiController("/ties")
    class TiesController {
      @Get("/alpha")
      public alpha = (_req: Request, res: Response) => res.json({});

      @Get("/beta")
      public beta = (_req: Request, res: Response) => res.json({});
    }

    expect(
      sortedRoutes(getControllerMetadata(TiesController)!, "TiesController").map((r) => r.handler)
    ).toEqual(["alpha", "beta"]);
  });

  it("does not mutate the metadata it sorts", () => {
    const metadata = getControllerMetadata(ThingsController)!;
    const before = metadata.routes.map((route) => route.handler);

    sortedRoutes(metadata, "ThingsController");

    expect(metadata.routes.map((route) => route.handler)).toEqual(before);
  });

  it("accepts the same path under different verbs", () => {
    // `GET /` and `POST /` are two operations, not a duplicate.
    expect(() =>
      sortedRoutes(getControllerMetadata(ThingsController)!, "ThingsController")
    ).not.toThrow();
  });

  it("rejects the same verb and path twice, naming the route", () => {
    // Express would keep the first and never run the second, silently. Here it
    // is a failure at startup instead of a handler that mysteriously never
    // fires.
    @ApiController("/dup")
    class DuplicateController {
      @Get("/:id", { public: true })
      public one = (_req: Request, res: Response) => res.json({});

      @Get("/:id", { public: true })
      public two = (_req: Request, res: Response) => res.json({});
    }

    expect(() =>
      sortedRoutes(getControllerMetadata(DuplicateController)!, "DuplicateController")
    ).toThrow(/declares GET \/dup\/:id twice/);
  });

  it("compares the full path, so the same route path under different prefixes is fine", () => {
    @ApiController("/other")
    class OtherController {
      @Get("/:id", { public: true })
      public one = (_req: Request, res: Response) => res.json({});
    }

    expect(() =>
      sortedRoutes(getControllerMetadata(OtherController)!, "OtherController")
    ).not.toThrow();
  });
});

/**
 * `controllersFromRegistry` walks the *whole* registry, so it is exercised in
 * an isolated module instance: otherwise every controller this file declares
 * would take part, and the assertions would depend on what the rest of the
 * suite happened to define.
 */
describe("controllersFromRegistry", () => {
  it("asks `resolve` who serves each controller and pairs it with its class", async () => {
    await jest.isolateModulesAsync(async () => {
      const http = (await import("monolite-http")) as typeof import("monolite-http");

      @http.ApiController("/users", { token: "IUsersController" })
      class UsersController {
        @http.Get("/")
        public list = (_req: Request, res: Response) => res.json({});
      }

      const servant = { list: jest.fn() };
      const resolve = jest.fn(() => servant);

      // Importing the controller is what registers it; there is no second list
      // of modules to keep in step with this one.
      expect(http.controllersFromRegistry(resolve)).toEqual([
        { type: UsersController, instance: servant },
      ]);
      expect(resolve).toHaveBeenCalledWith("IUsersController");
    });
  });

  it("fails loudly for a controller that declares no token", async () => {
    await jest.isolateModulesAsync(async () => {
      const http = (await import("monolite-http")) as typeof import("monolite-http");

      // Skipping it silently would surface much later as a 404 nobody can
      // explain: the controller exists, it is decorated, and it answers nothing.
      @http.ApiController("/orphans")
      class OrphanController {
        @http.Get("/")
        public list = (_req: Request, res: Response) => res.json({});
      }
      void OrphanController;

      expect(() => http.controllersFromRegistry(() => ({}))).toThrow(
        /OrphanController.*declares no `token`/s
      );
    });
  });
});
