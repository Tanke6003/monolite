/**
 * The document has to match the routes it was built from.
 *
 * This is the half that makes the decorators worth having. Without it you save
 * an `app.get(...)` and little else; with it, the Zod schema that validates a
 * request is the same object that describes it, so the documentation cannot
 * lie about what the endpoint accepts. Every assertion here is really the same
 * one: *what was declared once shows up in both places, unchanged*.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import {
  ApiController,
  DEFAULT_SECURITY_SCHEMES,
  Delete,
  ERROR_RESPONSE_SCHEMA,
  ERROR_SCHEMA_NAME,
  Get,
  Post,
  Put,
  buildOpenApiDocument,
  buildOpenApiPaths,
  getControllerMetadata,
} from "@monolite/http";

const querySchema = z.object({
  page: z.string().optional(),
  search: z.string().meta({ description: "Free-text filter" }).optional(),
  status: z.string(),
});

const bodySchema = z.object({ name: z.string().min(1).max(10) });

@ApiController("/things", { tag: "Things" })
class ThingsController {
  @Get("/", {
    summary: "List",
    description: "Everything, a page at a time",
    query: querySchema,
    responses: { 200: { description: "A page", ref: "PaginatedThing" } },
  })
  public list = (_req: Request, res: Response) => res.json({});

  @Get("/open", { summary: "No token needed", public: true })
  public open = (_req: Request, res: Response) => res.json({});

  @Get("/:id", {
    summary: "One",
    params: { id: "integer" },
    responses: { 200: { description: "Found", ref: "Thing" }, 404: "No such thing" },
  })
  public byId = (_req: Request, res: Response) => res.json({});

  @Post("/", { summary: "Create", body: bodySchema, responses: { 201: "Created" } })
  public create = (_req: Request, res: Response) => res.status(201).json({});

  @Put("/:id", {
    summary: "Upload",
    params: { id: "integer" },
    requestBody: {
      mediaType: "multipart/form-data",
      schema: { type: "object", properties: { file: { type: "string", format: "binary" } } },
      description: "The file itself",
    },
  })
  public upload = (_req: Request, res: Response) => res.json({});

  @Delete("/:id", {
    summary: "Remove",
    params: { id: "integer" },
    responses: { 204: "Gone", 409: { description: "Still in use", schema: z.object({ why: z.string() }) } },
  })
  public remove = (_req: Request, res: Response) => res.status(204).send();
}

const metadata = getControllerMetadata(ThingsController)!;
const paths = buildOpenApiPaths([metadata]);

/** Reads an operation, or a document, without a cast at every assertion. */
 
type Loose = Record<string, any>;

 
const operation = (path: string, method: string): any =>
  (paths[path] as Record<string, unknown>)[method];

