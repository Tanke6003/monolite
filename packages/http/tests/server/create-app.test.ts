/**
 * `createApp` assembles the Express application, and the order of the chain is
 * half of what it does: each piece assumes the previous ones already ran, and
 * moving one leaves it without effect rather than breaking loudly.
 *
 * The original suite tested a `Server` class that resolved its controllers from
 * a tsyringe container and owned the documentation, the token plugin and the
 * module list. None of that survives: the controllers, the logger, the context,
 * the guard and the health probe arrive as parameters, and the documentation is
 * whatever the caller mounts in `afterRoutes`. The behaviours are the same ones
 * — middleware order, health, docs gating, error handling registered last,
 * graceful shutdown — asked of the new shape.
 */
import path from "node:path";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import {
  AppError,
  AsyncRequestContext,
  type HealthReport,
  type IHealthProbe,
  type ILogger,
  type IRequestContext,
} from "@monolite/core";
import {
  ApiController,
  Get,
  Post,
  REQUEST_ID_HEADER,
  areDocsEnabled,
  createApp,
  type CreateAppOptions,
  type EnvSource,
  type HttpApp,
} from "@monolite/http";
import { httpClient, type TestClient } from "../support/http-client.js";

const envsOf = (values: Record<string, string> = {}): EnvSource => ({
  getEnv: (key: string) => values[key] ?? "",
});

type Logger = ILogger & Record<"info" | "warn" | "error" | "debug" | "log", jest.Mock>;

const makeLogger = (): Logger => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  log: jest.fn(),
});

/** A guard that only lets a request through when it carries the header. */
const guard: RequestHandler = (req, _res, next) => {
  if (req.headers.authorization) {
    next();
    return;
  }
  next(new AppError("No token provided", 401, true, { code: "NO_TOKEN" }));
};

const healthy: HealthReport = {
  ready: true,
  dataSource: "memory",
  database: "not_applicable",
  shuttingDown: false,
};

@ApiController("/users", { tag: "Users" })
class UsersController {
  @Get("/", { summary: "List", query: z.object({ page: z.coerce.number().optional() }) })
  public list = (_req: Request, res: Response) => res.json({ data: [] });

  @Get("/open", { summary: "Anonymous", public: true })
  public open = (_req: Request, res: Response) => res.json({ ok: "open" });

  @Post("/", { summary: "Create", body: z.object({ name: z.string().min(1) }) })
  public create = (req: Request, res: Response) => res.status(201).json(req.body);

  @Get("/boom", { summary: "Fails on purpose" })
  public boom = (): void => {
    throw new AppError("That slot is taken", 409, true, { code: "APPOINTMENT_OVERLAP" });
  };
}

interface Started {
  http: HttpApp;
  client: TestClient;
  logger: Logger;
  context: IRequestContext;
  close(): Promise<void>;
}

/** Builds the application and puts it on a free port. */
async function start(options: Partial<CreateAppOptions> = {}): Promise<Started> {
  const logger = options.logger ? (options.logger as Logger) : makeLogger();
  const context = options.context ?? new AsyncRequestContext();

  const http = await createApp({
    envs: envsOf(),
    guard,
    controllers: [{ type: UsersController, instance: new UsersController() }],
    ...options,
    logger,
    context,
  });

  const { port } = await http.listen(0);

  return {
    http,
    logger,
    context,
    client: httpClient(`http://127.0.0.1:${port}`),
    close: () => http.close(),
  };
}

/** Anything the guard would otherwise turn away needs this. */
const authed = { authorization: "Bearer test" };

