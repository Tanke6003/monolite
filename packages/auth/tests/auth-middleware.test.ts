/**
 * The route guard.
 *
 * Every rejection here is an `AppError`, never a raw `jsonwebtoken` error. The
 * kernel's mapper does know how to read those, but letting them travel raw
 * would tie the shape of a 401 to whichever library happens to sit behind
 * `ITokenBLL` — an application with opaque tokens would answer differently
 * for the same reason. The expired/invalid distinction survives the
 * translation, because clients branch on it: expired means "renew", invalid
 * means "sign in again".
 */
import type { NextFunction, Request, Response } from "express";
import { AppError, AsyncRequestContext, type CurrentUser } from "monolite-core";
import { errorHandler } from "monolite-http";
import {
  JwtTokenBLL,
  authenticatedUser,
  requireAuth,
  requireRoles,
  type RequireAuthOptions,
} from "monolite-auth";

const SECRET = "unit-test-secret";
const tokens = new JwtTokenBLL({ secret: SECRET });

const tokenFor = (claims: object, expiresIn?: string | number): string =>
  tokens.sign(claims, expiresIn).token;

 
const requestWith = (headers: Record<string, string>): any => ({ headers });

/** Runs the guard and reports what it did. */
function guard(
  headers: Record<string, string>,
  options: RequireAuthOptions = {}
): { req: Request; next: jest.Mock; error: AppError | undefined } {
  const req = requestWith(headers) as Request;
  const next = jest.fn();

  requireAuth(tokens, options)(req, {} as Response, next as NextFunction);

  return { req, next, error: next.mock.calls[0]?.[0] as AppError | undefined };
}

describe("requireAuth", () => {
  it("lets a valid Bearer token through", () => {
    const { next, error } = guard({ authorization: `Bearer ${tokenFor({ sub: "7", name: "Ana" })}` });

    expect(next).toHaveBeenCalledTimes(1);
    expect(error).toBeUndefined();
  });

  it("parks the decoded claims on the request", () => {
    const { req } = guard({ authorization: `Bearer ${tokenFor({ sub: "7", name: "Ana" })}` });

    expect(req.user).toMatchObject({ sub: "7", name: "Ana" });
  });

  it("resolves the identity the rest of the request will read", () => {
    const { req } = guard({
      authorization: `Bearer ${tokenFor({ sub: "7", name: "Ana", email: "a@example.com", roles: ["admin"] })}`,
    });

    expect(authenticatedUser(req)).toEqual({
      id: "7",
      name: "Ana",
      email: "a@example.com",
      roles: ["admin"],
    });
  });

  /**
   * The second place the identity is published, and the one that matters most:
   * it lets a service three layers down know who is asking without the identity
   * being threaded through every signature.
   */
  it("publishes the identity into the request context", () => {
    const context = new AsyncRequestContext();

    context.run({ requestId: "r-1", user: null }, () => {
      guard({ authorization: `Bearer ${tokenFor({ sub: "7", name: "Ana" })}` }, { context });

      expect(context.getCurrentUser()).toMatchObject({ id: "7", name: "Ana" });
      expect(context.getCurrentUserId()).toBe("7");
    });
  });

  it("keeps the request id that was already open", () => {
    // The store is mutated rather than replaced: this is one step inside the
    // request the context middleware opened, not a new one.
    const context = new AsyncRequestContext();

    context.run({ requestId: "r-1", user: null }, () => {
      guard({ authorization: `Bearer ${tokenFor({ sub: "7" })}` }, { context });

      expect(context.getRequestId()).toBe("r-1");
    });
  });

  it("works with no context at all, as a plain gate", () => {
    // Usable in a test, in a script, or in an application that never opened a
    // request context — and `requireRoles` still works, because the identity is
    // on the request too.
    const { next, error, req } = guard({ authorization: `Bearer ${tokenFor({ sub: "7" })}` });

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(authenticatedUser(req)).toMatchObject({ id: "7" });
  });

  it("matches the Bearer scheme whatever its case", () => {
    // RFC 7235 says the scheme is case-insensitive, and clients do send
    // "bearer".
    for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
      const { error } = guard({ authorization: `${scheme} ${tokenFor({ sub: "7" })}` });

      expect(error).toBeUndefined();
    }
  });

  describe("rejections", () => {
    it("answers 401 when there is no header", () => {
      const { error } = guard({});

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ statusCode: 401, code: "NO_TOKEN" });
    });

    it.each([
      ["another scheme", "Basic abc"],
      ["a bare token", "abc"],
      ["a scheme with no token", "Bearer"],
      ["something after the token", "Bearer abc def"],
    ])("answers 401 for %s", (_case, header) => {
      const { error } = guard({ authorization: header });

      expect(error).toMatchObject({ statusCode: 401, code: "INVALID_TOKEN_FORMAT" });
    });

    it("answers 401 for a token that does not verify", () => {
      const { error } = guard({ authorization: "Bearer not-a-real-token" });

      expect(error).toMatchObject({ statusCode: 401, code: "INVALID_TOKEN" });
    });

    it("answers 401 for a token signed with another secret", () => {
      const foreign = new JwtTokenBLL({ secret: "someone-else" }).sign({ sub: "7" }).token;

      expect(guard({ authorization: `Bearer ${foreign}` }).error).toMatchObject({
        code: "INVALID_TOKEN",
      });
    });

    it("tells an expired token apart, because the client acts on the difference", () => {
      const { error } = guard({ authorization: `Bearer ${tokenFor({ sub: "7" }, "-1s")}` });

      expect(error).toMatchObject({ statusCode: 401, code: "TOKEN_EXPIRED" });
    });

    it("keeps the original error as the cause, so it can still be diagnosed", () => {
      const { error } = guard({ authorization: "Bearer nonsense" });

      expect((error as AppError).cause).toMatchObject({ name: "JsonWebTokenError" });
    });

    it("never answers by itself", () => {
      // Every rejection travels through `next`, so a 401 carries the same shape
      // — code, request id, timestamp — as any other error in the API.
      const req = requestWith({}) as Request;
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
      const next = jest.fn();

      requireAuth(tokens)(req, res, next as NextFunction);

      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
    });
  });

  /**
   * A token that verifies but names nobody is still allowed through: it *is*
   * authentic, and refusing it here would be authorisation dressed up as
   * authentication. It arrives with no user, and `requireRoles` or
   * `requireUserId()` turn it away where that decision belongs.
   */
  it("lets an authentic token that identifies nobody through, with no user", () => {
    const { error, req } = guard({ authorization: `Bearer ${tokenFor({ scope: "read" })}` });

    expect(error).toBeUndefined();
    expect(authenticatedUser(req)).toBeNull();
  });

  it("accepts a claim mapping of the application's own", () => {
    // For an issuer the toolkit does not recognise — better than growing a list
    // of claim names every application then has to carry.
    const toCurrentUser = (claims: Record<string, unknown>): CurrentUser => ({
      id: String(claims.employeeNumber),
      name: String(claims.displayName),
      email: null,
      roles: [],
    });

    const { req } = guard(
      { authorization: `Bearer ${tokenFor({ employeeNumber: 42, displayName: "Ana" })}` },
      { toCurrentUser }
    );

    expect(authenticatedUser(req)).toEqual({ id: "42", name: "Ana", email: null, roles: [] });
  });
});