describe("buildOpenApiPaths", () => {
  it("publishes one path per route, in OpenAPI's own notation", () => {
    // `/things/:id` is Express's spelling; `/things/{id}` is OpenAPI's.
    expect(Object.keys(paths).sort()).toEqual(["/things", "/things/open", "/things/{id}"]);
  });

  it("shares an entry between routes that differ only in the verb", () => {
    expect(Object.keys(paths["/things"]).sort()).toEqual(["get", "post"]);
    expect(Object.keys(paths["/things/{id}"]).sort()).toEqual(["delete", "get", "put"]);
  });

  /**
   * The handler name identifies the operation and is unique within the
   * controller. Client generators name their methods after it; without one they
   * invent a name out of the verb and the path, and it changes the day the path
   * does.
   */
  it("takes the operationId from the handler name", () => {
    expect(operation("/things", "get").operationId).toBe("list");
    expect(operation("/things", "post").operationId).toBe("create");
    expect(operation("/things/{id}", "delete").operationId).toBe("remove");
  });

  it("carries the tag, the summary and the description of the declaration", () => {
    expect(operation("/things", "get")).toMatchObject({
      tags: ["Things"],
      summary: "List",
      description: "Everything, a page at a time",
    });
  });

  it("orders the operations by specificity, the same way the router mounts them", () => {
    // The document reads in the order the routes are actually tried, which is
    // what stops a reader from concluding that `/things/{id}` shadows
    // `/things/open`.
    expect(Object.keys(paths)).toEqual(["/things", "/things/open", "/things/{id}"]);
  });

  describe("parameters", () => {
    it("generates one query parameter per property of the Zod schema", () => {
      const parameters = operation("/things", "get").parameters;

      expect(parameters).toEqual([
        { in: "query", name: "page", required: false, schema: { type: "string" } },
        {
          in: "query",
          name: "search",
          required: false,
          schema: { type: "string", description: "Free-text filter" },
          description: "Free-text filter",
        },
        { in: "query", name: "status", required: true, schema: { type: "string" } },
      ]);
    });

    it("marks a path parameter as required, always", () => {
      expect(operation("/things/{id}", "get").parameters).toEqual([
        { in: "path", name: "id", required: true, schema: { type: "integer" } },
      ]);
    });

    it("declares no `parameters` key at all when the route takes none", () => {
      expect(operation("/things/open", "get").parameters).toBeUndefined();
    });

    it("survives a query schema that names no properties", () => {
      // A schema that accepts anything documents nothing, which is the honest
      // answer — and better than crashing the whole generator over one route.
      @ApiController("/loose")
      class LooseController {
        @Get("/", { public: true, query: z.any() })
        public list = (_req: Request, res: Response) => res.json({});
      }

      const loose = buildOpenApiPaths([getControllerMetadata(LooseController)!]);

      expect((loose["/loose"].get as Loose)["parameters"]).toBeUndefined();
    });
  });

  describe("request body", () => {
    it("generates it from the Zod schema, constraints included", () => {
      // The constraints are not repeated in a comment that could disagree with
      // the validator: they *are* the validator.
      expect(
        operation("/things", "post").requestBody.content["application/json"].schema
      ).toMatchObject({
        type: "object",
        properties: { name: { type: "string", minLength: 1, maxLength: 10 } },
        required: ["name"],
      });
    });

    it("keeps a hand-written body for what Zod cannot describe", () => {
      // A multipart upload arrives as a stream, so no schema validates it. Left
      // undocumented, Swagger sends the request with no `Content-Type` and no
      // file picker, and the endpoint refuses it for reasons nobody can see.
      expect(operation("/things/{id}", "put").requestBody).toEqual({
        required: true,
        description: "The file itself",
        content: {
          "multipart/form-data": {
            schema: { type: "object", properties: { file: { type: "string", format: "binary" } } },
          },
        },
      });
    });

    it("declares no body for a route that takes none", () => {
      expect(operation("/things", "get").requestBody).toBeUndefined();
    });
  });

  describe("security", () => {
    it("adds the 401 and the bearer requirement to a guarded route", () => {
      // The guard is what produces that 401, and the guard is applied by the
      // router, not by the route. Documenting it here means no route has to
      // remember to — and none can forget.
      const guarded = operation("/things", "get");

      expect(guarded.responses["401"]).toBeDefined();
      expect(guarded.security).toEqual([{ bearerAuth: [] }]);
    });

    it("adds neither to a route marked public", () => {
      const open = operation("/things/open", "get");

      expect(open.responses["401"]).toBeUndefined();
      expect(open.security).toBeUndefined();
    });

    it("does not overwrite a 401 the route described itself", () => {
      @ApiController("/own")
      class OwnController {
        @Get("/", { responses: { 401: "Say it my way" } })
        public list = (_req: Request, res: Response) => res.json({});
      }

      const own = buildOpenApiPaths([getControllerMetadata(OwnController)!]);

      expect((own["/own"].get as Loose)["responses"]["401"].description).toBe(
        "Say it my way"
      );
    });
  });

  describe("responses", () => {
    it("resolves a `ref` to a component of the document", () => {
      expect(operation("/things", "get").responses["200"]).toEqual({
        description: "A page",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/PaginatedThing" } },
        },
      });
    });

    it("generates the body of a response declared with a schema", () => {
      expect(
        operation("/things/{id}", "delete").responses["409"].content["application/json"].schema
      ).toMatchObject({ type: "object", properties: { why: { type: "string" } } });
    });

    it("points every 4xx and 5xx at the shared error component", () => {
      // One place produces every error in the API — the global handler — so the
      // envelope is declared once and referenced from everywhere. Otherwise a
      // client sees "404 Not found" and has to guess that the body carries a
      // stable `code` worth branching on.
      const ref = { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` };

      expect(operation("/things/{id}", "get").responses["404"].content["application/json"].schema)
        .toEqual(ref);
      expect(operation("/things", "get").responses["401"].content["application/json"].schema)
        .toEqual(ref);
    });

    it("leaves a failure that described its own body alone", () => {
      expect(
        operation("/things/{id}", "delete").responses["409"].content["application/json"].schema
      ).not.toEqual({ $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` });
    });

    it("does not attach the error envelope to a success", () => {
      expect(operation("/things", "post").responses["201"]).toEqual({ description: "Created" });
    });

    it("assumes a 200 for a route that declares no responses", () => {
      expect(operation("/things/open", "get").responses["200"]).toEqual({ description: "OK" });
    });
  });

  it("describes the error envelope with the fields a client branches on", () => {
    expect(ERROR_RESPONSE_SCHEMA.required).toEqual([
      "status",
      "code",
      "message",
      "timestamp",
      "path",
      "method",
    ]);
  });
});

