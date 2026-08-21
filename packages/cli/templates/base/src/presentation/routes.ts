import { Router } from "express";
// #if !auth
import type { RequestHandler } from "express";
// #endif
// #if auth
import { AUTH_TOKENS, requireAuth } from "monolite-auth";
import type { ITokenService } from "monolite-auth";
// #endif
import { registerController, registeredControllers } from "monolite-http";
import { container } from "../composition/container";

// There is no list of controllers here any more. A controller is registered by
// its decorator, and its decorator runs when the class is loaded — which the
// module descriptor in `composition/modules.ts` takes care of by holding the
// class. Everything else (paths, verbs, validation, documentation) comes from
// the controller itself.

// #if !auth
/**
 * Stands in for the authentication guard in a project generated without it.
 *
 * The router asks for one because the decision of which routes are public is
 * the controller's —`public: true` on the route— and a mounting that could
 * silently skip the guard would make that decision meaningless. With no
 * authentication in the project every route is open anyway, and this states it
 * in one place instead of leaving it implied.
 */
const openToEveryone: RequestHandler = (_req, _res, next) => {
  next();
};
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

  // #if auth
  // Every route is behind the guard unless its decorator marked it `public`. If
  // leaving one open is going to be an oversight, let the oversight be closing
  // it rather than the other way round.
  const guard = requireAuth(container.resolve<ITokenService>(AUTH_TOKENS.ITokenService));
  // #else
  const guard = openToEveryone;
  // #endif

  for (const [type, metadata] of registeredControllers()) {
    if (!metadata.token) {
      throw new Error(
        `[routes] ${(type as { name?: string }).name ?? "A controller"} is decorated with ` +
          "@ApiController but declares no `token`, so nothing knows who should serve it."
      );
    }

    registerController(router, type, container.resolve(metadata.token), guard);
  }

  return router;
}
