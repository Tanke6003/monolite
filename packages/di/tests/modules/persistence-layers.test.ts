/**
 * Two persistence layers in one container (#43).
 *
 * In memory on both sides: what is under test is the wiring — which token gets
 * what, which transaction a store joins — and that is the same whatever the
 * engine. The integration suite puts PostgreSQL and MongoDB side by side.
 */
import type { IHealthProbe } from "monolite-core";
import { CompositeHealthProbe } from "monolite-core";
import { CrudBLL, lockRow, Transactional } from "monolite-crud";
import {
  AsyncTransactionContext,
  defineEntity,
  transactionSeamOf,
  type IGenericRepository,
  type IUnitOfWork,
} from "monolite-data";
import {
  auditLogStoreToken,
  createContainer,
  healthProbeToken,
  registerPersistence,
  storeToken,
  TOKENS,
  transactionContextToken,
  unitOfWorkToken,
  type DependencyContainer,
} from "monolite-di";
import {
  AUDIT_LOG_ENTITY,
  GADGET_ENTITY,
  silentLogger,
  WIDGET_ENTITY,
  type IGadget,
  type IWidget,
} from "../support/test-entity";

const logger = silentLogger();

/** `records` holds the widgets, `documents` the gadgets. */
function twoLayers(container: DependencyContainer = createContainer()) {
  const records = registerPersistence({
    container,
    name: "records",
    dataSource: "memory",
    logger,
    entities: [{ name: "WIDGETS", metadata: WIDGET_ENTITY }],
    auditLog: AUDIT_LOG_ENTITY,
  });
  const documents = registerPersistence({
    container,
    name: "documents",
    dataSource: "memory",
    logger,
    entities: [{ name: "GADGETS", metadata: GADGET_ENTITY }],
  });

  return {
    container,
    records,
    documents,
    widgets: container.resolve<IGenericRepository<IWidget>>(storeToken("WIDGETS")),
    gadgets: container.resolve<IGenericRepository<IGadget, string>>(storeToken("GADGETS")),
  };
}

