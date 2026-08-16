import { HealthProbe, type IHealthProbe } from "monolite-core";
import {
  container as rootContainer,
  createContainer,
  registerPersistence,
  storeToken,
  TOKENS,
} from "monolite-di";
import {
  AUDIT_LOG_ENTITY,
  GADGET_ENTITY,
  silentLogger,
  WIDGET_ENTITY,
  type IWidget,
} from "../support/test-entity";

/**
 * The probe is spied on rather than reimplemented: the real one still runs, so
 * every other test here reads a genuine report, and the tuning can be asserted
 * where it is actually handed over instead of by reaching into private fields.
 */
jest.mock("monolite-core", () => {
  const actual = jest.requireActual<typeof import("monolite-core")>("monolite-core");

  return {
    ...actual,
    HealthProbe: jest.fn((options: ConstructorParameters<typeof actual.HealthProbe>[0]) => {
      return new actual.HealthProbe(options);
    }),
  };
});

const probeConstructor = HealthProbe as unknown as jest.Mock;

const logger = silentLogger();

beforeEach(() => {
  probeConstructor.mockClear();
});

/** The smallest layer worth registering: one entity, in memory. */
function registerOneEntity(overrides: Record<string, unknown> = {}) {
  const container = createContainer();

  const layer = registerPersistence({
    container,
    dataSource: "memory",
    logger,
    entities: [{ name: "WIDGETS", metadata: WIDGET_ENTITY }],
    ...overrides,
  });

  return { container, layer };
}

describe("registerPersistence", () => {
  it("gives every entity its own token, so a repository injects its store and nothing else", () => {
    const container = createContainer();

    registerPersistence({
      container,
      dataSource: "memory",
      logger,
      entities: [
        { name: "WIDGETS", metadata: WIDGET_ENTITY },
        { name: "GADGETS", metadata: GADGET_ENTITY },
      ],
    });

    expect(container.isRegistered(storeToken("WIDGETS"))).toBe(true);
    expect(container.isRegistered(storeToken("GADGETS"))).toBe(true);
  });

  it("registers on the root container when none is given", () => {
    const layer = registerPersistence({
      dataSource: "memory",
      logger,
      entities: [{ name: "ROOTED", metadata: WIDGET_ENTITY }],
    });

    expect(rootContainer.resolve(storeToken("ROOTED"))).toBe(layer.store<IWidget>("ROOTED"));
  });

  it("registers the very store the layer built, not a second one", async () => {
    const { container, layer } = registerOneEntity();

    expect(container.resolve(storeToken("WIDGETS"))).toBe(layer.store<IWidget>("WIDGETS"));
  });

  /**
   * The override is what lets an application adopt the package without renaming
   * the token its feature modules already inject.
   */
  it("uses the token a registration spells out instead of the convention", () => {
    const container = createContainer();

    registerPersistence({
      container,
      dataSource: "memory",
      logger,
      entities: [{ name: "WIDGETS", metadata: WIDGET_ENTITY, token: "IWidgetRepository" }],
    });

    expect(container.isRegistered("IWidgetRepository")).toBe(true);
    expect(container.isRegistered(storeToken("WIDGETS"))).toBe(false);
  });

  it("always registers the unit of work", () => {
    const { container, layer } = registerOneEntity();

    expect(container.resolve(TOKENS.IUnitOfWork)).toBe(layer.unitOfWork);
  });

  describe("the change log", () => {
    it("is registered, with its store, when a table for it was given", () => {
      const { container, layer } = registerOneEntity({ auditLog: AUDIT_LOG_ENTITY });

      expect(container.resolve(TOKENS.IAuditTrail)).toBe(layer.auditTrail);
      expect(container.resolve(TOKENS.IAuditLogStore)).toBe(layer.auditLogStore);
    });

    it("leaves both tokens free when none was", () => {
      const { container } = registerOneEntity();

      expect(container.isRegistered(TOKENS.IAuditTrail)).toBe(false);
      expect(container.isRegistered(TOKENS.IAuditLogStore)).toBe(false);
    });
  });

  describe("the health probe", () => {
    it("is mounted by default, over the active driver", async () => {
      const { container } = registerOneEntity();

      const report = await container.resolve<IHealthProbe>(TOKENS.IHealthProbe).report();

      expect(report.dataSource).toBe("memory");
      // In memory there is no connection, so the probe answers on the process
      // alone rather than pretending to have checked something.
      expect(report.ready).toBe(true);
    });

    it("can be left out, for an application that answers readiness itself", () => {
      const { container } = registerOneEntity({ healthProbe: false });

      expect(container.isRegistered(TOKENS.IHealthProbe)).toBe(false);
    });

    /**
     * The cache is what stops a load balancer probing every second turning into
     * a query every second, and the timeout is what stops a hung connection
     * holding the readiness answer open. Both are the probe's own behaviour —
     * what this module has to get right is handing them over.
     */
    it("passes the tuning through, on top of the connection it found", () => {
      registerOneEntity({ healthProbe: { ttlMs: 60_000, timeoutMs: 250 } });

      expect(probeConstructor).toHaveBeenCalledTimes(1);
      expect(probeConstructor).toHaveBeenCalledWith({
        connection: undefined,
        dataSource: "memory",
        ttlMs: 60_000,
        timeoutMs: 250,
      });
    });

    it("mounts it over the driver's own connection when there is one", () => {
      const container = createContainer();

      const layer = registerPersistence({
        container,
        dataSource: "postgres",
        logger,
        entities: [],
        sequelize: {
          engine: "postgres",
          host: "localhost",
          port: 5432,
          username: "app",
          password: "",
          database: "shop",
        },
      });

      // Building the connector opens nothing; what matters here is that the
      // probe was given it rather than left checking nothing.
      expect(probeConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ connection: layer.connection, dataSource: "postgres" })
      );
    });

    it("is not even built when it was turned off", () => {
      registerOneEntity({ healthProbe: false });

      expect(probeConstructor).not.toHaveBeenCalled();
    });
  });

  it("returns the whole layer, because start-up and shutdown need the connection", () => {
    const { layer } = registerOneEntity();

    // In memory it is absent, and the composition root accepts that: `manage`
    // ignores an undefined resource rather than making the caller branch.
    expect(layer).toHaveProperty("connection");
    expect(layer.driver).toBe("memory");
  });
});
