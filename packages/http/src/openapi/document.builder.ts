// The whole OpenAPI document, generated.
//
// Not one `@openapi` comment is left anywhere: routes are declared by the
// controller decorators and the schemas come out of Zod. Besides saving the
// YAML, that fixes a problem comment-based generation had at the root:
// swagger-jsdoc read the annotations from `./src/**/*.ts`, which does not exist
// in a production container, and `removeComments: true` stripped them from the
// compiled output. The documentation was correct in development and came out
// empty in production.
import { registeredControllers, type ControllerMetadata } from "../routing/route.decorators.js";
import { buildDtoComponents } from "./dto.registry.js";
import { buildOpenApiPaths, ERROR_RESPONSE_SCHEMA, ERROR_SCHEMA_NAME } from "./openapi.builder.js";

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface BuildOpenApiDocumentOptions {
  /** Name of the service, as it appears at the top of the documentation. */
  title: string;
  /**
   * Published version of the service, the one that changes on every release.
   * Not to be confused with the `/v1` in the path, which is the version of the
   * contract.
   */
  version: string;
  description?: string;
  /**
   * Where the API answers. If it is omitted, a single relative server is
   * declared from `apiPrefix`.
   */
  servers?: OpenApiServer[];
  /**
   * Where the API is mounted. Routes hang off the server entry, so they are
   * declared with no prefix (`/users`); publishing the prefix as the server
   * means that moving `API_PREFIX` keeps "Try it out" pointing at the right
   * place.
   */
  apiPrefix?: string;
  /**
   * Authentication schemes. The default declares the `bearerAuth` that
   * non-public operations reference, so a document generated with no
   * configuration is already consistent with what the decorators emit.
   */
  securitySchemes?: Record<string, unknown>;
  /**
   * Controllers to document. Defaults to every decorated controller loaded so
   * far, which is the same list the router mounts — importing the controller is
   * what registers it, and nothing else needs to be kept in sync.
   */
  controllers?: ControllerMetadata[];
  /** Extra components, merged on top of the ones generated from the DTOs. */
  schemas?: Record<string, unknown>;
}

/**
 * The `bearerAuth` scheme the route decorators assume.
 *
 * `@Get("/x")` without `public: true` emits `security: [{ bearerAuth: [] }]`, so
 * a document that did not declare the scheme would reference something that
 * does not exist and Swagger would show no "Authorize" button.
 */
export const DEFAULT_SECURITY_SCHEMES: Record<string, unknown> = {
  bearerAuth: {
    description:
      'JWT Authorization header using the Bearer scheme. Example: "Authorization: Bearer {token}"',
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  },
};

/**
 * The complete document, exactly as Swagger, Scalar and `/openapi.json` serve
 * it.
 *
 * Everything specific to an application — its title, its servers, its extra
 * components — arrives through the options. What this function owns is the
 * assembly: paths from the route metadata, schemas from the DTO registry, and
 * the shared error envelope every failure response points at.
 */
export function buildOpenApiDocument(options: BuildOpenApiDocumentOptions): Record<string, unknown> {
  const {
    title,
    version,
    description,
    apiPrefix,
    servers,
    securitySchemes = DEFAULT_SECURITY_SCHEMES,
    controllers = registeredControllers().map(([, metadata]) => metadata),
    schemas = {},
  } = options;

  const resolvedServers =
    servers ??
    (apiPrefix
      ? [
          {
            // Relative, so the documentation works behind any domain and not
            // just on localhost.
            url: apiPrefix,
            description: "Current version",
          },
        ]
      : []);

  return {
    // 3.1 and not 3.0 because its schema *is* JSON Schema 2020-12, which is
    // exactly what Zod emits. With 3.0 every generated schema would have to be
    // translated into its differences (`nullable`, boolean `exclusiveMinimum`…)
    // and that translation is precisely the kind of code this removes.
    openapi: "3.1.0",
    info: {
      title,
      version,
      ...(description ? { description } : {}),
    },
    ...(resolvedServers.length > 0 ? { servers: resolvedServers } : {}),
    components: {
      securitySchemes,
      schemas: {
        ...buildDtoComponents(),
        // The error envelope is common to the whole API, so it is declared once
        // and every failure response references it.
        [ERROR_SCHEMA_NAME]: ERROR_RESPONSE_SCHEMA,
        ...schemas,
      },
    },
    security: Object.keys(securitySchemes).map((name) => ({ [name]: [] })),
    paths: buildOpenApiPaths(controllers),
  };
}
