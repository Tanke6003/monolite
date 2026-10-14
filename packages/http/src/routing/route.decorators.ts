// Route declaration on the controller itself, the way Angular or Nest do it:
// the method says which verb it serves, on which path, what it validates and
// what it answers, and out of that come both the routing and the documentation.
//
// The point is not saving the `app.get(...)` — that is thirty lines per module —
// but that **the route, the validation and the OpenAPI stop being written three
// times**. Today a Zod schema says `limit` is an integer between 1 and 100, a
// hand-written `@openapi` block repeats it, and nothing forces them to agree; as
// soon as one changes, the other lies. Here only the schema exists.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { output, ZodType } from "zod";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** Type of a path parameter, for documenting it. */
export type PathParamType = "integer" | "string";

/**
 * A documented response.
 *
 * The short form is just the description, which is enough for a 204 or for an
 * error. When the response carries a body there are two ways to describe it:
 *
 * - `ref`: name of a component already declared (`PaginatedUsers`). This is what
 *   successful responses use, because their shape is defined by the DTO and
 *   there is no outbound Zod schema to derive it from.
 * - `schema`: a Zod type, if there is one. It is generated the same way as the
 *   request body.
 *
 * **`description` is optional once one of those is present.** OpenAPI requires a
 * description on a response object and the builder still emits one — from the
 * status code's reason phrase — but a route that has already named the component
 * does not have to restate it as "Created". Four documented examples were
 * written as `{ ref: "Appointment" }` and nobody noticed they did not compile
 * until the documentation started going through the compiler, which is a fairly
 * direct statement about what the short form ought to be.
 */
export type ResponseSpec =
  | string
  | {
      description: string;
      /** Component of `components.schemas`, without the `#/...`. */
      ref?: string;
      schema?: ZodType;
    }
  | {
      description?: string;
      /** Component of `components.schemas`, without the `#/...`. */
      ref: string;
      schema?: ZodType;
    }
  | {
      description?: string;
      ref?: string;
      schema: ZodType;
    };

export interface RouteOptions {
  /** One line; it is what shows up in the Swagger list. */
  summary?: string;
  description?: string;
  /** Schema of the JSON body. It is both validated and documented with it. */
  body?: ZodType;
  /**
   * A body that is not JSON, described by hand.
   *
   * It exists for what Zod cannot represent and the server does not validate
   * with a schema: a `multipart/form-data` upload, which arrives as a stream.
   * Without this the documentation declares no body, and then Swagger and
   * Scalar send the request with no `Content-Type` — and no file picker — and
   * the endpoint rejects it without it being clear why.
   */
  requestBody?: {
    mediaType: string;
    /** JSON Schema, verbatim as it goes into the document. */
    schema: Record<string, unknown>;
    required?: boolean;
    description?: string;
  };
  /** Schema of the query string. Each property is published as a parameter. */
  query?: ZodType;
  /** Path parameters (`/users/:id` -> `{ id: "integer" }`). */
  params?: Record<string, PathParamType>;
  /** Response codes and what they return. */
  responses?: Record<number, ResponseSpec>;
  /**
   * No token required. By default **every** route demands a JWT: if opening one
   * is an oversight, let the oversight be closing it and not the other way
   * round.
   */
  public?: boolean;
  /**
   * Extra middleware, between the validation and the handler.
   *
   * It accepts a function because a decorator is evaluated when the class is
   * loaded, when there is no instance yet: if the middleware depends on
   * something injected — a limiter configured per environment, say — it is
   * asked for here and the router builder resolves it with the instance already
   * in place.
   */
  use?: RequestHandler[] | ((controller: object) => RequestHandler[]);
}

export interface RouteMetadata extends RouteOptions {
  method: HttpMethod;
  path: string;
  /** Name of the controller property that serves the route. */
  handler: string;
}

