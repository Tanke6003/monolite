import { Router } from "express";
import { container } from "tsyringe";
import { registerController, registeredControllers } from "@monolite/http";
// #if auth
import { auth } from "../composition/container";
// #endif

// Importing a controller is what runs its decorators and puts it in the
// registry. This is the only list left —one line per module— and it cannot be
// avoided without scanning the disk at runtime, which would cost more than it
// saves. Everything else (paths, verbs, validation, documentation) comes from
// the controller itself.
// #if example
import "./controllers/product.controller";
// #endif

/**
 * Walks the registry of decorated controllers and mounts every one of them.
 *
 * There is not a single route written here and no table of modules to keep in
 * sync: the class contributes its routes and its token, and the container says
 * who serves them — the real implementation, or whatever double a test put in
 * its place.
 */
export function registerRoutes(): Router {
  const router = Router();

  for (const [type, metadata] of registeredControllers()) {
    if (!metadata.token) {
      throw new Error(
        `[routes] ${(type as { name?: string }).name ?? "A controller"} is decorated with ` +
          "@ApiController but declares no `token`, so nothing knows who should serve it."
      );
    }

    // #if auth
    // Every route is behind the guard unless its decorator marked it `public`.
    // If leaving one open is going to be an oversight, let the oversight be
    // closing it rather than the other way round.
    registerController(router, type, container.resolve(metadata.token), auth.guard);
    // #else
    registerController(router, type, container.resolve(metadata.token));
    // #endif
  }

  return router;
}
