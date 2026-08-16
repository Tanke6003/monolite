/**
 * The Express side of the request context: the middleware that opens it, and
 * the translation from a bag of token claims into the identity the audit trail
 * records.
 *
 * The storage itself — surviving `await`, isolating concurrent requests — is
 * `AsyncRequestContext` in `monolite-core` and is tested there. What matters
 * here is that this middleware really runs the rest of the request *inside* it,
 * which is the only reason a repository three layers down can see the user
 * without being handed it.
 */
import type { NextFunction, Request, Response } from "express";
import { AsyncRequestContext, SYSTEM_USER } from "monolite-core";
import { REQUEST_ID_HEADER, currentUserName, requestContext, toCurrentUser } from "monolite-http";

describe("toCurrentUser", () => {
  it("takes the id, the name and the email from the usual claims", () => {
    expect(toCurrentUser({ sub: "7", name: "Ruben", email: "r@example.com" })).toEqual({
      id: "7",
      name: "Ruben",
      email: "r@example.com",
      roles: [],
    });
  });

  it("accepts a numeric id", () => {
    expect(toCurrentUser({ userId: 42, name: "Ana" })?.id).toBe("42");
  });

  it("tries several claim names, in order", () => {
    // Providers disagree about what a name is called: OIDC says
    // `preferred_username`, Azure AD / ADFS say `samaccountname`.
    expect(toCurrentUser({ sub: "1", preferred_username: "rfarias" })?.name).toBe("rfarias");
    expect(toCurrentUser({ sub: "1", samaccountname: "DOMAIN\\rfarias" })?.name).toBe(
      "DOMAIN\\rfarias"
    );
  });

  // Better to identify the author by their email or their id than to record
  // "System" for somebody who was in fact signed in.
  it("falls back to the email and then to the id when there is no name", () => {
    expect(toCurrentUser({ sub: "7", email: "r@example.com" })?.name).toBe("r@example.com");
    expect(toCurrentUser({ sub: "7" })?.name).toBe("7");
  });

  it("returns null when the token identifies nobody", () => {
    expect(toCurrentUser({})).toBeNull();
    expect(toCurrentUser(undefined)).toBeNull();
    expect(toCurrentUser("a-string")).toBeNull();
    expect(toCurrentUser({ name: "   " })).toBeNull();
  });

  it("trims the claim it accepted", () => {
    expect(toCurrentUser({ sub: " 7 ", name: " Ana " })).toMatchObject({ id: "7", name: "Ana" });
  });

  describe("roles", () => {
    it("reads a list of roles", () => {
      expect(toCurrentUser({ sub: "1", roles: ["admin", "auditor"] })?.roles).toEqual([
        "admin",
        "auditor",
      ]);
    });

    it("accepts the singular claim a token with exactly one role uses", () => {
      expect(toCurrentUser({ sub: "1", role: "admin" })?.roles).toEqual(["admin"]);
    });

    /**
     * Always an array, never `undefined`: an authorisation check can then
     * iterate with no null guard, and an absent claim means "no roles" rather
     * than "unknown" — which is the reading that fails closed.
     */
    it("is an empty array when the token grants none", () => {
      expect(toCurrentUser({ sub: "1" })?.roles).toEqual([]);
      expect(toCurrentUser({ sub: "1", roles: [] })?.roles).toEqual([]);
      expect(toCurrentUser({ sub: "1", roles: [42, null] })?.roles).toEqual([]);
    });

    it("drops the blanks and trims the rest", () => {
      expect(toCurrentUser({ sub: "1", roles: [" admin ", "  ", "auditor"] })?.roles).toEqual([
        "admin",
        "auditor",
      ]);
    });
  });
});

describe("requestContext", () => {
  let context: AsyncRequestContext;
   
  let res: any;

  const run = (headers: Record<string, string>, next: () => void) =>
    requestContext(context)({ headers } as Request, res as Response, next as NextFunction);

  beforeEach(() => {
    context = new AsyncRequestContext();
    res = { setHeader: jest.fn() };
  });

  it("opens the context and publishes the id in the response header", () => {
    const seen: string[] = [];

    run({}, () => seen.push(context.getRequestId()!));

    expect(seen[0]).toEqual(expect.any(String));
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, seen[0]);
  });

  // So one operation can be followed across several services.
  it("honours an id that arrived from a proxy", () => {
    const seen: (string | undefined)[] = [];

    run({ [REQUEST_ID_HEADER]: "trace-99" }, () => seen.push(context.getRequestId()));

    expect(seen).toEqual(["trace-99"]);
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, "trace-99");
  });

  it("generates a different id per request", () => {
    const ids: string[] = [];

    run({}, () => ids.push(context.getRequestId()!));
    run({}, () => ids.push(context.getRequestId()!));

    expect(ids[0]).not.toBe(ids[1]);
  });

  it("ignores an empty incoming header rather than propagating a blank id", () => {
    const seen: (string | undefined)[] = [];

    run({ [REQUEST_ID_HEADER]: "" }, () => seen.push(context.getRequestId()));

    expect(seen[0]).toEqual(expect.any(String));
    expect(seen[0]).not.toBe("");
  });

  it("starts with no user: the auth guard fills it in later", () => {
    // When this middleware runs the guard has not seen the request yet, so the
    // context is opened empty and completed a step later by whoever
    // authenticates.
    run({}, () => {
      expect(context.getCurrentUser()).toBeNull();
      expect(context.getCurrentUserId()).toBeNull();
      expect(context.getCurrentUserName()).toBe(SYSTEM_USER);
    });
  });

  it("runs everything downstream inside the context, awaits included", async () => {
    // This is the whole point of opening it here rather than reading a header
    // wherever it happens to be needed.
    await new Promise<void>((resolve) => {
      run({}, async () => {
        const before = context.getRequestId();
        await Promise.resolve();
        await new Promise((tick) => setTimeout(tick, 1));

        expect(context.getRequestId()).toBe(before);
        resolve();
      });
    });
  });

  // Two requests in flight at once must not see each other's user.
  it("keeps concurrent requests apart", async () => {
    const one = (name: string, delay: number) =>
      new Promise<string>((resolve) => {
        run({}, async () => {
          const store = context.get()!;
          store.user = { id: name, name, email: null, roles: [] };
          await new Promise((tick) => setTimeout(tick, delay));
          resolve(context.getCurrentUserName());
        });
      });

    expect(await Promise.all([one("Ana", 5), one("Beto", 1)])).toEqual(["Ana", "Beto"]);
  });

  it("leaves no context behind outside a request", () => {
    expect(context.get()).toBeUndefined();
    expect(context.getCurrentUserName()).toBe(SYSTEM_USER);
  });
});

describe("currentUserName", () => {
  it("gives the name to record in the audit trail", () => {
    const context = new AsyncRequestContext();

    context.run({ requestId: "r", user: { id: "7", name: "Ana", email: null, roles: [] } }, () => {
      expect(currentUserName(context)).toBe("Ana");
    });
  });

  it('answers "System" outside a request: startup, scheduled jobs, seeds', () => {
    expect(currentUserName(new AsyncRequestContext())).toBe(SYSTEM_USER);
  });
});
