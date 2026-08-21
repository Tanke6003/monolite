/**
 * The check that catches the one way a generated document breaks silently.
 *
 * `@Crud({ dto: "Product" })` names its schemas by string, and the components
 * come from whichever DTO modules were loaded. Nothing forces the two halves to
 * meet: when they do not, the document is still valid JSON, still serves a 200,
 * and only the reader notices — Swagger UI renders the operation with an empty
 * body and Scalar shows nothing at all. This is what turns that into a line in
 * the log with the missing names in it.
 */
import { buildOpenApiDocument, defineDto, missingSchemaRefs } from "monolite-http";
import { z } from "zod";

const document = (paths: Record<string, unknown>, schemas: Record<string, unknown> = {}) => ({
  openapi: "3.1.0",
  components: { schemas },
  paths,
});

describe("missingSchemaRefs", () => {
  it("names a component the document points at and does not declare", () => {
    const doc = document({
      "/products": {
        get: {
          responses: {
            200: { content: { "application/json": { schema: { $ref: "#/components/schemas/PaginatedProduct" } } } },
          },
        },
      },
    });

    expect(missingSchemaRefs(doc)).toEqual(["PaginatedProduct"]);
  });

  it("says nothing when every reference resolves", () => {
    const doc = document(
      { "/p": { get: { responses: { 200: { schema: { $ref: "#/components/schemas/Product" } } } } } },
      { Product: { type: "object" } }
    );

    expect(missingSchemaRefs(doc)).toEqual([]);
  });

  it("reports each missing name once, sorted, however deep it was buried", () => {
    const doc = document({
      "/a": { get: { responses: { 200: { schema: { $ref: "#/components/schemas/Zebra" } } } } },
      "/b": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Apple" } },
              },
            },
          },
          responses: { 200: { schema: { $ref: "#/components/schemas/Zebra" } } },
        },
      },
    });

    expect(missingSchemaRefs(doc)).toEqual(["Apple", "Zebra"]);
  });

  it("leaves a reference into another document to whoever resolves it", () => {
    // Not this function's to judge: it says which of *this* document's
    // components are missing, and an external `$ref` has none of them.
    const doc = document({
      "/a": { get: { responses: { 200: { schema: { $ref: "https://example.com/schema.json" } } } } },
    });

    expect(missingSchemaRefs(doc)).toEqual([]);
  });

  /**
   * The real case, end to end: a DTO that went through `defineDto` resolves,
   * and the one that did not is reported by name.
   */
  it("agrees with a document built out of the registry", async () => {
    await jest.isolateModulesAsync(async () => {
      const http = (await import("monolite-http")) as typeof import("monolite-http");

      http.defineDto("Registered", z.object({ id: z.int() }));

      @http.ApiController("/things", { tag: "Things" })
      class ThingsController {
        @http.Get("/", {
          public: true,
          responses: { 200: { description: "Fine", ref: "Registered" } },
        })
        public list = () => undefined;

        @http.Get("/other", {
          public: true,
          responses: { 200: { description: "Not fine", ref: "NeverDeclared" } },
        })
        public other = () => undefined;
      }
      void ThingsController;

      const built = http.buildOpenApiDocument({ title: "t", version: "1" });

      expect(http.missingSchemaRefs(built)).toEqual(["NeverDeclared"]);
    });
  });

  it("counts the error envelope the builder declares for itself", () => {
    // Every failure response references `ErrorResponse`, and the builder is the
    // one that declares it. If that ever stops being true, this is where it
    // shows up rather than in somebody's browser.
    defineDto("Thing", z.object({ id: z.int() }));

    const built = buildOpenApiDocument({ title: "t", version: "1", controllers: [] });

    expect(missingSchemaRefs(built)).toEqual([]);
  });
});