describe("the middleware chain", () => {
  let app: Started;

  beforeAll(async () => {
    app = await start({ healthProbe: { report: async () => healthy, beginShutdown: jest.fn() } });
  });

  afterAll(() => app.close());

  it("applies the helmet headers and hides the framework", () => {
    // Naming the framework adds nothing and does point whoever is looking for a
    // known vulnerability in the right direction.
    return app.client.get("/health/live").then((res) => {
      expect(res.headers["x-powered-by"]).toBeUndefined();
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      // Off by default: helmet's own CSP breaks Swagger and Scalar at once.
      expect(res.headers["content-security-policy"]).toBeUndefined();
    });
  });

  it("opens the request context first, so every answer carries an id", async () => {
    const res = await app.client.get("/health/live");

    expect(res.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
  });

  it("honours an id that arrived from a proxy", async () => {
    const res = await app.client.get("/health/live", {
      headers: { [REQUEST_ID_HEADER]: "trace-42" },
    });

    expect(res.headers[REQUEST_ID_HEADER]).toBe("trace-42");
  });

  it("advertises the rate limit, and spends no quota on the health checks", async () => {
    const api = await app.client.get("/api/v1/users", { headers: authed });

    expect(api.headers["ratelimit"]).toBeDefined();
    // A load balancer probing every few seconds must not exhaust the quota of
    // its own address, so the health routes sit outside the limiter entirely.
    expect((await app.client.get("/health/live")).headers["ratelimit"]).toBeUndefined();
  });

  /**
   * The context is opened *before* the body is parsed, which is what lets a
   * request that never reached a route still answer with its request id.
   */
  it("rejects malformed JSON with the API's own error shape", async () => {
    const res = await app.client.post("/api/v1/users", {
      headers: { ...authed, "content-type": "application/json" },
      body: "{ not json",
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: "error", code: "MALFORMED_JSON" });
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("writes one access log record per finished request, at a level picked from the status", async () => {
    app.logger.info.mockClear();
    app.logger.warn.mockClear();

    await app.client.get("/api/v1/users/open");
    expect(app.logger.info).toHaveBeenCalledWith(
      "http_access",
      expect.objectContaining({ status: 200, method: "GET", endpoint: "/api/v1/users/open" })
    );

    await app.client.get("/api/v1/nowhere");
    expect(app.logger.warn).toHaveBeenCalledWith(
      "http_access",
      expect.objectContaining({ status: 404 })
    );
  });
});

describe("security policy", () => {
  it("rejects an origin outside the allow-list with the API error format", async () => {
    const app = await start({
      envs: envsOf({ CORS_ORIGINS: "https://app.mydomain.com,http://localhost:5173" }),
      healthProbe: { report: async () => healthy, beginShutdown: jest.fn() },
    });

    try {
      const allowed = await app.client.get("/health/live", {
        headers: { origin: "http://localhost:5173" },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

      const blocked = await app.client.get("/health/live", {
        headers: { origin: "http://evil.test" },
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({ status: "error", code: "CORS_ORIGIN_NOT_ALLOWED" });
      expect(blocked.body.requestId).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });

  it("rejects a body over the configured limit with a 413", async () => {
    const app = await start({ envs: envsOf({ BODY_LIMIT: "1kb" }) });

    try {
      const res = await app.client.post("/api/v1/users", {
        headers: authed,
        body: { name: "x".repeat(4096) },
      });

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ status: "error", code: "PAYLOAD_TOO_LARGE" });
    } finally {
      await app.close();
    }
  });

  it("answers a throttled request with the API error format", async () => {
    // The 429 travels through `next(AppError)` like everything else, so it
    // comes out with its code, its request id and its timestamp. The
    // `RateLimit-*` headers are the library's own.
    const app = await start({ envs: envsOf({ RATE_LIMIT_MAX: "1" }) });

    try {
      expect((await app.client.get("/api/v1/users/open")).status).toBe(200);

      const throttled = await app.client.get("/api/v1/users/open");

      expect(throttled.status).toBe(429);
      expect(throttled.body).toMatchObject({ status: "error", code: "RATE_LIMITED" });
      expect(throttled.body.requestId).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });

  it("turns the CSP on with the directives it was given", async () => {
    const app = await start({
      envs: envsOf({ CSP_ENABLED: "true" }),
      cspDirectives: { "default-src": ["'none'"] },
    });

    try {
      const policy = (await app.client.get("/api/v1/users/open")).headers[
        "content-security-policy"
      ];

      // Only the named directive is replaced: helmet keeps its own defaults for
      // everything the application did not speak about, so narrowing one source
      // does not quietly open the rest.
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("object-src 'none'");
    } finally {
      await app.close();
    }
  });
});

describe("routes", () => {
  let app: Started;

  beforeAll(async () => {
    app = await start();
  });

  afterAll(() => app.close());

  it("mounts the controllers under the configured prefix", async () => {
    const res = await app.client.get("/api/v1/users", { headers: authed });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  it("serves the same routes under the unversioned alias", async () => {
    // It exists so callers already hitting `/api/...` do not break.
    expect((await app.client.get("/api/users", { headers: authed })).status).toBe(200);
  });

  it("applies the guard to everything not marked public", async () => {
    const res = await app.client.get("/api/v1/users");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "NO_TOKEN" });
  });

  it("leaves a public route open", async () => {
    expect((await app.client.get("/api/v1/users/open")).status).toBe(200);
  });

  it("moves the whole API when the prefix says so", async () => {
    const moved = await start({
      envs: envsOf({ API_PREFIX: "/appointments-service/api/v1", API_LEGACY_PREFIX: "off" }),
    });

    try {
      expect(
        (await moved.client.get("/appointments-service/api/v1/users/open")).status
      ).toBe(200);
      // The alias was switched off, so nothing answers there any more.
      expect((await moved.client.get("/api/users/open")).status).toBe(404);
    } finally {
      await moved.close();
    }
  });

  it("reads process.env when it is given no configuration source", async () => {
    // The package is usable before an application has decided how it wants to
    // load configuration.
    const plain = await createApp({
      logger: makeLogger(),
      context: new AsyncRequestContext(),
      guard,
      controllers: [{ type: UsersController, instance: new UsersController() }],
    });

    const { port } = await plain.listen(0);
    const client = httpClient(`http://127.0.0.1:${port}`);

    try {
      expect((await client.get("/api/v1/users/open")).status).toBe(200);
    } finally {
      await plain.close();
    }
  });

  it("stands up with no controllers at all", async () => {
    const bare = await start({ controllers: [] });

    try {
      const res = await bare.client.get("/api/v1/users");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "ROUTE_NOT_FOUND" });
    } finally {
      await bare.close();
    }
  });
});

describe("health", () => {
  const probeOf = (report: HealthReport): IHealthProbe & { report: jest.Mock } => ({
    report: jest.fn().mockResolvedValue(report),
    beginShutdown: jest.fn(),
  });

  it("keeps /health/live up even when the database is down", async () => {
    const probe = probeOf({ ...healthy, ready: false, database: "down" });
    const app = await start({ healthProbe: probe });

    try {
      // Liveness never touches the database: restarting the process does not
      // fix somebody else's database, so this probe must not provoke one.
      const res = await app.client.get("/health/live");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "ok" });
      expect(probe.report).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("answers 503 on /health/ready when the database is down", async () => {
    const app = await start({
      healthProbe: probeOf({
        ready: false,
        dataSource: "postgres",
        database: "down",
        shuttingDown: false,
      }),
    });

    try {
      const res = await app.client.get("/health/ready");

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        status: "degraded",
        database: "down",
        dataSource: "postgres",
      });
    } finally {
      await app.close();
    }
  });

  it("answers 503 while draining, and /health is the same check", async () => {
    const app = await start({
      healthProbe: probeOf({ ...healthy, ready: false, shuttingDown: true }),
    });

    try {
      for (const route of ["/health", "/health/ready"]) {
        const res = await app.client.get(route);
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ status: "shutting_down" });
      }
    } finally {
      await app.close();
    }
  });

  it("reports ok, and where the API is mounted, when everything is up", async () => {
    const app = await start({ healthProbe: probeOf(healthy) });

    try {
      const res = await app.client.get("/health");

      expect(res.status).toBe(200);
      // The prefix is configurable, so a client discovers it here instead of
      // assuming it.
      expect(res.body).toMatchObject({
        status: "ok",
        database: "not_applicable",
        apiPrefix: "/api/v1",
      });
    } finally {
      await app.close();
    }
  });

  it("publishes only liveness when there is no probe to ask", async () => {
    const app = await start();

    try {
      expect((await app.client.get("/health/live")).status).toBe(200);
      // An application with no data source has nothing to check, so readiness
      // simply does not exist rather than answering a made-up "ok".
      expect((await app.client.get("/health/ready")).body).toMatchObject({
        code: "ROUTE_NOT_FOUND",
      });
    } finally {
      await app.close();
    }
  });
});

describe("the hooks around the routes", () => {
  it("runs beforeRoutes before the controllers", async () => {
    const app = await start({
      beforeRoutes: (express) => {
        express.use("/api/v1/users", (_req, res) => res.json({ who: "intercepted" }));
      },
    });

    try {
      // Anything that has to see every request goes here, and it really does
      // come first.
      expect((await app.client.get("/api/v1/users/open")).body).toEqual({ who: "intercepted" });
    } finally {
      await app.close();
    }
  });

  /**
   * This is where the documentation goes. It has to run after the controllers
   * and before the 404, and the 404 is registered by `createApp` itself — so if
   * the hook ran anywhere else the docs would answer "route not found".
   */
  it("runs afterRoutes where the documentation can still be mounted", async () => {
    const envs = envsOf({ NODE_ENV: "development" });
    const app = await start({
      envs,
      afterRoutes: (express) => {
        if (!areDocsEnabled(envs)) return;
        express.get("/api/openapi.json", (_req, res) => res.json({ openapi: "3.1.0" }));
      },
    });

    try {
      const res = await app.client.get("/api/openapi.json");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ openapi: "3.1.0" });
    } finally {
      await app.close();
    }
  });

  it("publishes no documentation in production, and the 404 says so in the API's shape", async () => {
    // The default is not about hiding the endpoints — anyone can find those —
    // but the input schemas, which are a map of what to poke at.
    const envs = envsOf({ NODE_ENV: "production" });
    const app = await start({
      envs,
      afterRoutes: (express) => {
        if (!areDocsEnabled(envs)) return;
        express.get("/api/openapi.json", (_req, res) => res.json({ openapi: "3.1.0" }));
      },
    });

    try {
      const res = await app.client.get("/api/openapi.json");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ status: "error", code: "ROUTE_NOT_FOUND" });
    } finally {
      await app.close();
    }
  });

  it("waits for an asynchronous hook before mounting anything after it", async () => {
    const order: string[] = [];

    const app = await start({
      beforeRoutes: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("before");
      },
      afterRoutes: () => {
        order.push("after");
      },
    });

    try {
      expect(order).toEqual(["before", "after"]);
    } finally {
      await app.close();
    }
  });
});

