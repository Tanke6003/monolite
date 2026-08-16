// Ported from the request-context middleware suite of the original project.
// Only the half that exercises `AsyncRequestContext` itself lives here: the
// Express middleware that opens the context per request, reads the trace header
// and decodes the token into a `CurrentUser` belongs to the HTTP package, so
// those assertions were left there.
import { AsyncRequestContext, SYSTEM_USER, type CurrentUser } from "@monolite/core";

const user = (name: string, id: string | null = "7"): CurrentUser => ({
  id,
  name,
  email: null,
  roles: [],
});

describe("AsyncRequestContext", () => {
  let context: AsyncRequestContext;

  beforeEach(() => {
    context = new AsyncRequestContext();
  });

  describe("inside a flow", () => {
    it("exposes the request id and the identity to anything running underneath", () => {
      context.run({ requestId: "req-1", user: user("Ruben") }, () => {
        expect(context.get()).toEqual({ requestId: "req-1", user: user("Ruben") });
        expect(context.getRequestId()).toBe("req-1");
        expect(context.getCurrentUser()).toEqual(user("Ruben"));
        expect(context.getCurrentUserName()).toBe("Ruben");
        expect(context.getCurrentUserId()).toBe("7");
      });
    });

    it("returns whatever the block returns, so it can wrap a handler transparently", () => {
      expect(context.run({ requestId: "req-1", user: null }, () => 42)).toBe(42);
    });

    it("starts with no user: the auth guard fills it in afterwards", () => {
      context.run({ requestId: "req-1", user: null }, () => {
        expect(context.getCurrentUser()).toBeNull();
        expect(context.getCurrentUserId()).toBeNull();
        expect(context.getCurrentUserName()).toBe(SYSTEM_USER);
      });
    });

    // An authenticated user whose token carries no `sub` still has a name to
    // audit with, but nothing to attach ownership rules to.
    it("tells apart having no id from having no user", () => {
      context.run({ requestId: "req-1", user: user("Ruben", null) }, () => {
        expect(context.getCurrentUser()).not.toBeNull();
        expect(context.getCurrentUserId()).toBeNull();
        expect(context.getCurrentUserName()).toBe("Ruben");
      });
    });
  });

  // This is the whole point of using AsyncLocalStorage instead of a
  // module-level variable: a repository three layers down, after any number of
  // awaits, still sees the user of its own request.
  describe("the store survives every await", () => {
    it("keeps the request id across microtasks and timers", async () => {
      await context.run({ requestId: "req-1", user: user("Ruben") }, async () => {
        const before = context.getRequestId();

        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 1));
        await new Promise((resolve) => setImmediate(resolve));

        expect(context.getRequestId()).toBe(before);
        expect(context.getCurrentUserName()).toBe("Ruben");
      });
    });

    it("reaches a callee that never received the context as a parameter", async () => {
      // This is the shape the generic repository relies on to fill CREATED_BY:
      // nothing on the call path mentions the context.
      const auditColumn = async (): Promise<string> => {
        await Promise.resolve();
        return context.getCurrentUserName();
      };
      const service = () => auditColumn();

      await expect(
        context.run({ requestId: "req-1", user: user("Ana") }, () => service())
      ).resolves.toBe("Ana");
    });
  });

  // Two requests at the same time must not be able to see each other's user.
  // A plain module-level variable would fail exactly here.
  describe("isolation between concurrent flows", () => {
    it("each flow keeps its own identity while the other is awaiting", async () => {
      const run = (name: string, delay: number) =>
        context.run({ requestId: `req-${name}`, user: null }, async () => {
          const store = context.get()!;
          store.user = user(name, name);

          await new Promise((resolve) => setTimeout(resolve, delay));

          return `${context.getRequestId()}:${context.getCurrentUserName()}`;
        });

      // The slower one starts first on purpose: if the store were shared, the
      // faster one would overwrite it before the slower one resumes.
      await expect(Promise.all([run("Ana", 5), run("Beto", 1)])).resolves.toEqual([
        "req-Ana:Ana",
        "req-Beto:Beto",
      ]);
    });

    it("nested flows do not leak outwards: the inner one ends when its block does", () => {
      context.run({ requestId: "outer", user: user("Ana") }, () => {
        context.run({ requestId: "inner", user: user("Beto") }, () => {
          expect(context.getRequestId()).toBe("inner");
          expect(context.getCurrentUserName()).toBe("Beto");
        });

        expect(context.getRequestId()).toBe("outer");
        expect(context.getCurrentUserName()).toBe("Ana");
      });
    });
  });

  // The auth guard runs after the context is already open, so it has to write
  // into the store in flight. Replacing the object instead of mutating it would
  // leave everything below still reading the old one.
  describe("mutating the store in flight", () => {
    it("a user written after the context opened is visible to everything below", async () => {
      await context.run({ requestId: "req-1", user: null }, async () => {
        expect(context.getCurrentUserName()).toBe(SYSTEM_USER);

        // What the auth guard does once it has decoded the token.
        context.get()!.user = user("Ruben");

        await Promise.resolve();

        expect(context.getCurrentUserName()).toBe("Ruben");
        expect(context.getCurrentUserId()).toBe("7");
      });
    });

    it("`get` hands back the live store, not a copy", () => {
      context.run({ requestId: "req-1", user: null }, () => {
        expect(context.get()).toBe(context.get());
      });
    });
  });

  describe("outside any request", () => {
    // Start-up, scheduled jobs and seeds run with no request in flight, and the
    // audit columns still need a value.
    it("there is no context and the audit name falls back to System", () => {
      expect(context.get()).toBeUndefined();
      expect(context.getRequestId()).toBeUndefined();
      expect(context.getCurrentUser()).toBeNull();
      expect(context.getCurrentUserId()).toBeNull();
      expect(context.getCurrentUserName()).toBe(SYSTEM_USER);
      expect(SYSTEM_USER).toBe("System");
    });

    it("the context closes when its block finishes", async () => {
      await context.run({ requestId: "req-1", user: user("Ruben") }, async () => {
        await Promise.resolve();
      });

      expect(context.get()).toBeUndefined();
      expect(context.getCurrentUserName()).toBe(SYSTEM_USER);
    });

    it("two instances do not share a store", () => {
      const other = new AsyncRequestContext();

      context.run({ requestId: "req-1", user: user("Ruben") }, () => {
        expect(other.get()).toBeUndefined();
        expect(other.getCurrentUserName()).toBe(SYSTEM_USER);
      });
    });
  });
});
