/**
 * The HTTP face of `AuthBLL`: one route, mounted the way the router mounts
 * it, with the schemas that both validate it and describe it.
 *
 * There is no `POST /auth/refresh` to test. Refreshing honestly means a second,
 * longer-lived credential that is stored, rotated on every use and revocable;
 * without the store there is nothing to revoke, and an endpoint that re-signs a
 * still-valid access token removes the expiry rather than extending the
 * session. That store is a decision about persistence, so it does not belong to
 * a package that refuses to know how anything is stored.
 */
import express, { type Express, type RequestHandler } from "express";
import { AppError, MemoryCache } from "monolite-core";
import { errorHandler, getControllerMetadata, registerController } from "monolite-http";
import {
  AuthBLL,
  AuthController,
  CacheTokenRevocation,
  JwtTokenBLL,
  authResultSchema,
  loginSchema,
  requireAuth,
  type IAuthBLL,
  type IPasswordHasher,
  type IUserProvider,
} from "monolite-auth";
import { serve, type ServedApp } from "./support/http-client.js";

const result = {
  token: "signed-token",
  expiresIn: 3600,
  user: { id: "7", name: "Ana", email: "ana@example.com", roles: ["admin"] },
};

const refuseEveryone: RequestHandler = (_req, _res, next) =>
  next(new AppError("No token provided", 401, true, { code: "NO_TOKEN" }));

// By default the guard would turn every request away; the login route is
// public, so it is never reached — which is itself part of what is checked.
const buildApp = (controller: AuthController, guard: RequestHandler = refuseEveryone): Express => {
  const app = express();
  app.use(express.json());

  const router = express.Router();
  registerController(router, AuthController, controller, guard);
  app.use(router);
  app.use(errorHandler());

  return app;
};

describe("AuthController", () => {
  let auth: jest.Mocked<IAuthBLL>;
  let served: ServedApp;

  beforeEach(async () => {
    auth = { login: jest.fn().mockResolvedValue(result) } as unknown as jest.Mocked<IAuthBLL>;
    served = await serve(buildApp(new AuthController(auth)));
  });

  afterEach(() => served.close());

  it("signs in and answers with the token and the identity", async () => {
    const res = await served.client.post("/auth/login", {
      body: { email: "ana@example.com", password: "right" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(auth.login).toHaveBeenCalledWith({ email: "ana@example.com", password: "right" });
  });

  it("is public: signing in cannot require being signed in", () => {
    const route = getControllerMetadata(AuthController)!.routes.find(
      (candidate) => candidate.handler === "login"
    )!;

    expect(route).toMatchObject({ method: "post", path: "/login", public: true });
  });

  it("rejects a body that is not a pair of credentials, before the service", async () => {
    const res = await served.client.post("/auth/login", { body: { email: "not-an-email" } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(auth.login).not.toHaveBeenCalled();
  });

  it("hands a refused login to the global handler unchanged", async () => {
    // The service decides what a failed login says; the controller does not
    // reinterpret it, so the 401 stays the single indistinguishable answer.
    auth.login.mockRejectedValue(
      new AppError("Invalid email or password", 401, true, { code: "INVALID_CREDENTIALS" })
    );

    const res = await served.client.post("/auth/login", {
      body: { email: "ana@example.com", password: "wrong" },
    });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  /**
   * Login is the one endpoint whose attack is simply calling it a great many
   * times, and hashing on purpose makes each of those calls expensive for the
   * server too. The limiter is a constructor parameter because it is configured
   * per environment and this package will not choose one for the application.
   */
  it("runs the guards it was constructed with on the login route", async () => {
    const seen: string[] = [];
    const limiter: RequestHandler = (_req, _res, next) => {
      seen.push("limiter");
      next();
    };

    const throttled = await serve(buildApp(new AuthController(auth, [limiter])));

    try {
      await throttled.client.post("/auth/login", {
        body: { email: "ana@example.com", password: "right" },
      });

      expect(seen).toEqual(["limiter"]);
    } finally {
      await throttled.close();
    }
  });

  it("leaves the route unthrottled when none is supplied", async () => {
    expect(new AuthController(auth).loginGuards).toEqual([]);
  });

  describe("the schemas it publishes", () => {
    it("demands an address and a password that is not empty", () => {
      expect(loginSchema.safeParse({ email: "ana@example.com", password: "x" }).success).toBe(true);
      expect(loginSchema.safeParse({ email: "ana@example.com", password: "" }).success).toBe(false);
      expect(loginSchema.safeParse({ email: "nope", password: "x" }).success).toBe(false);
    });

    /**
     * The response is described as a schema rather than as a `ref`. A `ref`
     * would oblige every application to register an `AuthResult` component of
     * its own before this package's documentation made any sense.
     */
    it("describes its own answer", () => {
      expect(authResultSchema.safeParse(result).success).toBe(true);
    });
  });

  it("is not public: signing out needs the token being withdrawn", () => {
    const route = getControllerMetadata(AuthController)!.routes.find(
      (candidate) => candidate.handler === "logout"
    )!;

    expect(route).toMatchObject({ method: "post", path: "/logout" });
    expect(route.public).toBeFalsy();
  });

  it("does not reach the service without a token", async () => {
    auth.logout = jest.fn();

    const res = await served.client.post("/auth/logout");

    expect(res.status).toBe(401);
    expect(auth.logout).not.toHaveBeenCalled();
  });
});

/**
 * The whole loop on real parts — the token BLL, the denylist on the in-memory
 * cache, the guard reading it — because each half passing its own tests says
 * nothing about whether they agree on a key.
 */
describe("signing out, end to end", () => {
  let served: ServedApp;
  let token: string;

  beforeEach(async () => {
    const tokens = new JwtTokenBLL({ secret: "controller-test-secret" });
    const revocation = new CacheTokenRevocation(new MemoryCache());
    const users = { findByEmail: async () => null } as IUserProvider;
    const hasher = { hash: async () => "", verify: async () => false } as IPasswordHasher;
    const auth = new AuthBLL(users, hasher, tokens, { revocation });

    token = tokens.sign({ sub: "7" }).token;
    served = await serve(
      buildApp(new AuthController(auth), requireAuth(tokens, { revocation }))
    );
  });

  afterEach(() => served.close());

  it("answers 204, and the same token is refused afterwards", async () => {
    const headers = { authorization: `Bearer ${token}` };

    const first = await served.client.post("/auth/logout", { headers });
    const second = await served.client.post("/auth/logout", { headers });

    expect(first.status).toBe(204);
    expect(second.status).toBe(401);
    expect(second.body).toMatchObject({ code: "TOKEN_REVOKED" });
  });
});
