import type { RequestHandler, Router } from "express";
import { getControllerMetadata, joinPath, registeredControllers, sortedRoutes } from "./route.decorators.js";
import { validateBody, validateQuery } from "../middlewares/validate.js";

/** A handler the controller exposes, already bound to its instance. */
type Handler = RequestHandler;

/**
 * A controller class paired with whoever actually serves it.
 *
 * The two are kept apart because the container resolves by interface, and what
 * it hands back may be the class or the double a test installed; the routes are
 * the same in both cases.
 */
export interface ControllerRegistration {
  /** The controller class, where the metadata comes from. */
  type: new (...args: never[]) => object;
  /** The object whose properties actually answer the requests. */
  instance: object;
}

/**
 * Mounts a decorated controller on a router.
 *
 * This is the only place that translates metadata into Express, so the order of
 * the chain is decided here once and holds for every module:
 *
 *   JWT guard -> validation -> the route's own middleware -> handler
 *
 * The validation goes after the guard on purpose: whoever is not authenticated
 * is not told which fields the endpoint expects.
 *
 * @param type Controller class, where the metadata comes from.
 * @param instance Whoever actually serves. It is separate from the type because
 * the container resolves by interface, and what it returns may be the class or
 * the double a test installed; the routes are the same in both cases.
 * @param guard Authentication middleware, applied to every route not marked as
 * public. It arrives as a parameter, rather than being resolved from a
 * container here, so the router can be mounted with a double.
 */
export function registerController(
  router: Router,
  type: new (...args: never[]) => object,
  instance: object,
  guard: RequestHandler
): void {
  const metadata = getControllerMetadata(type);

  if (!metadata) {
    throw new Error(
      `[router] ${type.name} is not decorated with @ApiController; with no metadata there are no routes to mount.`
    );
  }

  const controller = instance;

  for (const route of sortedRoutes(metadata, type.name)) {
    const handler = (controller as Record<string, unknown>)[route.handler];

    if (typeof handler !== "function") {
      throw new Error(
        `[router] ${type.name}.${route.handler} is decorated as ` +
          `${route.method.toUpperCase()} ${route.path} but it is not a function.`
      );
    }

    const chain: Handler[] = [];
    if (!route.public) chain.push(guard);
    if (route.body) chain.push(validateBody(route.body));
    if (route.query) chain.push(validateQuery(route.query));
    if (route.use) {
      chain.push(...(typeof route.use === "function" ? route.use(controller) : route.use));
    }

    // The handler is an instance property (an arrow function), so `this` is
    // already bound and no `.bind()` is needed.
    router[route.method](joinPath(metadata.prefix, route.path), ...chain, handler as Handler);
  }
}

/** Mounts every controller of the list on the same router, in order. */
export function registerControllers(
  router: Router,
  controllers: ControllerRegistration[],
  guard: RequestHandler
): void {
  for (const { type, instance } of controllers) {
    registerController(router, type, instance, guard);
  }
}

/**
 * Turns the global registry of decorated controllers into the list to mount,
 * asking `resolve` who serves each one.
 *
 * This is the whole of the "which modules does this API have" table: importing
 * the controller is what runs its decorators and puts it in the registry, so
 * there is nothing else to keep in sync. Everything else — routes, prefix,
 * documentation — comes from the controller itself.
 *
 * A controller with no `token` is a hard failure rather than a skip: it was
 * declared as part of the API, so silently leaving it unmounted would show up
 * much later as a 404 nobody can explain.
 */
export function controllersFromRegistry(
  resolve: (token: string) => object
): ControllerRegistration[] {
  return registeredControllers().map(([type, metadata]) => {
    if (!metadata.token) {
      throw new Error(
        `[router] ${(type as { name?: string }).name ?? "A controller"} is decorated with ` +
          "@ApiController but declares no `token`, so there is no way to know who should serve it."
      );
    }

    return {
      type: type as new (...args: never[]) => object,
      instance: resolve(metadata.token),
    };
  });
}
