import type { RequestHandler } from "express";
import { ApiController, Post, type Handler } from "monolite-http";
import { z } from "zod";
import { verifiedClaims } from "./auth.middleware.js";
import type { IAuthBLL } from "./contracts.js";
import { AUTH_TOKENS } from "./tokens.js";

/** The body of `POST /auth/login`. Exported so an app can reuse or extend it. */
export const loginSchema = z.object({
  email: z.email().meta({ examples: ["ana@example.com"] }),
  password: z.string().min(1, "The password is required"),
});

/**
 * The response, described as a schema rather than as a `ref` to a component.
 *
 * A `ref` would oblige every application to register an `AuthResult` component
 * of its own before this package's documentation made sense. Declared here, the
 * endpoint documents itself the moment it is mounted.
 */
export const authResultSchema = z.object({
  token: z.string(),
  expiresIn: z.number().int().meta({ examples: [3600] }),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    roles: z.array(z.string()),
  }),
});

/**
 * The HTTP face of `AuthBLL`: signing in and signing out, and everything they
 * need to be documented and validated.
 *
 * There is no `POST /auth/refresh`. Refreshing honestly means a second,
 * longer-lived credential that is stored, rotated on every use and revocable —
 * without the store there is nothing to revoke, and an endpoint that simply
 * re-signs a still-valid access token does not extend a session so much as
 * remove the expiry that was the point of having one. That store is a decision
 * about the application's persistence, so it does not belong to a package that
 * refuses to know how anything is stored. Better absent than pretended.
 */
// The token is declared here, and not left to the application, because a router
// that mounts every decorated controller it finds resolves each one by the
// token on its metadata. Without it this controller is discovered and then
// cannot be served.
@ApiController("/auth", { tag: "Auth", token: AUTH_TOKENS.IAuthController })
export class AuthController {
  /**
   * Extra middleware for the login route — a rate limiter, in practice.
   *
   * It is taken as a constructor parameter, and not built here, because the
   * limiter is configured per environment and this package will not choose an
   * implementation on the application's behalf. Passing none is allowed and
   * leaves the route unthrottled, which is worth saying out loud: login is the
   * one endpoint where an attacker's plan is simply to call it a great many
   * times, and hashing on purpose makes each of those calls expensive for the
   * server too.
   */
  constructor(
    private readonly auth: IAuthBLL,
    private readonly guards: RequestHandler[] = []
  ) {}

  /** Read by the router while mounting; see `use` below. */
  public get loginGuards(): RequestHandler[] {
    return this.guards;
  }

  @Post("/login", {
    summary: "Signs in with email and password",
    description:
      "Returns a signed token and the identity behind it. A wrong password and an unknown " +
      "email produce the same answer, on purpose.",
    public: true,
    body: loginSchema,
    // The guards are requested through a function because the decorator runs
    // when the class is loaded, before the instance that was built with them
    // exists.
    use: (controller) => (controller as AuthController).loginGuards,
    responses: {
      200: { description: "Signed in", schema: authResultSchema },
      400: "Validation error",
      401: "Invalid email or password",
      429: "Too many attempts",
    },
  })
  public login: Handler<{ body: typeof loginSchema }> = async (req, res, next) => {
    try {
      res.json(await this.auth.login(req.body));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Not public: the token being withdrawn is the one that authenticates the
   * request, so the guard has already verified it — and refused it if it was
   * revoked before, which makes a second sign-out a 401 rather than a 204.
   */
  @Post("/logout", {
    summary: "Signs out",
    description:
      "Revokes the token this request carries, so it stops being accepted before it expires.",
    responses: {
      204: "Signed out",
      400: "The token carries no id to revoke it by",
      401: "No valid token",
      501: "Revocation is not configured",
      503: "The revocation store cannot be reached",
    },
  })
  public logout: Handler = async (req, res, next) => {
    try {
      await this.auth.logout(verifiedClaims(req) ?? {});
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  };
}