export interface ControllerMetadata {
  prefix: string;
  tag?: string;
  /**
   * Token the container resolves the actual servant with.
   *
   * It lives here so that mounting the API is just walking the registry:
   * without it there would be a class-to-token table to maintain by hand, which
   * is precisely the list that gets forgotten when a module is added. The class
   * contributes the routes; the token, the implementation — which is how a test
   * can substitute it.
   */
  token?: string;
  routes: RouteMetadata[];
}

/**
 * Metadata per class.
 *
 * It is indexed by constructor and not by name so that two controllers with the
 * same name in different modules do not overwrite each other.
 */
/**
 * A decorated controller class.
 *
 * `never[]` rather than `unknown[]` because nothing here ever constructs one —
 * the container does, from the arguments its own decorators declared. This type
 * only has to be the shape a class satisfies and an instance does not, which is
 * what stops an already-built controller being passed where the class belongs.
 */
export type ControllerType = new (...args: never[]) => object;

const REGISTRY = new Map<object, ControllerMetadata>();

function metadataOf(target: object): ControllerMetadata {
  let metadata = REGISTRY.get(target);
  if (!metadata) {
    metadata = { prefix: "", routes: [] };
    REGISTRY.set(target, metadata);
  }
  return metadata;
}

/**
 * Marks the class as an HTTP controller and gives it its prefix.
 *
 * Method decorators run **before** the class one, so by the time this arrives
 * the route list is already populated; that is why it only fills in the prefix
 * instead of creating the entry.
 */
export function ApiController(prefix: string, options: { tag?: string; token?: string } = {}) {
  return function (target: new (...args: never[]) => object): void {
    const metadata = metadataOf(target);
    metadata.prefix = prefix;
    metadata.tag = options.tag;
    metadata.token = options.token;
  };
}

/** What a schema leaves behind once it has parsed, or `unknown` without one. */
type Parsed<S> = S extends ZodType ? output<S> : unknown;

/**
 * A route handler typed by the schemas its route validates with.
 *
 * The body schema was already used three times — to validate, to document and,
 * through `z.infer`, to type the DTO — and the handler was the fourth use and
 * the only one that restated it: `req.body` is `any`, `req.validatedQuery` is
 * `unknown`, so every handler cast, and a cast is a copy that drifts the way
 * copies do. Here the handler names the schema instead of its shape:
 *
 * ```ts
 * @Post("/", { body: createPersonBody })
 * create: Handler<{ body: typeof createPersonBody }> = async (req, res) => {
 *   res.status(201).json(await this.people.create(req.body)); // CreatePerson, inferred
 * };
 * ```
 *
 * The schema is named twice because a decorator cannot give a contextual type
 * to the initializer of the property it decorates. What keeps the two names
 * honest is the verb decorator, which checks the property it lands on: a
 * handler typed against another schema than the route validates with is a
 * compile error there.
 *
 * A handler written as `(req: Request, res: Response) => ...` still satisfies
 * every `Handler<S>`, since its `Request` accepts any body.
 */
export type Handler<S extends Pick<RouteOptions, "body" | "query"> = Record<never, never>> = (
  req: Request<Request["params"], unknown, Parsed<S["body"]>> & {
    validatedQuery: Parsed<S["query"]>;
  },
  res: Response,
  next: NextFunction
) => unknown;

/**
 * A verb decorator.
 *
 * The `target` is checked, not just received: it has to carry, under the name
 * being decorated, a handler that accepts what this route validates. That is
 * what turns `Handler<{ body: typeof a }>` under `@Post("/", { body: b })` into
 * a compile error instead of a request typed as something it is not.
 *
 * The price is that the handler has to be public. A `private` one worked —
 * TypeScript's `private` is gone at runtime and the router looks the property up
 * by name — but the type of `target` cannot see it, so it no longer compiles.
 */
export type RouteDecorator = <S extends RouteOptions = RouteOptions>(
  path: string,
  options?: S
) => <K extends string>(target: { [P in K]: Handler<S> }, propertyKey: K) => void;

