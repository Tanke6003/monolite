/**
 * `monolite-http` — the decorator-driven Express layer.
 *
 * A controller declares its own routes: which verb it serves, on which path,
 * what it validates and what it answers. Out of that single declaration come
 * both the routing and the OpenAPI document, so the schema, the validation and
 * the documentation cannot drift apart — there is only one of each.
 *
 * The package stays free of any DI container and of any database driver.
 * Whatever the original code resolved from a container arrives here as a
 * parameter: the logger, the request context, the auth guard, the health probe
 * and the list of controllers are all handed in by the application.
 */

// The Express `Request` augmentation has to be imported, not merely present in
// the source tree: `tsc` does not copy a hand-written `.d.ts` into `dist`, so a
// declaration file here would compile inside the package and never reach a
// consumer. Importing a real module for its side effect is what carries the
// `declare global` block into the emitted output.
import "./types/express.js";

// --------------------------------------------------------------  routing  ---
export {
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
} from "./routing/route.decorators.js";
export type {
  ControllerMetadata,
  ControllerType,
  HttpMethod,
  PathParamType,
  ResponseSpec,
  RouteMetadata,
  RouteOptions,
} from "./routing/route.decorators.js";

export {
  controllersFromRegistry,
  registerController,
  registerControllers,
} from "./routing/router.builder.js";
export type { ControllerRegistration } from "./routing/router.builder.js";

// --------------------------------------------------------------  openapi  ---
export {
  ERROR_RESPONSE_SCHEMA,
  ERROR_SCHEMA_NAME,
  buildOpenApiPaths,
} from "./openapi/openapi.builder.js";
export type { BuildPathsOptions, OpenApiPaths } from "./openapi/openapi.builder.js";

export { DEFAULT_SECURITY_SCHEMES, buildOpenApiDocument } from "./openapi/document.builder.js";
export type { BuildOpenApiDocumentOptions, OpenApiServer } from "./openapi/document.builder.js";

export { buildDtoComponents, defineDto, definePagedDto } from "./openapi/dto.registry.js";

export { missingSchemaRefs } from "./openapi/refs.js";

// ----------------------------------------------------------  middlewares  ---
export { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";
export type { ErrorHandlerOptions } from "./middlewares/error-handler.js";

export { httpLogger } from "./middlewares/http-logger.js";
export type { HttpLoggerOptions } from "./middlewares/http-logger.js";

export {
  REQUEST_ID_HEADER,
  currentUserName,
  requestContext,
  toCurrentUser,
} from "./middlewares/request-context.js";
export type { TokenClaims } from "./middlewares/request-context.js";

export { validateBody, validateQuery } from "./middlewares/validate.js";

// -----------------------------------------------------------  controllers ---
export { BaseController } from "./controllers/base.controller.js";

// ---------------------------------------------------------------  config  ---
export { DEFAULT_API_PREFIX, DEFAULT_LEGACY_PREFIX, resolveApiPrefix, resolveLegacyPrefix } from "./config/api.config.js";

export {
  DEFAULT_CSP_DIRECTIVES,
  SCALAR_CDN_ORIGIN,
  SECURITY_DEFAULTS,
  areDocsEnabled,
  buildAuthRateLimiter,
  buildCorsOptions,
  buildHelmetOptions,
  buildRateLimiter,
  docsCspDirectives,
  resolveAllowedOrigins,
  resolveBodyLimit,
  resolveTrustProxy,
} from "./config/security.config.js";
export type { DocsReader } from "./config/security.config.js";

export { processEnv } from "./config/env-source.js";
export type { EnvSource } from "./config/env-source.js";

// ---------------------------------------------------------------  server  ---
export { createApp } from "./server/create-app.js";
export type { CreateAppOptions, HttpApp } from "./server/create-app.js";

export { healthRoutes } from "./server/health.routes.js";
export type { HealthRoutesOptions } from "./server/health.routes.js";

// ----------------------------------------------------------------  utils  ---
export { parseId } from "./utils/parse-id.js";
