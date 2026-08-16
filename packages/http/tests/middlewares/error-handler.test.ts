/**
 * The last middleware in the chain: every `next(err)` and every exception a
 * controller throws ends up here, and whatever it answers is what the client
 * sees. Three things are being checked — that the status and the code are the
 * ones the error meant, that the failure is recorded with enough context to
 * reconstruct it, and that nothing internal escapes in production.
 */
import { ZodError, z } from "zod";
import { AppError, AsyncRequestContext, type ILogger } from "@monolite/core";
import { REQUEST_ID_HEADER, errorHandler, notFoundHandler } from "@monolite/http";
import type { NextFunction, Request, Response } from "express";

type Logger = ILogger & {
  error: jest.Mock;
  warn: jest.Mock;
  info: jest.Mock;
  debug: jest.Mock;
  log: jest.Mock;
};

describe("errorHandler", () => {
   
  let req: any;
   
  let res: any;
  let next: jest.Mock;
  let logger: Logger;

   
  const body = (): any => res.json.mock.calls[0][0];

  /** Runs the middleware with the collaborators of this test. */
  const handle = (error: unknown, options: Parameters<typeof errorHandler>[0] = { logger }) =>
    errorHandler(options)(error as Error, req as Request, res as Response, next as NextFunction);

  beforeEach(() => {
    logger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
    };

    req = { method: "GET", originalUrl: "/api/users/9", headers: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  // =====================================================  application errors ==
  it("respects the status code and the message of an AppError", () => {
    handle(new AppError("User not found", 404));

    expect(res.status).toHaveBeenCalledWith(404);
    expect(body()).toMatchObject({
      status: "error",
      code: "NOT_FOUND",
      message: "User not found",
      path: "/api/users/9",
      method: "GET",
    });
    expect(body().timestamp).toEqual(expect.any(String));
  });

  it("uses the explicit code of an AppError when it carries one", () => {
    handle(new AppError("That slot is taken", 409, true, { code: "APPOINTMENT_OVERLAP" }));

    expect(body().code).toBe("APPOINTMENT_OVERLAP");
  });

  it("includes the field-by-field detail when there is one", () => {
    handle(
      new AppError("Validation failed", 400, true, {
        errors: [{ field: "name", message: "required" }],
      })
    );

    expect(body().errors).toEqual([{ field: "name", message: "required" }]);
  });

  it("answers 500 for an AppError left at its default status", () => {
    handle(new AppError("Generic failure"));

    expect(res.status).toHaveBeenCalledWith(500);
    // Still its own message: the error said it was operational, so it is not
    // one of the failures whose wording has to be hidden.
    expect(body().message).toBe("Generic failure");
  });

  // ========================================================  other origins  ===
  it("translates a ZodError into a 400 with the detail per field", () => {
    const parsed = z.object({ name: z.string() }).safeParse({});

    handle((parsed as { error: ZodError }).error);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(body().code).toBe("VALIDATION_ERROR");
    expect(body().errors[0].field).toBe("name");
  });

  it("translates an expired token into a 401", () => {
    handle(Object.assign(new Error("jwt expired"), { name: "TokenExpiredError" }));

    expect(res.status).toHaveBeenCalledWith(401);
    expect(body().code).toBe("TOKEN_EXPIRED");
  });

  it("translates malformed JSON into a 400", () => {
    handle(Object.assign(new SyntaxError("Unexpected token"), { type: "entity.parse.failed" }));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(body().code).toBe("MALFORMED_JSON");
  });

  // The real reason arrives wrapped in two layers of repository, so the whole
  // `cause` chain is searched rather than only the error that was thrown.
  it("recognises a uniqueness violation through the chain of causes", () => {
    const driver = new Error("ORA-00001: unique constraint (APPUSER.PK_USERS) violated");
    const plugin = new Error("[Oracle] execute failed", { cause: driver });
    const repository = new Error("UsersRepository.insert failed.", { cause: plugin });

    handle(repository);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(body().code).toBe("DB_UNIQUE_VIOLATION");
  });

  it("translates a database that is not there into a 503", () => {
    handle(new Error("wrapped", { cause: new Error("ORA-12541: TNS:no listener") }));

    expect(res.status).toHaveBeenCalledWith(503);
    expect(body().code).toBe("DB_UNAVAILABLE");
  });

  it("answers a generic 500 for anything unexpected", () => {
    handle(new Error("Unexpected crash"));

    expect(res.status).toHaveBeenCalledWith(500);
    expect(body()).toMatchObject({ code: "INTERNAL_ERROR", message: "Internal server error" });
  });

  it("survives something thrown that is not an Error at all", () => {
    // `throw "boom"` is legal JavaScript and the handler is the last thing
    // between it and the client.
    handle("just a string");

    expect(res.status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledWith(
      "Request failed",
      expect.objectContaining({ error: "just a string" })
    );
  });

  // =============================================================  filtering ===
  it("publishes neither the internal message nor the stack in production", () => {
    process.env.NODE_ENV = "production";

    handle(new Error("connection string is postgres://user:pass@host"));

    expect(body().message).toBe("Internal server error");
    expect(body().stack).toBeUndefined();
    expect(body().causes).toBeUndefined();
  });

  it("includes the stack and the causes outside production, which is what debugging needs", () => {
    handle(new Error("boom", { cause: new Error("the root") }));

    expect(Array.isArray(body().stack)).toBe(true);
    expect(body().causes).toEqual(["Error: the root"]);
  });

  it("lets `exposeDebugInfo` override the environment in both directions", () => {
    process.env.NODE_ENV = "production";
    handle(new Error("boom"), { logger, exposeDebugInfo: true });
    expect(body().stack).toBeDefined();

    res.json.mockClear();
    delete process.env.NODE_ENV;
    handle(new Error("boom"), { logger, exposeDebugInfo: false });
    expect(body().stack).toBeUndefined();
  });

  it("still publishes the message of an operational 4xx in production", () => {
    // Hiding those would be hiding the answer: a 404 or a 409 is information the
    // caller asked for and can act on.
    process.env.NODE_ENV = "production";

    handle(new AppError("No user found with that id", 404));

    expect(body().message).toBe("No user found with that id");
  });

  // ===============================================================  logging ===
  it("records a 5xx as an error and a 4xx as a warning", () => {
    // A 4xx is part of normal operation. Logged at the same level as a crash, a
    // wall of 400s reads exactly like a wall of 500s.
    handle(new Error("boom"));
    expect(logger.error).toHaveBeenCalledWith("Request failed", expect.any(Object));

    handle(new AppError("nope", 404));
    expect(logger.warn).toHaveBeenCalledWith("Request rejected", expect.any(Object));
  });

  it("records a non-operational failure as an error whatever its status", () => {
    handle(new AppError("broken", 400, false));

    expect(logger.error).toHaveBeenCalledWith("Request failed", expect.any(Object));
  });

  it("records the route, the code and the chain of causes", () => {
    handle(new AppError("nope", 404, true, { cause: new Error("underneath") }));

    expect(logger.warn).toHaveBeenCalledWith(
      "Request rejected",
      expect.objectContaining({
        method: "GET",
        path: "/api/users/9",
        statusCode: 404,
        code: "NOT_FOUND",
        causes: ["Error: underneath"],
      })
    );
  });

  it("answers even with no logger wired at all", () => {
    // A request that fails silently is worse than one that fails unlogged: a
    // boot that never got as far as the logger still has to answer.
    expect(() => handle(new AppError("x", 400), {})).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  // ====================================================  request correlation ==
  it("carries through the request id that arrived in the header", () => {
    req.headers = { [REQUEST_ID_HEADER]: "abc-123" };

    handle(new AppError("x", 400));

    expect(body().requestId).toBe("abc-123");
  });

  it("prefers the id of the open context over the header", () => {
    // Inside a request the context is authoritative: it is the id the access log
    // and the audit trail used, and answering with a different one would break
    // the only thread tying them together.
    const context = new AsyncRequestContext();
    req.headers = { [REQUEST_ID_HEADER]: "from-the-header" };

    context.run({ requestId: "from-the-context", user: null }, () => {
      handle(new AppError("x", 400), { logger, context });
    });

    expect(body().requestId).toBe("from-the-context");
  });

  it("records who was behind the request", () => {
    const context = new AsyncRequestContext();

    context.run(
      { requestId: "r-1", user: { id: "7", name: "Ana", email: null, roles: [] } },
      () => handle(new AppError("nope", 404), { logger, context })
    );

    expect(logger.warn).toHaveBeenCalledWith(
      "Request rejected",
      expect.objectContaining({ userId: "7", userName: "Ana" })
    );
  });

  it("falls back to `url` when the request has no `originalUrl`", () => {
    req = { method: "GET", url: "/plain", headers: {} };

    handle(new AppError("x", 400));

    expect(body().path).toBe("/plain");
  });
});

describe("notFoundHandler", () => {
  it("turns an unknown route into an AppError 404", () => {
    // So a mistyped endpoint answers with the same shape as the rest of the API
    // instead of Express's HTML page.
    const next = jest.fn();

    notFoundHandler(
      { method: "GET", originalUrl: "/api/nope" } as Request,
      {} as Response,
      next as NextFunction
    );

    const error = next.mock.calls[0][0] as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 404,
      code: "ROUTE_NOT_FOUND",
      message: "Cannot GET /api/nope",
    });
  });
});