describe("named persistence layers", () => {
  it("registers each layer's unit of work under its own token, neither overwriting the other", () => {
    const { container, records, documents } = twoLayers();

    expect(container.resolve(unitOfWorkToken("records"))).toBe(records.unitOfWork);
    expect(container.resolve(unitOfWorkToken("documents"))).toBe(documents.unitOfWork);
    expect(records.unitOfWork).not.toBe(documents.unitOfWork);

    // Nothing named registers the plain token: an injection of it in a
    // two-layer application fails at start-up instead of picking one.
    expect(container.isRegistered(TOKENS.IUnitOfWork)).toBe(false);
    expect(container.resolve(auditLogStoreToken("records"))).toBe(records.auditLogStore);
  });

  it("keeps the per-entity store tokens exactly as they were", () => {
    const { container } = twoLayers();

    expect(container.isRegistered(storeToken("WIDGETS"))).toBe(true);
    expect(container.isRegistered(storeToken("GADGETS"))).toBe(true);
  });

  it("gives each named layer a transaction context of its own", () => {
    const { container, records, documents } = twoLayers();

    expect(records.transactions).toBeInstanceOf(AsyncTransactionContext);
    expect(records.transactions).not.toBe(documents.transactions);
    expect(container.resolve(transactionContextToken("records"))).toBe(records.transactions);
  });

  it("labels every store and unit of work with its layer", () => {
    const { records, widgets, gadgets } = twoLayers();

    expect(transactionSeamOf(widgets)?.layer).toBe("records");
    expect(transactionSeamOf(gadgets)?.layer).toBe("documents");
    expect(transactionSeamOf(records.unitOfWork)?.layer).toBe("records");
  });

  it("leaves an unnamed layer on the plain tokens, next to a named one", () => {
    const container = createContainer();
    const transactions = new AsyncTransactionContext();

    const main = registerPersistence({
      container,
      dataSource: "memory",
      logger,
      transactions,
      entities: [{ name: "WIDGETS", metadata: WIDGET_ENTITY }],
    });
    registerPersistence({
      container,
      name: "documents",
      dataSource: "memory",
      logger,
      entities: [{ name: "GADGETS", metadata: GADGET_ENTITY }],
    });

    expect(container.resolve(TOKENS.IUnitOfWork)).toBe(main.unitOfWork);
    expect(container.isRegistered(unitOfWorkToken("documents"))).toBe(true);
    expect(transactionSeamOf(container.resolve(storeToken("WIDGETS")))?.layer).toBeUndefined();
  });

  describe("refuses at start-up", () => {
    it("a second layer under a name already taken", () => {
      const { container } = twoLayers();

      expect(() =>
        registerPersistence({
          container,
          name: "records",
          dataSource: "memory",
          logger,
          entities: [],
        })
      ).toThrow(/layer called "records" is already registered/);
    });

    it("a layer called default, or one with no name", () => {
      const options = { container: createContainer(), dataSource: "memory", logger, entities: [] };

      expect(() => registerPersistence({ ...options, name: "default" })).toThrow(/unnamed layer/);
      expect(() => registerPersistence({ ...options, name: " " })).toThrow(/cannot be empty/);
    });

    it("two layers handed the same transaction context", () => {
      const container = createContainer();
      const transactions = new AsyncTransactionContext();
      const options = { container, dataSource: "memory", logger, transactions, entities: [] };

      registerPersistence({ ...options, name: "records" });

      expect(() => registerPersistence({ ...options, name: "documents" })).toThrow(
        /layers "records" and "documents" share one transaction context/
      );
    });

    it("a relation into another layer, naming both", () => {
      const ORDERS = defineEntity<{ pkOrder: number; widgetId: number }>({
        table: "ORDERS",
        primaryKey: "pkOrder",
        identity: true,
        columns: {
          pkOrder: { name: "PK_ORDER", kind: "number" },
          widgetId: { name: "FK_WIDGET", kind: "number" },
        },
        relations: { widget: { to: "WIDGETS", localKey: "widgetId", foreignKey: "pkWidget" } },
      });
      const { container } = twoLayers();

      expect(() =>
        registerPersistence({
          container,
          name: "orders",
          dataSource: "memory",
          logger,
          entities: [{ name: "ORDERS", metadata: ORDERS }],
        })
      ).toThrow(/from layer "orders" into another layer: ORDERS\.widget -> WIDGETS \(layer "records"\)/);
    });
  });
});

