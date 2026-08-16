/**
 * The router builder mounted for real: an Express application, actual requests
 * over a socket, and the chain in the order production uses it.
 *
 *   JWT guard -> validation -> the route's own middleware -> handler
 *
 * Testing it at handler level would miss the half that matters here, which is
 * precisely that the pieces are wired in that order and that Express resolves
 * the paths the way the metadata says it should.
 */
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
  ApiController,
  Delete,
  Get,
  Post,
  errorHandler,
  registerController,
  registerControllers,
} from "@monolite/http";
import { serve, type ServedApp } from "../support/http-client.js";

const bodySchema = z.object({ name: z.string().min(1).max(10) });
const querySchema = z.object({ page: z.string().optional() });

@ApiController("/things", { tag: "Things" })
class ThingsController {
  @Get("/", { summary: "List", query: querySchema, responses: { 200: "A page" } })
  public list = (_req: Request, res: Response) => res.json({ ok: "list" });

  @Get("/open", { summary: "No token needed", public: true })
  public open = (_req: Request, res: Response) => res.json({ ok: "open" });

  @Get("/:id", { summary: "One", params: { id: "integer" } })
  public byId = (req: Request, res: Response) => res.json({ id: req.params.id });

  @Post("/", { summary: "Create", body: bodySchema, responses: { 201: "Created" } })
  public create = (req: Request, res: Response) => res.status(201).json(req.body);

  @Delete("/:id", { summary: "Remove", params: { id: "integer" }, responses: { 204: "Gone" } })
  public remove = (_req: Request, res: Response) => res.status(204).send();
}

/** A fake guard: it turns anyone away unless the header is there. */
const guard: RequestHandler = (req, res, next) => {
  if (req.headers.authorization) {
    next();
    return;
  }
  res.status(401).json({ status: "error" });
};

const buildApp = (mount: (router: express.Router) => void): Express => {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  mount(router);
  app.use("/api", router);
  app.use(errorHandler());

  return app;
};

describe("registerController", () => {
  let served: ServedApp;

  beforeAll(async () => {
    served = await serve(
      buildApp((router) => registerController(router, ThingsController, new ThingsController(), guard))
    );
  });

  afterAll(() => served.close());

  const authed = (path: string) =>
    served.client.get(path, { headers: { authorization: "Bearer x" } });

  it("mounts every verb on its path, under the controller's prefix", async () => {
    expect((await authed("/api/things")).body).toEqual({ ok: "list" });
    expect((await authed("/api/things/7")).body).toEqual({ id: "7" });
    expect(
      (await served.client.del("/api/things/7", { headers: { authorization: "x" } })).status
    ).toBe(204);
  });

  it("demands a token by default", async () => {
    expect((await served.client.get("/api/things")).status).toBe(401);
  });

  it("lets a route marked public through", async () => {
    const res = await served.client.get("/api/things/open");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: "open" });
  });

  it("validates the body with the very schema that documents the route", async () => {
    const rejected = await served.client.post("/api/things", {
      headers: { authorization: "x" },
      body: { name: "" },
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("VALIDATION_ERROR");

    const accepted = await served.client.post("/api/things", {
      headers: { authorization: "x" },
      body: { name: "ok" },
    });

    expect(accepted.status).toBe(201);
  });

  it("validates after the guard and before the handler", async () => {
    // No token *and* an invalid body: the 401 wins. Whoever is not
    // authenticated is not told which fields the endpoint expects.
    const res = await served.client.post("/api/things", { body: { name: "" } });

    expect(res.status).toBe(401);
  });

  it("explains the failure when the class is not decorated", () => {
    class Undecorated {}

    expect(() =>
      registerController(express.Router(), Undecorated, new Undecorated(), guard)
    ).toThrow(/is not decorated with @ApiController/);
  });

  it("explains the failure when the instance has no such handler", () => {
    // The decorator named a property the servant does not have — a rename that
    // only touched one of the two halves.
    expect(() => registerController(express.Router(), ThingsController, {}, guard)).toThrow(
      /ThingsController\.list is decorated as GET \/ but it is not a function/
    );
  });
});

