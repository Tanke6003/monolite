/**
 * The five CRUD handlers over HTTP, mounted the way production mounts them:
 * routes from `@Crud`, a guard, the validation and the global error handler.
 *
 * Testing them as bare functions would leave out the part that is actually
 * being claimed — that one decorator gives a resource a working REST surface —
 * so they are exercised through a real request.
 */
import express, { type Express } from "express";
import { z } from "zod";
import type { IRequestContext } from "monolite-core";
import { ApiController, errorHandler, registerController } from "monolite-http";
import { Crud, CrudController, type ICrudService } from "monolite-crud";
import { serve, type ServedApp } from "./support/http-client.js";

interface ItemDTO {
  id: number;
  name: string;
}

const bodySchema = z.object({ name: z.string().min(1) });
const querySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Reassigned per test; the controllers read it when they are constructed. */
let service: jest.Mocked<ICrudService<ItemDTO>>;

/** A context that never has anybody in it: these tests are not about identity. */
const anonymous = { getCurrentUser: () => null } as unknown as IRequestContext;

@ApiController("/items", { tag: "Items" })
@Crud({
  resource: "item",
  dto: "Item",
  schemas: { create: bodySchema, update: bodySchema, query: querySchema },
})
class ItemsController extends CrudController {
  constructor() {
    super(service, anonymous, "item");
  }
}

/** A controller that keeps two verbs and writes the rest itself. */
@ApiController("/partials", { tag: "Partials" })
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
  app.use(errorHandler());

  return app;
};

describe("CrudController", () => {
  let served: ServedApp;

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<ICrudService<ItemDTO>>;

    served = await serve(buildApp(ItemsController as never, new ItemsController()));
  });

  afterEach(() => served.close());

  it("lists, passing down the pagination the schema already validated", async () => {
    service.list.mockResolvedValue({ data: [], total: 0, page: 2, limit: 5, pages: 0 });

    const res = await served.client.get("/items?page=2&limit=5");

    expect(res.status).toBe(200);
    // The whole query goes down: pagination is what the controller understands,
    // and anything else is for `CrudService.buildWhere` to interpret.
    expect(service.list).toHaveBeenCalledWith(2, 5, {
      withDeleted: undefined,
      query: { page: 2, limit: 5 },
    });
  });

  it("falls back to the first page when nothing was asked for", async () => {
    service.list.mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, pages: 0 });

    await served.client.get("/items");

    expect(service.list).toHaveBeenCalledWith(1, 10, { withDeleted: undefined, query: {} });
  });

  it("answers 404 with a stable code when there is no row", async () => {
    service.get.mockResolvedValue(null);

    const res = await served.client.get("/items/9");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    expect(res.body.message).toContain("item");
  });

  it("turns an id that is not a number into a 400, not an absurd query", async () => {
    const res = await served.client.get("/items/abc");

    expect(res.status).toBe(400);
    expect(service.get).not.toHaveBeenCalled();
  });

  it("creates returning the resource with its key, not an acknowledgement", async () => {
    // The client needs the primary key the database has just generated, and
    // making it ask again with a GET is one round trip too many.
    service.create.mockResolvedValue({ id: 7, name: "new" });

    const res = await served.client.post("/items", { body: { name: "new" } });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 7, name: "new" });
  });

  it("rejects an invalid body before it reaches the service", async () => {
    const res = await served.client.post("/items", { body: { name: "" } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(service.create).not.toHaveBeenCalled();
  });

  it("updates, and answers 404 when the row is not there", async () => {
    service.update.mockResolvedValueOnce({ id: 1, name: "other" });
    expect((await served.client.put("/items/1", { body: { name: "other" } })).status).toBe(200);

    service.update.mockResolvedValueOnce(null);
    expect((await served.client.put("/items/9", { body: { name: "other" } })).status).toBe(404);
  });

  it("answers 204 on a soft delete, and 404 when it touched nothing", async () => {
    service.softDelete.mockResolvedValueOnce(true);
    expect((await served.client.del("/items/1")).status).toBe(204);

    service.softDelete.mockResolvedValueOnce(false);
    expect((await served.client.del("/items/9")).status).toBe(404);
  });

  it("hands a failure of the service to the global handler", async () => {
    // The `try/catch` every controller used to repeat is written once here, so
    // a rejected promise cannot become an unhandled one.
    service.list.mockRejectedValue(new Error("the database is on fire"));

    const res = await served.client.get("/items");

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ status: "error", code: "INTERNAL_ERROR" });
  });

  it("does the same on the write verbs", async () => {
    service.create.mockRejectedValue(new Error("the database is on fire"));
    expect((await served.client.post("/items", { body: { name: "x" } })).status).toBe(500);

    service.update.mockRejectedValue(new Error("the database is on fire"));
    expect((await served.client.put("/items/1", { body: { name: "x" } })).status).toBe(500);

    service.softDelete.mockRejectedValue(new Error("the database is on fire"));
    expect((await served.client.del("/items/1")).status).toBe(500);
  });

  describe("verbs to order", () => {
    it("mounts only the ones that were declared", async () => {
      const partials = await serve(
        buildApp(PartialsController as never, new PartialsController())
      );
      service.list.mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, pages: 0 });

      try {
        expect((await partials.client.get("/partials")).status).toBe(200);
        // `create` was not asked for, so that route simply does not exist.
        expect((await partials.client.post("/partials", { body: { name: "x" } })).status).toBe(404);
      } finally {
        await partials.close();
      }
    });
  });
});
