import {
  CompositionRoot,
  container as rootContainer,
  createCompositionRoot,
  createContainer,
  registerBinding,
  registerClass,
  registerFactory,
  registerInstance,
  registerSingleton,
} from "monolite-di";
import type { IManagedConnection } from "monolite-di";

class Counter {
  static built = 0;
  readonly id: number;

  constructor() {
    Counter.built += 1;
    this.id = Counter.built;
  }
}

beforeEach(() => {
  Counter.built = 0;
});

describe("createContainer", () => {
  it("resolves what the parent knows", () => {
    const parent = createContainer();
    registerInstance(parent, "IThing", { name: "from the parent" });

    expect(createContainer(parent).resolve("IThing")).toEqual({ name: "from the parent" });
  });

  /**
   * The reason child containers exist at all: a test that swaps an
   * implementation should not have to undo a global registration afterwards.
   */
  it("shadows the parent without changing it", () => {
    const parent = createContainer();
    registerInstance(parent, "IThing", { name: "real" });

    const child = createContainer(parent);
    registerInstance(child, "IThing", { name: "double" });

    expect(child.resolve("IThing")).toEqual({ name: "double" });
    expect(parent.resolve("IThing")).toEqual({ name: "real" });
  });

  it("defaults to a child of the root container", () => {
    registerInstance(rootContainer, "IRootOnly", "visible");

    expect(createContainer().resolve("IRootOnly")).toBe("visible");
  });
});

describe("the registrations", () => {
  it("binds an already-built object as it is", () => {
    const container = createContainer();
    const instance = { built: "outside" };
    registerInstance(container, "IThing", instance);

    expect(container.resolve("IThing")).toBe(instance);
  });

  it("builds a singleton once, however many times it is asked for", () => {
    const container = createContainer();
    registerSingleton(container, "ICounter", Counter);

    expect(container.resolve<Counter>("ICounter")).toBe(container.resolve<Counter>("ICounter"));
    expect(Counter.built).toBe(1);
  });

  it("builds a plain class again on every resolution", () => {
    const container = createContainer();
    registerClass(container, "ICounter", Counter);

    expect(container.resolve<Counter>("ICounter")).not.toBe(container.resolve<Counter>("ICounter"));
    expect(Counter.built).toBe(2);
  });

  it("runs a factory on every resolution, and hands it the container", () => {
    const container = createContainer();
    registerInstance(container, "IPrefix", "id-");
    registerFactory(container, "IThing", (dependencies) => ({
      id: `${dependencies.resolve<string>("IPrefix")}${Counter.built++}`,
    }));

    expect(container.resolve("IThing")).toEqual({ id: "id-0" });
    expect(container.resolve("IThing")).toEqual({ id: "id-1" });
  });
});

describe("registerBinding", () => {
  /**
   * "Here is the class, you build it" reads as a singleton, and the objects
   * this is used for —a request context, a token service that validates a
   * secret in its constructor— are all things there should be one of.
   */
  it("takes a class as a singleton", () => {
    const container = createContainer();
    registerBinding(container, "ICounter", Counter);

    expect(container.resolve<Counter>("ICounter")).toBe(container.resolve<Counter>("ICounter"));
    expect(Counter.built).toBe(1);
  });

  it("takes anything else as the value itself", () => {
    const container = createContainer();
    const instance = new Counter();
    registerBinding(container, "ICounter", instance);

    expect(container.resolve("ICounter")).toBe(instance);
    expect(Counter.built).toBe(1);
  });
});

/** A pool that records what was asked of it and in which order. */
function fakeConnection(name: string, journal: string[], failOnClose = false): IManagedConnection {
  return {
    authenticate: jest.fn(async () => {
      journal.push(`authenticate:${name}`);
    }),
    close: jest.fn(async () => {
      journal.push(`close:${name}`);
      if (failOnClose) throw new Error(`${name} refused to close`);
    }),
  };
}

describe("CompositionRoot", () => {
  it("warms up every resource it was handed", async () => {
    const journal: string[] = [];
    const root = new CompositionRoot(createContainer());
    root.manage(fakeConnection("first", journal));
    root.manage(fakeConnection("second", journal));

    await root.warmUp();

    expect(journal).toEqual(["authenticate:first", "authenticate:second"]);
  });

  /**
   * `undefined` is what the in-memory driver returns — there is nothing to open
   * and nothing to close — and no caller should have to branch on that.
   */
  it("ignores a resource that is not there", async () => {
    const root = new CompositionRoot(createContainer());

    expect(() => root.manage(undefined)).not.toThrow();
    await expect(root.warmUp()).resolves.toBeUndefined();
    await expect(root.shutdown()).resolves.toBeUndefined();
  });

  it("closes in the reverse order it was given them", async () => {
    const journal: string[] = [];
    const root = new CompositionRoot(createContainer());
    root.manage(fakeConnection("first", journal));
    root.manage(fakeConnection("second", journal));

    await root.shutdown();

    expect(journal).toEqual(["close:second", "close:first"]);
  });

  /**
   * A connector that throws on close must not leave the rest of them open, with
   * the process hanging on their sockets — and the caller still has to learn
   * that the shutdown was not clean.
   */
  it("closes the rest even when one fails, and re-throws the first failure", async () => {
    const journal: string[] = [];
    const root = new CompositionRoot(createContainer());
    root.manage(fakeConnection("first", journal));
    root.manage(fakeConnection("second", journal, true));
    root.manage(fakeConnection("third", journal));

    await expect(root.shutdown()).rejects.toThrow("second refused to close");
    expect(journal).toEqual(["close:third", "close:second", "close:first"]);
  });

  it("defaults to the root container when none is given", () => {
    expect(new CompositionRoot().container).toBe(rootContainer);
  });
});

describe("createCompositionRoot", () => {
  it("runs the registrations and hands back the root they went into", () => {
    const container = createContainer();

    const root = createCompositionRoot((root) => {
      registerInstance(root.container, "IThing", "registered");
    }, container);

    expect(root.container).toBe(container);
    expect(container.resolve("IThing")).toBe("registered");
  });

  it("registers on the root container when none is given", () => {
    const root = createCompositionRoot((root) => {
      registerInstance(root.container, "IDefaultedThing", "on the root");
    });

    expect(root.container).toBe(rootContainer);
    expect(rootContainer.resolve("IDefaultedThing")).toBe("on the root");
  });

  it("carries the resources the callback handed over", async () => {
    const journal: string[] = [];

    const root = createCompositionRoot((root) => {
      root.manage(fakeConnection("pool", journal));
    }, createContainer());

    await root.warmUp();
    expect(journal).toEqual(["authenticate:pool"]);
  });
});