describe("per-route middleware", () => {
  it("runs between the validation and the handler, and can be resolved from the instance", async () => {
    const order: string[] = [];

    const trace =
      (label: string): RequestHandler =>
      (_req, _res, next) => {
        order.push(label);
        next();
      };

    @ApiController("/traced")
    class TracedController {
      /** Asked for through a function: the decorator runs before any instance exists. */
      public readonly extra: RequestHandler[] = [trace("own-middleware")];

      @Get("/", {
        public: true,
        query: z.object({ page: z.string().optional() }).transform((value) => {
          order.push("validation");
          return value;
        }),
        use: (controller) => (controller as TracedController).extra,
      })
      public list = (_req: Request, res: Response) => {
        order.push("handler");
        res.json({ ok: true });
      };
    }

    const served = await serve(
      buildApp((router) => registerController(router, TracedController, new TracedController(), guard))
    );

    try {
      expect((await served.client.get("/api/traced")).status).toBe(200);
      expect(order).toEqual(["validation", "own-middleware", "handler"]);
    } finally {
      await served.close();
    }
  });

  it("accepts a plain array of middleware too", async () => {
    const seen = jest.fn<void, []>();

    @ApiController("/plain")
    class PlainController {
      @Get("/", {
        public: true,
        use: [
          (_req, _res, next) => {
            seen();
            next();
          },
        ],
      })
      public list = (_req: Request, res: Response) => res.json({ ok: true });
    }

    const served = await serve(
      buildApp((router) => registerController(router, PlainController, new PlainController(), guard))
    );

    try {
      await served.client.get("/api/plain");
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      await served.close();
    }
  });
});

describe("route order", () => {
  /**
   * `/:id` is declared **before** `/stats`, the opposite of how it would have to
   * be written if the order were the order of the code. Specificity ordering
   * makes that irrelevant: the static route wins.
   */
  @ApiController("/order", { tag: "Order" })
  class OutOfOrderController {
    @Get("/:id", { public: true })
    public byId = (req: Request, res: Response) => res.json({ who: "byId", id: req.params.id });

    @Get("/stats", { public: true })
    public stats = (_req: Request, res: Response) => res.json({ who: "stats" });

    @Get("/:id/hard", { public: true })
    public hard = (_req: Request, res: Response) => res.json({ who: "hard" });
  }

  let served: ServedApp;

  beforeAll(async () => {
    served = await serve(
      buildApp((router) =>
        registerController(router, OutOfOrderController, new OutOfOrderController(), guard)
      )
    );
  });

  afterAll(() => served.close());

  it("mounts a static route before a parametric one declared earlier", async () => {
    // Without the ordering, "stats" would be read as an id and this would come
    // back as { who: "byId", id: "stats" } — a 400 "invalid id" in any real
    // controller, with nothing pointing at the declaration order as the cause.
    expect((await served.client.get("/api/order/stats")).body).toEqual({ who: "stats" });
  });

  it("keeps the parametric route working for everything else", async () => {
    expect((await served.client.get("/api/order/7")).body).toEqual({ who: "byId", id: "7" });
  });

  it("does not let longer routes compete with shorter ones", async () => {
    expect((await served.client.get("/api/order/7/hard")).body).toEqual({ who: "hard" });
  });

  it("refuses two identical routes at registration instead of ignoring the second", () => {
    @ApiController("/dup", { tag: "Dup" })
    class DuplicateController {
      @Get("/:id", { public: true })
      public one = (_req: Request, res: Response) => res.json({});

      @Get("/:id", { public: true })
      public two = (_req: Request, res: Response) => res.json({});
    }

    expect(() =>
      registerController(express.Router(), DuplicateController, new DuplicateController(), guard)
    ).toThrow(/declares GET \/dup\/:id twice/);
  });
});

describe("registerControllers", () => {
  it("mounts every controller of the list on the same router", async () => {
    @ApiController("/alpha")
    class AlphaController {
      @Get("/", { public: true })
      public list = (_req: Request, res: Response) => res.json({ who: "alpha" });
    }

    @ApiController("/beta")
    class BetaController {
      @Get("/", { public: true })
      public list = (_req: Request, res: Response) => res.json({ who: "beta" });
    }

    const served = await serve(
      buildApp((router) =>
        registerControllers(
          router,
          [
            { type: AlphaController, instance: new AlphaController() },
            { type: BetaController, instance: new BetaController() },
          ],
          guard
        )
      )
    );

    try {
      expect((await served.client.get("/api/alpha")).body).toEqual({ who: "alpha" });
      expect((await served.client.get("/api/beta")).body).toEqual({ who: "beta" });
    } finally {
      await served.close();
    }
  });

  /**
   * The class supplies the routes and the instance supplies the answers, so a
   * test — or a container resolving by interface — can hand over a double
   * without the routing changing at all.
   */
  it("mounts the class's routes against whatever instance is handed over", async () => {
    const double = { list: (_req: Request, res: Response) => res.json({ who: "double" }) };

    @ApiController("/swapped")
    class SwappedController {
      @Get("/", { public: true })
      public list = (_req: Request, res: Response) => res.json({ who: "real" });
    }

    const served = await serve(
      buildApp((router) =>
        registerControllers(router, [{ type: SwappedController, instance: double }], guard)
      )
    );

    try {
      expect((await served.client.get("/api/swapped")).body).toEqual({ who: "double" });
    } finally {
      await served.close();
    }
  });
});
