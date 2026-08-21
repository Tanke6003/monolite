// OpenAPI out of the route metadata and the Zod schemas.
//
// This is the half that makes the decorators worth it. Without it you save the
// `app.get(...)` and little else, because in a hand-documented route file
// between 71 % and 77 % of the lines were the `@openapi` block: the very
// information already present in the validator, repeated with nothing to
// guarantee the two agreed.
import { z, type ZodType } from "zod";
import {
  bySpecificity,
  joinPath,
  type ControllerMetadata,
  type ResponseSpec,
  type RouteMetadata,
} from "../routing/route.decorators.js";

/** The OpenAPI document, as far as this generator is concerned. */
export type OpenApiPaths = Record<string, Record<string, unknown>>;

/**
 * JSON Schema of a Zod type.
 *
 * Always in `input` mode: the documentation describes what the client
 * **sends**, not what the validator returns after its transformations. It is
 * also the only mode that works with a `.transform()` — the output one cannot
 * represent them — and query schemas rely on exactly that to turn the string in
 * the URL into a number.
 */
function toSchema(schema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  // `$schema` is correct in a standalone document but noise inside OpenAPI.
  delete json.$schema;
  return json;
}

/** `/users/:id` -> `/users/{id}`, which is how OpenAPI writes them. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** One parameter per property of the query schema. */
function queryParameters(schema: ZodType): Record<string, unknown>[] {
  const json = toSchema(schema);
  const properties = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((json.required as string[] | undefined) ?? []);

  return Object.entries(properties).map(([name, propertySchema]) => ({
    in: "query",
    name,
    required: required.has(name),
    schema: propertySchema,
    ...(propertySchema.description ? { description: propertySchema.description } : {}),
  }));
}

function pathParameters(params: RouteMetadata["params"]): Record<string, unknown>[] {
  return Object.entries(params ?? {}).map(([name, type]) => ({
    in: "path",
    name,
    required: true,
    schema: { type },
  }));
}

/** Name of the component holding the API's common error envelope. */
export const ERROR_SCHEMA_NAME = "ErrorResponse";

/**
 * The shape of **any** error in the API.
 *
 * A single place produces it — the global handler — so it is declared once and
 * referenced from every 4xx and 5xx. Left undocumented, a client sees "401
 * Unauthorized" and has to guess that the body carries a stable `code` to
 * branch on.
 */
export const ERROR_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", const: "error" },
    code: {
      type: "string",
      description: "Stable code; this is what to branch on.",
      examples: ["VALIDATION_ERROR", "NO_TOKEN", "APPOINTMENT_OVERLAP"],
    },
    message: { type: "string" },
    requestId: {
      type: "string",
      description: "Same value as the X-Request-Id header. Useful for support.",
    },
    timestamp: { type: "string", format: "date-time" },
    path: { type: "string" },
    method: { type: "string" },
    errors: {
      type: "array",
      description: "Validation errors only: which field and why.",
      items: {
        type: "object",
        properties: { field: { type: "string" }, message: { type: "string" } },
        required: ["field", "message"],
      },
    },
  },
  required: ["status", "code", "message", "timestamp", "path", "method"],
} as const;

const errorContent = {
  content: { "application/json": { schema: { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` } } },
};

/** Body of a response, either by reference to a component or generated. */
function contentOf(spec: Exclude<ResponseSpec, string>): Record<string, unknown> {
  if (spec.ref) {
    return {
      content: {
        "application/json": { schema: { $ref: `#/components/schemas/${spec.ref}` } },
      },
    };
  }
  if (spec.schema) {
    return { content: { "application/json": { schema: toSchema(spec.schema) } } };
  }
  return {};
}

/**
 * The declared responses plus the ones that always hold.
 *
 * Two things are added on their own, because they are true across the whole API
 * and repeating them on every route would only be an opportunity to forget
 * them:
 *
 *  - the 401 on any route that goes through the guard;
 *  - the error body on every 4xx and 5xx that does not describe another one.
 */
/**
 * The standard reason phrase for a status code, used when a response names a
 * component instead of describing itself.
 *
 * Only the codes this toolkit's own routes emit. Anything else falls back to
 * the code as prose rather than to a wrong phrase from a table that tried to
 * cover all of RFC 9110: a reader is better served by "418" than by a
 * confidently mislabelled one.
 */