/**
 * Factory of the verb decorators.
 *
 * It decorates properties, not prototype methods, because controllers declare
 * their handlers as arrow functions — that is how `this` stays bound without a
 * `.bind()`. A property decorator receives the prototype and the name, which is
 * all that is needed to register.
 */
function route(method: HttpMethod): RouteDecorator {
  return (path, options) =>
    function (target, propertyKey): void {
      const constructor = (target as { constructor: object }).constructor;
      metadataOf(constructor).routes.push({
        ...options,
        method,
        path,
        handler: String(propertyKey),
      });
    };
}

export const Get = route("get");
export const Post = route("post");
export const Put = route("put");
export const Patch = route("patch");
export const Delete = route("delete");

/**
 * Joins the controller prefix with the route one.
 *
 * It lives here, and not in each constructor, so routing and documentation
 * cannot disagree: `@Get("/")` on `/users` is `/users`, not `/users/`. Express
 * treats the two as the same path, but in the OpenAPI document they would be
 * two different entries.
 */
export function joinPath(prefix: string, path: string): string {
  if (path === "" || path === "/") return prefix;
  return `${prefix}${path}`;
}

/**
 * How concrete a path segment is. The lower the number, the earlier it is tried.
 *
 * Express walks routes in registration order and keeps the first that matches,
 * so a `/:id` declared before `/stats` swallows "stats" and treats it as an id.
 */
function segmentRank(segment: string): number {
  if (segment.startsWith(":")) return 1;
  if (segment.startsWith("*") || segment.startsWith("{")) return 2;
  return 0;
}

/**
 * Orders from most concrete to most generic, comparing segment by segment.
 *
 * It replaces the previous rule — "the order is the order of the code" — which
 * worked but broke on its own: moving a method, or having a base class declare
 * `/:id`, was enough for a static route to become unreachable, and the symptom
 * was a 400 "invalid id" instead of a clear error.
 *
 * Ties keep declaration order, because `sort` is stable.
 */
export function bySpecificity(a: RouteMetadata, b: RouteMetadata): number {
  const left = a.path.split("/");
  const right = b.path.split("/");

  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = segmentRank(left[i]) - segmentRank(right[i]);
    if (difference !== 0) return difference;
  }

  return 0;
}

/**
 * The controller's routes ready to mount: sorted by specificity and with
 * duplicates caught.
 *
 * Two routes with the same verb and the same path are a mistake, not a
 * preference: Express keeps the first and the second never runs, silently. Here
 * it becomes a failure at startup.
 */
export function sortedRoutes(metadata: ControllerMetadata, controllerName: string): RouteMetadata[] {
  const routes = [...metadata.routes].sort(bySpecificity);
  const seen = new Set<string>();

  for (const route of routes) {
    const signature = `${route.method.toUpperCase()} ${joinPath(metadata.prefix, route.path)}`;
    if (seen.has(signature)) {
      throw new Error(
        `[router] ${controllerName} declares ${signature} twice. Only the first one would ever run.`
      );
    }
    seen.add(signature);
  }

  return routes;
}

/** Metadata of a decorated controller, or `null` if it is not decorated. */
export function getControllerMetadata(target: object): ControllerMetadata | null {
  const metadata = REGISTRY.get(target);
  // An empty prefix means somebody added verbs but forgot the class decorator.
  if (!metadata) return null;
  return metadata;
}

/**
 * Every registered controller, the class first.
 *
 * The registry is keyed by `object` because that is all a property decorator
 * knows about the `constructor` it is handed, but every key in it arrived from
 * decorating a class and there is no other way in. Narrowing here rather than
 * at each call site is what lets an application feed this straight back into
 * `registerController`, which is the whole point of walking the registry: the
 * OpenAPI generator only wants the metadata, but the router wants the class.
 */
export function registeredControllers(): [ControllerType, ControllerMetadata][] {
  return [...REGISTRY.entries()] as [ControllerType, ControllerMetadata][];
}
