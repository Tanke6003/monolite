import type { Application, Request, Response } from "express";
import type { ILogger } from "monolite-core";
import { buildOpenApiDocument, missingSchemaRefs } from "monolite-http";
#if swagger
import swaggerUi from "swagger-ui-express";
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
export async function mountDocs(
  app: Application,
  apiPrefix: string,
  logger?: ILogger
): Promise<void> {
  if (!areDocsEnabled(readEnv("DOCS_ENABLED"), readEnv("NODE_ENV", "development"))) return;

  const document = (): Record<string, unknown> =>
    buildOpenApiDocument({
      title: "__serviceName__",
      version: "__projectVersion__",
      description: "__projectDescription__",
      // Published as the server rather than baked into every path, so moving
      // `API_PREFIX` keeps "Try it out" pointing at this instance.
      apiPrefix,
#if !auth
      // This project was generated without authentication, so the document says
      // so: no `bearerAuth` scheme, no "Authorize" button, and no 401 invented
      // for routes that nothing guards. Add the guard and turn this back on
      // together — a reader that asks for a token the API cannot issue is worse
      // than one that asks for none.
      secured: false,
#endif
    });

  // Checked once, at startup, and not on every request. A `$ref` to a component
  // nobody registered is the one way this document breaks while still serving a
  // perfectly valid 200: the reader is the only thing that notices, and all it
  // reports is that it could not resolve a reference.
  //
  // The usual cause is a DTO that was never passed through `defineDto`, or one
  // declared in a module that only ever gets imported for its *types* — those
  // imports are erased at compile time, so the registration beside them never
  // runs.
  const missing = missingSchemaRefs(document());
  if (missing.length > 0) {
    logger?.warn("The OpenAPI document references components that are not declared", {
      missing,
      hint: "declare them with defineDto(), and make sure the module is imported for its value",
    });
  }

  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(document());
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
  //
  // It is also why `server.ts` widens the Content-Security-Policy for this
  // project: under a policy of `'self'` the CDN script never loads and the page
  // comes out blank, with a 200 and no error anywhere but the browser console.
  //
  // Imported here rather than at the top of the file, and on purpose: the
  // package is ESM-only and this project compiles to CommonJS, so a static
  // import becomes a `require()` of an ES module — which Node only tolerates
  // from v22, while this project supports v20. A dynamic `import()` is the one
  // spelling that works on both.
  const { apiReference } = await import("@scalar/express-api-reference");
  app.use("__docsPath__", apiReference({ url: "/openapi.json" }));
#endif
}
