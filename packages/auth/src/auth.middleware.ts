import type { Request, RequestHandler } from "express";
import { AppError, type CurrentUser, type IRequestContext } from "@monolite/core";
import { toCurrentUser as defaultToCurrentUser } from "@monolite/http";
import type { ITokenService, TokenClaims } from "./contracts.js";

/**
 * Where the verified identity is parked on the request.
 *
 * A symbol, so it cannot collide with a property some other middleware decides
 * to attach, and `Symbol.for` rather than `Symbol()` so two copies of this
 * package in the same process — the hazard of any transitive dependency — still
 * read each other's identity instead of each seeing an unauthenticated request.
 */
const AUTHENTICATED_USER: unique symbol = Symbol.for("monolite.auth.currentUser");

/**
 * What this middleware writes onto the request.
 *
 * `@monolite/http` declares `user` on Express's `Request` by declaration
 * merging, and its comment names this guard as the thing that fills it. That
 * declaration is global, though, and it is not reachable from the package's
 * entry point, so it only exists for a build that happens to include the file.
 * Going through an intersection means the property is written the same way
 * either way, and the middleware still compiles for an application that never
 * pulls the augmentation in.
 */
type AuthenticatedRequest = Request & {
  user?: string | Record<string, unknown>;
  [AUTHENTICATED_USER]?: CurrentUser | null;
};

export interface RequireAuthOptions {
  /**
   * Request context to publish the identity into, so that the audit columns and
   * `BaseController.currentUser` see it.
   *
   * Optional on purpose: the middleware stays usable as a plain gate — in a
   * test, in a script, in an app that never opened a request context — and
   * `requireRoles` keeps working either way, because the identity is also
   * parked on the request itself.
   */
  context?: IRequestContext;

  /**
   * Claim mapping for an issuer this toolkit does not recognise.
   *
   * The default is `toCurrentUser` from `@monolite/http`, which already knows
   * the names the usual providers emit (OIDC, Azure AD / ADFS) and is the very
   * function the request context is built around. Replacing the mapping here
   * rather than growing those lists keeps one odd issuer from becoming a claim
   * name every application in the toolkit has to carry.
   */
  toCurrentUser?: (claims: TokenClaims) => CurrentUser | null;
}

/**
 * Every rejection is an `AppError`.
 *
 * The kernel's error mapper already knows how to read `jsonwebtoken`'s errors,
 * but letting them travel raw would tie the shape of a 401 to which library
 * happens to be behind `ITokenService`. Translating here means an application
 * with opaque tokens produces exactly the same response. The expired/invalid
 * distinction survives the translation because clients branch on it: expired
 * means "renew", invalid means "sign in again".
 */
function unauthorized(error: unknown): AppError {
  const name = error instanceof Error ? error.name : "";

  if (name === "TokenExpiredError") {
    return new AppError("The token has expired", 401, true, {
      code: "TOKEN_EXPIRED",
      cause: error,
    });
  }

  return new AppError("The token is not valid", 401, true, {
    code: "INVALID_TOKEN",
    cause: error,
  });
}

/**
 * Guards a route: no valid `Authorization: Bearer` header, no entry.
 *
 * On success it publishes the identity twice over — on the request, where
 * `requireRoles` and `authenticatedUser` find it, and into the request context
 * if one was supplied, which is what lets a service three layers down know who
 * is asking without the identity being threaded through every signature.
 *
 * A token that verifies but carries no identifiable claims is still allowed
 * through: it *is* authentic, and refusing it here would be authorisation
 * dressed up as authentication. It arrives with no user, so `requireRoles` and
 * `BaseController.requireUserId()` turn it away where that decision belongs.
 */
export function requireAuth(
  tokenService: ITokenService,
  options: RequireAuthOptions = {}
): RequestHandler {
  const toCurrentUser = options.toCurrentUser ?? defaultToCurrentUser;

  return (req, _res, next): void => {
    const header = req.headers.authorization;

    // Rejections go through `next` and the global handler so that a 401 carries
    // the same shape — code, request id — as every other error in the API.
    if (!header) {
      next(new AppError("No token provided", 401, true, { code: "NO_TOKEN" }));
      return;
    }

    const [scheme, token, ...rest] = header.split(" ");

    // The scheme is case-insensitive per RFC 7235, and clients do send
    // "bearer". Anything after the token is not part of the credential.
    if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) {
      next(new AppError("Invalid token format", 401, true, { code: "INVALID_TOKEN_FORMAT" }));
      return;
    }

    let claims: TokenClaims;
    try {
      claims = tokenService.verify(token);
    } catch (error) {
      next(unauthorized(error));
      return;
    }

    const request = req as AuthenticatedRequest;
    request.user = claims;
    request[AUTHENTICATED_USER] = toCurrentUser(claims);

    // The store is mutated rather than replaced so the request id opened by the
    // context middleware survives: this is one step inside that request, not a
    // new one.
    const store = options.context?.get();
    if (store) store.user = request[AUTHENTICATED_USER] ?? null;

    next();
  };
}

/**
 * The identity `requireAuth` resolved for this request, or `null` when the
 * route was not guarded or the token named nobody.
 */
export function authenticatedUser(req: Request): CurrentUser | null {
  return (req as AuthenticatedRequest)[AUTHENTICATED_USER] ?? null;
}

/**
 * Demands at least one of the listed roles. Goes after `requireAuth`.
 *
 * **Any of them, not all.** This is the behaviour of `[Authorize(Roles = ...)]`
 * in ASP.NET, and it is the one that matches how the check is usually read out
 * loud: "admins or auditors may see this". To demand several at once, chain the
 * middleware — `requireRoles("admin"), requireRoles("billing")` — which says
 * "and" without a second parameter to get backwards.
 *
 * With no roles listed it degrades to "must be someone", which is the useful
 * answer for a route that only needs an identified caller.
 */
export function requireRoles(...roles: string[]): RequestHandler {
  return (req, _res, next): void => {
    const user = authenticatedUser(req);

    // 401 and not 403: nobody has been identified yet, so the caller may still
    // fix this by presenting a token. 403 would mean "we know who you are and
    // the answer is no", which is a different instruction to the client.
    if (!user) {
      next(
        new AppError("No authenticated user in the request", 401, true, {
          code: "NO_AUTHENTICATED_USER",
        })
      );
      return;
    }

    if (roles.length === 0) {
      next();
      return;
    }

    const granted = new Set(user.roles);
    if (!roles.some((role) => granted.has(role))) {
      // The message does not name the roles that were required. Which roles
      // exist is information about the system, and the caller cannot act on it
      // anyway — the answer would be the same however the request were retried.
      next(
        new AppError("You do not have permission to perform this action", 403, true, {
          code: "FORBIDDEN",
        })
      );
      return;
    }

    next();
  };
}