describe("@Transactional on a named layer", () => {
  it("rolls back the write to its layer and leaves the other layer's write in place", async () => {
    const { widgets, gadgets } = twoLayers();

    class Inventory {
      constructor(
        readonly widgets: IGenericRepository<IWidget>,
        readonly gadgets: IGenericRepository<IGadget, string>
      ) {}

      @Transactional("records")
      async both(): Promise<void> {
        await this.widgets.insert({ name: "rolled back" });
        await this.gadgets.insert({ code: "G-1", label: "kept" });
        throw new Error("boom");
      }
    }

    await expect(new Inventory(widgets, gadgets).both()).rejects.toThrow("boom");

    // This is the behaviour people will assume otherwise, so it is shown
    // rather than described: the transaction stopped at its layer.
    expect(await widgets.find({ where: { name: "rolled back" } })).toHaveLength(0);
    expect(await gadgets.getById("G-1")).toMatchObject({ label: "kept" });
  });

  it("opens one transaction per layer when the methods nest, each with its own fate", async () => {
    const { widgets, gadgets } = twoLayers();

    class Inventory {
      constructor(
        readonly widgets: IGenericRepository<IWidget>,
        readonly gadgets: IGenericRepository<IGadget, string>
      ) {}

      @Transactional("records")
      async outer(): Promise<void> {
        await this.widgets.insert({ name: "outer" });
        await this.inner().catch(() => undefined);
      }

      @Transactional("documents")
      async inner(): Promise<void> {
        await this.gadgets.insert({ code: "G-2", label: "inner" });
        throw new Error("inner fails");
      }
    }

    await new Inventory(widgets, gadgets).outer();

    expect(await widgets.find({ where: { name: "outer" } })).toHaveLength(1);
    expect(await gadgets.getById("G-2")).toBeNull();
  });

  it("finds the layer through a unit of work the service keeps under any name", async () => {
    const { container, widgets } = twoLayers();

    class Ledger {
      constructor(
        readonly recordsWork: IUnitOfWork,
        readonly widgets: IGenericRepository<IWidget>
      ) {}

      @Transactional("records")
      async write(): Promise<void> {
        await this.widgets.insert({ name: "via unit of work" });
        throw new Error("boom");
      }
    }

    const ledger = new Ledger(container.resolve(unitOfWorkToken("records")), widgets);
    await expect(ledger.write()).rejects.toThrow("boom");

    expect(await widgets.find({ where: { name: "via unit of work" } })).toHaveLength(0);
  });

  it("refuses a layer the service holds nothing of, naming it", async () => {
    const { widgets } = twoLayers();

    class Wrong {
      constructor(readonly widgets: IGenericRepository<IWidget>) {}

      @Transactional("documents")
      async write(): Promise<void> {
        await this.widgets.insert({ name: "never" });
      }
    }

    await expect(new Wrong(widgets).write()).rejects.toThrow(
      /for layer "documents", but Wrong holds nothing of that layer/
    );
    expect(await widgets.find({ where: { name: "never" } })).toHaveLength(0);
  });

  it("is what a CrudBLL over a named layer's store opens, with nothing to name", async () => {
    const { gadgets } = twoLayers();

    class Gadgets extends CrudBLL<IGadget, IGadget> {
      constructor(store: IGenericRepository<IGadget, string>) {
        // The mapper is never reached: nothing here reads a DTO.
        super(store as never, {} as never);
      }

      @Transactional()
      async twice(): Promise<void> {
        await this.repository.insert({ code: "G-3", label: "one" });
        await this.repository.insert({ code: "G-4", label: "two" });
        throw new Error("boom");
      }
    }

    await expect(new Gadgets(gadgets).twice()).rejects.toThrow("boom");
    expect(await gadgets.getById("G-3")).toBeNull();
  });

  it("locks a row in the layer of the store it is handed", async () => {
    const { widgets, gadgets } = twoLayers();
    const row = await widgets.insert({ name: "locked" });

    class Inventory {
      constructor(
        readonly widgets: IGenericRepository<IWidget>,
        readonly gadgets: IGenericRepository<IGadget, string>
      ) {}

      @Transactional("records")
      async lock(): Promise<boolean> {
        return lockRow(this.widgets, "WIDGETS", row.pkWidget);
      }
    }

    await expect(new Inventory(widgets, gadgets).lock()).resolves.toBe(true);
    // Outside its layer's transaction there is nothing to lock in.
    expect(() => lockRow(gadgets, "GADGETS", "G-1")).toThrow(/outside a transaction/);
  });
});

describe("health with more than one layer", () => {
  it("reports every layer under TOKENS.IHealthProbe, and each under its own token", async () => {
    const { container } = twoLayers();

    const probe = container.resolve<IHealthProbe>(TOKENS.IHealthProbe);
    expect(probe).toBeInstanceOf(CompositeHealthProbe);
    expect(container.isRegistered(healthProbeToken("records"))).toBe(true);

    await expect(probe.report()).resolves.toEqual({
      ready: true,
      dataSource: "memory",
      database: "not_applicable",
      shuttingDown: false,
      layers: {
        records: { dataSource: "memory", database: "not_applicable" },
        documents: { dataSource: "memory", database: "not_applicable" },
      },
    });
  });

  it("keeps the single layer's own probe when there is only one", () => {
    const container = createContainer();
    registerPersistence({ container, dataSource: "memory", logger, entities: [] });

    expect(container.resolve(TOKENS.IHealthProbe)).not.toBeInstanceOf(CompositeHealthProbe);
  });
});