describe("buildOpenApiDocument", () => {
  const document = buildOpenApiDocument({
    title: "Things API",
    version: "1.2.3",
    apiPrefix: "/api/v1",
    controllers: [metadata],
  }) as Loose;

  it("declares OpenAPI 3.1, which is the dialect Zod already emits", () => {
    // 3.0 would mean translating every generated schema into its differences
    // (`nullable`, boolean `exclusiveMinimum`), which is exactly the code the
    // generation is here to remove.
    expect(document.openapi).toBe("3.1.0");
  });

  it("publishes the title and the version it was given", () => {
    expect(document.info).toEqual({ title: "Things API", version: "1.2.3" });
  });

  it("declares the mount prefix as a relative server, so it works behind any domain", () => {
    expect(document.servers).toEqual([{ url: "/api/v1", description: "Current version" }]);
  });

  it("declares the bearer scheme the route decorators reference", () => {
    // Without it the operations would point at a scheme that does not exist and
    // Swagger would show no "Authorize" button at all.
    expect(document.components.securitySchemes).toEqual(DEFAULT_SECURITY_SCHEMES);
    expect(document.security).toEqual([{ bearerAuth: [] }]);
  });

  it("includes the shared error component every failure points at", () => {
    expect(document.components.schemas[ERROR_SCHEMA_NAME]).toEqual(ERROR_RESPONSE_SCHEMA);
  });

  it("merges the extra components it is handed", () => {
    const withExtras = buildOpenApiDocument({
      title: "t",
      version: "1",
      controllers: [metadata],
      schemas: { Thing: { type: "object" } },
    }) as Loose;

    expect(withExtras.components.schemas.Thing).toEqual({ type: "object" });
  });

  it("builds the paths out of the controllers it was given", () => {
    expect(Object.keys(document.paths).sort()).toEqual([
      "/things",
      "/things/open",
      "/things/{id}",
    ]);
  });

  it("declares no servers when neither a prefix nor a list was supplied", () => {
    const bare = buildOpenApiDocument({ title: "t", version: "1", controllers: [] }) as Loose;

    expect(bare.servers).toBeUndefined();
  });

  it("takes the servers it was handed over the prefix", () => {
    const behindAProxy = buildOpenApiDocument({
      title: "t",
      version: "1",
      apiPrefix: "/api/v1",
      servers: [{ url: "https://api.example.com/v1", description: "Production" }],
      controllers: [],
    }) as Loose;

    expect(behindAProxy.servers).toEqual([
      { url: "https://api.example.com/v1", description: "Production" },
    ]);
  });

  /**
   * Defaulting to the registry is what makes the document self-maintaining:
   * importing a controller is what registers it, so the list the router mounts
   * and the list the document describes are the same list, with nothing to keep
   * in step by hand. It is exercised in an isolated module so the registry holds
   * only the controller declared here.
   */
  it("documents every registered controller when it is given no list", async () => {
    await jest.isolateModulesAsync(async () => {
      const http = (await import("@monolite/http")) as typeof import("@monolite/http");

      @http.ApiController("/only", { tag: "Only" })
      class OnlyController {
        @http.Get("/", { public: true })
        public list = (_req: Request, res: Response) => res.json({});
      }
      void OnlyController;

      const document = http.buildOpenApiDocument({ title: "t", version: "1" }) as Loose;

      expect(Object.keys(document.paths)).toEqual(["/only"]);
    });
  });
});