describe("authenticatedUser", () => {
  it("answers null for a request that was never guarded", () => {
    expect(authenticatedUser(requestWith({}) as Request)).toBeNull();
  });
});

describe("requireRoles", () => {
  /** Runs the guard and then the role check on the same request. */
  const check = (
    claims: object | null,
    roles: string[]
  ): { next: jest.Mock; error: AppError | undefined } => {
    const req = claims
      ? guard({ authorization: `Bearer ${tokenFor(claims)}` }).req
      : (requestWith({}) as Request);

    const next = jest.fn();
    requireRoles(...roles)(req, {} as Response, next as NextFunction);

    return { next, error: next.mock.calls[0]?.[0] as AppError | undefined };
  };

  it("lets a user holding the role through", () => {
    const { next, error } = check({ sub: "7", name: "Ana", roles: ["admin"] }, ["admin"]);

    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("answers 403 for a user without it", () => {
    const { error } = check({ sub: "7", name: "Ana", roles: ["viewer"] }, ["admin"]);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("does not name the roles it wanted", () => {
    // Which roles exist is information about the system, and the caller cannot
    // act on it: the answer would be the same however the request were retried.
    const { error } = check({ sub: "7", name: "Ana", roles: ["viewer"] }, ["admin", "auditor"]);

    expect(error?.message).toBe("You do not have permission to perform this action");
    expect(error?.message).not.toMatch(/admin|auditor/);
  });

  /**
   * **Any of them, not all.** This is what `[Authorize(Roles = ...)]` does in
   * ASP.NET and how the check is read out loud: "admins or auditors may see
   * this". To demand several at once the middleware is chained, which says
   * "and" without a second parameter to get backwards.
   */
  it("is satisfied by any one of the roles listed", () => {
    const { error } = check({ sub: "7", name: "Ana", roles: ["auditor"] }, ["admin", "auditor"]);

    expect(error).toBeUndefined();
  });

  it("degrades to 'must be someone' when no role is listed", () => {
    expect(check({ sub: "7", name: "Ana", roles: [] }, []).error).toBeUndefined();
  });

  it("answers 401, not 403, when nobody has been identified", () => {
    // The caller may still fix this by presenting a token. A 403 would mean "we
    // know who you are and the answer is no", which is a different instruction.
    const { error } = check(null, ["admin"]);

    expect(error).toMatchObject({ statusCode: 401, code: "NO_AUTHENTICATED_USER" });
  });

  it("answers 401 for an authentic token that named nobody", () => {
    const { error } = check({ scope: "read" }, ["admin"]);

    expect(error).toMatchObject({ statusCode: 401, code: "NO_AUTHENTICATED_USER" });
  });
});

/**
 * The reason every rejection is an `AppError` rather than whatever the token
 * library threw: the standard handler is what turns it into the API's response,
 * and it can only do that for an error it understands.
 */
describe("the failures reach the standard error handler", () => {
  it.each([
    ["no header", {}, 401, "NO_TOKEN"],
    ["a malformed header", { authorization: "Basic abc" }, 401, "INVALID_TOKEN_FORMAT"],
    ["an unusable token", { authorization: "Bearer nonsense" }, 401, "INVALID_TOKEN"],
  ])("formats %s as a %i", (_case, headers, status, code) => {
    const { error } = guard(headers as Record<string, string>);

    const req = { method: "GET", originalUrl: "/api/v1/users", headers: {} } as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    errorHandler()(error as AppError, req, res, jest.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(status);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({ status: "error", code });
  });
});
