import { AppError, AsyncRequestContext, SYSTEM_USER } from "@monolite/core";
import { BaseController } from "@monolite/http";

/** Exposes the protected members so the test can look at them. */
class ProbeController extends BaseController {
  constructor(context: AsyncRequestContext) {
    super(context);
  }

  claims() {
    return {
      user: this.currentUser,
      id: this.userId,
      name: this.userName,
      email: this.userEmail,
      roles: this.userRoles,
      requestId: this.requestId,
    };
  }

  mustHaveUser() {
    return this.requireUserId();
  }
}

describe("BaseController", () => {
  let context: AsyncRequestContext;
  let controller: ProbeController;

  beforeEach(() => {
    context = new AsyncRequestContext();
    controller = new ProbeController(context);
  });

  const asUser = <T>(fn: () => T) =>
    context.run(
      {
        requestId: "req-1",
        user: { id: "7", name: "Ruben", email: "ruben@example.com", roles: ["admin"] },
      },
      fn
    );

  it("publishes the identity of the request in flight", () => {
    // The controller neither reads the token nor takes the context as a
    // parameter: it asks the ambient context the middleware opened.
    expect(asUser(() => controller.claims())).toEqual({
      user: { id: "7", name: "Ruben", email: "ruben@example.com", roles: ["admin"] },
      id: "7",
      name: "Ruben",
      email: "ruben@example.com",
      roles: ["admin"],
      requestId: "req-1",
    });
  });

  it("invents no identity outside a request", () => {
    expect(controller.claims()).toEqual({
      user: null,
      id: null,
      name: SYSTEM_USER,
      email: null,
      roles: [],
      requestId: undefined,
    });
  });

  it("requireUserId gives the id when there is a user", () => {
    expect(asUser(() => controller.mustHaveUser())).toBe("7");
  });

  // An explicit 401 beats carrying on with `null` and writing it into a column.
  it("requireUserId fails with a 401 when the request is anonymous", () => {
    expect(() => controller.mustHaveUser()).toThrow(AppError);
    expect(() => controller.mustHaveUser()).toThrow(/No authenticated user/);

    try {
      controller.mustHaveUser();
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 401, code: "NO_AUTHENTICATED_USER" });
    }
  });

  it("still counts an authenticated request with no id as anonymous for requireUserId", () => {
    // A token that verifies but names nobody is authentic; it is just not an
    // identity, and a rule that depends on *who* is asking cannot run on it.
    context.run({ requestId: "r", user: { id: null, name: "Anon", email: null, roles: [] } }, () => {
      expect(controller.claims().name).toBe("Anon");
      expect(() => controller.mustHaveUser()).toThrow(AppError);
    });
  });

  it("gives an empty role list rather than an absent one", () => {
    context.run({ requestId: "r", user: { id: "1", name: "A", email: null, roles: [] } }, () => {
      expect(controller.claims().roles).toEqual([]);
    });
  });
});