const REASON_PHRASES: Record<string, string> = {
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "204": "No Content",
  "400": "Bad Request",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "Not Found",
  "409": "Conflict",
  "422": "Unprocessable Content",
  "429": "Too Many Requests",
  "500": "Internal Server Error",
};

function reasonPhrase(code: string): string {
  return REASON_PHRASES[code] ?? `Status ${code}`;
}

function responsesOf(route: RouteMetadata, options: BuildPathsOptions): Record<string, unknown> {
  const declared: Record<string, unknown> = {};

  for (const [code, spec] of Object.entries(route.responses ?? { 200: "OK" })) {
    const normalized = typeof spec === "string" ? { description: spec } : spec;

    declared[code] = {
      // OpenAPI 3.1 requires a description on a response object, so one is
      // always emitted — but a route that already named a component does not
      // have to restate it. `{ ref: "Appointment" }` under a 201 was written
      // four separate times in the documentation before anything compiled it,
      // which says plainly enough what people expect the short form to be.
      description: normalized.description ?? reasonPhrase(code),
      ...contentOf(normalized),
    };
  }

  if (options.secured !== false && !route.public && !declared["401"]) {
    declared["401"] = { description: "The token is missing or not valid" };
  }

  for (const [code, response] of Object.entries(declared)) {
    const isFailure = Number(code) >= 400;
    const hasContent = "content" in (response as Record<string, unknown>);
    if (isFailure && !hasContent) {
      declared[code] = { ...(response as Record<string, unknown>), ...errorContent };
    }
  }

  return declared;
}

/**
 * The request body: the one generated from the Zod schema, or the one declared
 * by hand when it is not JSON. If it is missing, the operation declares no body
 * and the "Try it out" of the documentation sends the request with no
 * `Content-Type`.
 */
function requestBodyOf(route: RouteMetadata): Record<string, unknown> {
  if (route.body) {
    return {
      requestBody: {
        required: true,
        content: { "application/json": { schema: toSchema(route.body) } },
      },
    };
  }

  if (route.requestBody) {
    const { mediaType, schema, required = true, description } = route.requestBody;
    return {
      requestBody: {
        required,
        ...(description ? { description } : {}),
        content: { [mediaType]: { schema } },
      },
    };
  }

  return {};
}

function operationOf(
  route: RouteMetadata,
  options: BuildPathsOptions,
  tag?: string
): Record<string, unknown> {
  const parameters = [
    ...pathParameters(route.params),
    ...(route.query ? queryParameters(route.query) : []),
  ];

  return {
    ...(tag ? { tags: [tag] } : {}),
    // The handler name already identifies the operation and is unique within
    // the controller. It is what client generators use to name the method, and
    // without it they invent one out of the path and the verb.
    operationId: route.handler,
    ...(route.summary ? { summary: route.summary } : {}),
    ...(route.description ? { description: route.description } : {}),
    ...(options.secured === false || route.public ? {} : { security: [{ bearerAuth: [] }] }),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...requestBodyOf(route),
    responses: responsesOf(route, options),
  };
}

export interface BuildPathsOptions {
  /**
   * Whether the API authenticates at all. `true` by default, which is what the
   * decorators assume: a route is closed unless it declares itself `public`, so
   * every other one gets `security: [{ bearerAuth: [] }]` and a 401.
   *
   * An application scaffolded or deployed with no authentication passes
   * `false`, and the whole of that disappears from the document. It is not a
   * cosmetic difference: a reader that shows "Auth Required" and asks for a
   * bearer token on an API that has none sends every reader looking for a login
   * endpoint that does not exist.
   */
  secured?: boolean;
}

/**
 * Builds the `paths` block of every decorated controller.
 *
 * Two routes with the same path and different verbs share an entry, which is
 * how OpenAPI expects them.
 */
export function buildOpenApiPaths(
  controllers: ControllerMetadata[],
  options: BuildPathsOptions = {}
): OpenApiPaths {
  const paths: OpenApiPaths = {};

  for (const controller of controllers) {
    // Same order as the routing, so the documentation reads the same way.
    for (const route of [...controller.routes].sort(bySpecificity)) {
      const path = toOpenApiPath(joinPath(controller.prefix, route.path));
      paths[path] ??= {};
      paths[path][route.method] = operationOf(route, options, controller.tag);
    }
  }

  return paths;
}
