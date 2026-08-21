import { missingSchemaRefs } from "monolite-http";
import { api, type Api } from "./support/api";

/**
 * The document, and whatever is mounted to read it.
 *
 * This is the part of an API that breaks without anybody noticing: a document
 * with a dangling reference still serves a 200, and the reader is the only
 * thing that sees the problem — as an operation with an empty body, in a
 * browser nobody has open during a deploy. So it is asserted here instead.
 */
describe("the API's own description", () => {
  let http: Api;

  beforeAll(async () => {
    http = await api();
  });

  it("is published, generated from the decorators that produced the routes", async () => {
    const response = await http.get("/openapi.json").expect(200);

    expect(response.body).toMatchObject({
      openapi: expect.stringMatching(/^3\./),
      info: { title: expect.any(String), version: expect.any(String) },
      paths: expect.any(Object),
    });
  });

  /**
   * The one failure a document has that nothing else catches. A component is
   * published by `defineDto`, and referenced by name from the route metadata;
   * nothing forces the two to meet, and when they do not, this is the only
   * place it shows.
   */
  it("references no component it does not declare", async () => {
    const response = await http.get("/openapi.json").expect(200);

    expect(missingSchemaRefs(response.body)).toEqual([]);
  });
#if docs

#if swagger
  it("has a reader mounted over it", async () => {
    const swagger = await http.get("__swaggerPath__/").expect(200);

    // The page loads the document from the route above rather than carrying a
    // copy, so there is one description of this API and not two.
    expect(swagger.text).toContain("swagger-ui");
  });
#endif
#if scalar

  /**
   * Scalar's page is not asserted here, and cannot be: the package is ESM-only
   * and Jest's CommonJS runtime refuses the dynamic import that loads it, so
   * `docs.ts` leaves the reader unmounted under the test suite and says so in
   * the log. What that page needs from this project — a document that resolves
   * and a policy that does not block a CDN — is what the rest of this file is
   * about. Check the page itself with `npm run dev` and a browser.
   */
#endif

  /**
   * The header that decides whether the reader is a page or a blank screen.
   * Helmet's default policy blocks both of them in different ways, so the
   * project leaves the CSP off until `CSP_ENABLED=true` asks for it, and then
   * widens it for the reader it actually mounts.
   */
  it("serves the reader under no policy that would blank it out", async () => {
    // Following the redirect on purpose: Swagger UI answers its bare path with
    // one, and `serve-static` puts a policy of its own on that hop. The page at
    // the end is the one whose headers decide whether a reader renders.
    const response = await http.get("__docsPath__").redirects(1);

    expect(response.headers["content-security-policy"]).toBeUndefined();
  });
#endif
});
