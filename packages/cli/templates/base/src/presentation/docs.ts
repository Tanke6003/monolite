import type { Application, Request, Response } from "express";
import { buildOpenApiDocument } from "monolite-http";
#if swagger
import swaggerUi from "swagger-ui-express";
#endif
#if scalar
import { apiReference } from "@scalar/express-api-reference";
#endif
import { areDocsEnabled, readEnv } from "../config/env";

/**
 * The API's description, and whatever is mounted to read it.
 *
 * The document is generated from the same decorator metadata that produced the
 * routes, so it cannot drift from the implementation, and it is published
 * whether or not a reader is mounted: a client generator wants the JSON, not a
 * page.
 *
 * `DOCS_ENABLED` governs both, and is on outside production — the document
 * describes the whole surface of the API, validation rules included, which is
 * more than a public deployment usually means to say.
 */
export function mountDocs(app: Application, apiPrefix: string): void {
  if (!areDocsEnabled(readEnv("DOCS_ENABLED"), readEnv("NODE_ENV", "development"))) return;

  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(
      buildOpenApiDocument({
        title: "__serviceName__",
        version: "__projectVersion__",
        description: "__projectDescription__",
        // Published as the server rather than baked into every path, so moving
        // `API_PREFIX` keeps "Try it out" pointing at this instance.
        apiPrefix,
      })
    );
  });
#if swagger

  // Pointed at the route above rather than handed the document directly, so
  // there is one source for it and the page cannot show a spec the API stopped
  // serving. Swagger UI bundles its own assets, so this works offline.
  app.use(
    "__docsPath__",
    swaggerUi.serve,
    swaggerUi.setup(undefined, { swaggerOptions: { url: "/openapi.json" } })
  );
#endif
#if scalar

  // Scalar renders the page and fetches the document from the route above. The
  // reader itself comes from a CDN, so somewhere without outbound internet
  // wants `cdn` pointed at a local copy — or Swagger UI, which bundles its own.
  app.use("__docsPath__", apiReference({ url: "/openapi.json" }));
#endif
}