describe("error handling", () => {
  let app: Started;

  beforeAll(async () => {
    app = await start();
  });

  afterAll(() => app.close());

  it("is registered last, so it covers the controllers", async () => {
    const res = await app.client.get("/api/v1/users/boom", { headers: authed });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      status: "error",
      code: "APPOINTMENT_OVERLAP",
      message: "That slot is taken",
      path: "/api/v1/users/boom",
      method: "GET",
    });
  });

  it("answers an unknown route with the same shape as everything else", async () => {
    const res = await app.client.get("/api/v1/nowhere");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: "error", code: "ROUTE_NOT_FOUND" });
  });

  it("rejects an invalid body before the handler sees it", async () => {
    const res = await app.client.post("/api/v1/users", { headers: authed, body: { name: "" } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("records the failure with the id the client was given", async () => {
    app.logger.warn.mockClear();

    const res = await app.client.get("/api/v1/users/boom", { headers: authed });

    expect(app.logger.warn).toHaveBeenCalledWith(
      "Request rejected",
      expect.objectContaining({ requestId: res.body.requestId, code: "APPOINTMENT_OVERLAP" })
    );
  });
});

describe("static files", () => {
  it("serves the configured directory", async () => {
    // Served before the routes, so an asset never has to travel through the
    // guard or the limiter.
    const app = await start({ staticDir: __dirname });

    try {
      const res = await app.client.get(`/${path.basename(__filename)}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain("serves the configured directory");
    } finally {
      await app.close();
    }
  });
});

describe("lifecycle", () => {
  it("reports the address it actually bound to", async () => {
    const app = await start();

    try {
      expect(app.http.address?.port).toEqual(expect.any(Number));
      expect(app.logger.info).toHaveBeenCalledWith(
        "HTTP server listening",
        expect.objectContaining({ api: "/api/v1", health: "/health/ready" })
      );
    } finally {
      await app.close();
    }
  });

  it("has no address before it listens", async () => {
    const http = await createApp({
      envs: envsOf(),
      logger: makeLogger(),
      context: new AsyncRequestContext(),
      guard,
    });

    expect(http.address).toBeNull();
  });

  it("close() is a no-op when it never listened", async () => {
    const http = await createApp({
      envs: envsOf(),
      logger: makeLogger(),
      context: new AsyncRequestContext(),
      guard,
    });

    await expect(http.close()).resolves.toBeUndefined();
  });

  it("close() is idempotent", async () => {
    const app = await start();

    await expect(app.http.close()).resolves.toBeUndefined();
    await expect(app.http.close()).resolves.toBeUndefined();
  });

  /**
   * `listening` and `error` race. Binding to a port already in use emits the
   * second and the first never arrives, so waiting only for `listening` would
   * hang forever on the single most common startup failure.
   */
  it("rejects rather than hangs when the port is taken", async () => {
    const first = await start();
    const port = first.http.address!.port;

    const second = await createApp({
      envs: envsOf(),
      logger: makeLogger(),
      context: new AsyncRequestContext(),
      guard,
    });

    try {
      await expect(second.listen(port)).rejects.toThrow(/EADDRINUSE|EACCES/);
      // `second` is deliberately not closed: it never bound, so there is
      // nothing to close — and `close()` after a failed `listen()` currently
      // rejects with ERR_SERVER_NOT_RUNNING rather than being the no-op it is
      // for an app that never listened at all.
    } finally {
      await first.close();
    }
  });

  it("drains on close: the request in flight finishes and new ones are refused", async () => {
    // A slow controller is the only way to have something genuinely in flight
    // when the close happens — it is exactly the request that used to be cut
    // mid-response on every deploy.
    @ApiController("/slow")
    class SlowController {
      @Get("/", { public: true })
      public list = (_req: Request, res: Response) => {
        setTimeout(() => res.json({ ok: true }), 150);
      };
    }

    const app = await start({
      controllers: [{ type: SlowController, instance: new SlowController() }],
    });

    const inFlight = app.client.get("/api/v1/slow");
    // Long enough for the request to be inside the controller, not long enough
    // for it to have answered.
    await new Promise((resolve) => setTimeout(resolve, 40));

    const closed = app.http.close();

    await expect(inFlight).resolves.toMatchObject({ status: 200, body: { ok: true } });
    await expect(closed).resolves.toBeUndefined();

    // And it takes nothing new.
    await expect(app.client.get("/health/live")).rejects.toThrow();
  });
});
