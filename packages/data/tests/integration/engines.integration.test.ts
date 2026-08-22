import { CONTRACT_ENTITY, runGenericRepositoryContract, type ContractItem } from "monolite-data";
import type { IGenericRepository, IRawQueryable } from "monolite-data";
import { asRawQueryable } from "monolite-data";
import { storeToken } from "monolite-di";

import { ENTITY, selectedEngines, type IOrder, type IProduct } from "./support/engines";
import { bringUp, seed, type Harness, type Seeded } from "./support/harness";

/**
 * The claim, checked against the engines it is made about.
 *
 * "One `IGenericRepository<T>` over six engines" was verified, until now, against
 * an array and two doubles. That is not nothing — the doubles evaluate the
 * generated SQL rather than nodding at it — but it cannot catch the class of bug
 * where the engine and the double disagree, and that class shipped twice: a
 * transaction the repositories did not join, and a boolean column the mapping
 * could not write into.
 *
 * Everything here runs against a real server, over a schema this repository
 * generated from the same metadata the repository reads, through the same
 * `registerPersistence` an application calls.
 */

// Oracle takes the longest to answer the first statement of a run, and the
// default budget is for unit tests.
jest.setTimeout(180_000);

const ENGINES = selectedEngines();

if (ENGINES.length === 0) {
  // Not a silent skip: a run that verifies nothing must say so out loud.
  throw new Error("MONOLITE_IT_ENGINES selected no engine; there is nothing to verify.");
}

describe.each(ENGINES.map((engine) => [engine.id, engine] as const))("%s", (_id, engine) => {
  let harness: Harness;
  let rows: Seeded;

  beforeAll(async () => {
    harness = await bringUp(engine);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    rows = await seed(harness);
  });

  // ────────────────────────────────────────────────────────── the schema ───

  describe("the generated schema", () => {
    /**
     * The one that cost an afternoon before the generator existed.
     *
     * The mapping writes a boolean as `1` and `0`, so a column declared
     * `BOOLEAN` rejects every insert the repository makes. Nothing in a double
     * can tell you that; the server can.
     */
    it("takes the values the mapping writes, booleans included", async () => {
      const written = await harness.products.insert({
        categoryId: rows.categoryId,
        sku: "BOOL-1",
        name: "Flagged",
        stock: 1,
        priceCents: 100,
        available: false,
      });

      const read = await harness.products.getById(written.pkProduct, { withDeleted: true });

      expect(read?.available).toBe(false);
      expect(read?.sku).toBe("BOOL-1");
    });

    it("generated a key the engine fills in", async () => {
      expect(rows.widget.pkProduct).toEqual(expect.any(Number));
      expect(rows.gadget.pkProduct).not.toBe(rows.widget.pkProduct);
    });

    (engine.sql ? it : it.skip)("generated a foreign key that refuses an orphan", async () => {
      await expect(
        harness.lines.insert({
          orderId: 999_999,
          productId: rows.widget.pkProduct,
          quantity: 1,
          unitPriceCents: 100,
        })
      ).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────── the contract ───

  describe("the shared contract", () => {
    runGenericRepositoryContract(engine.id, {
      create: async () => {
        const store = harness.container.resolve<IGenericRepository<ContractItem>>(
          storeToken(CONTRACT_ENTITY.table)
        );

        // The suite wants an empty repository per test and reaches for this
        // before our own `beforeEach` has run on some orders, so it empties the
        // table itself rather than assuming.
        await store.hardDeleteWhere({} as never);
        return store;
      },
    });
  });

  // ──────────────────────────────────────────────────────────── queries ───

  describe("queries", () => {
    it("filters, orders and pages over real rows", async () => {
      const page = await harness.products.getPaged(1, 1, {
        where: { categoryId: rows.categoryId },
        orderBy: { field: "priceCents", direction: "desc" },
      });

      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.sku).toBe("GAD-1");
    });

    it("speaks the operators the filter language promises", async () => {
      const dear = await harness.products.find({ where: { priceCents: { gte: 1000 } } });
      expect(dear.map((one) => one.sku)).toEqual(["GAD-1"]);

      const named = await harness.products.find({ where: { name: { like: "%idge%" } } });
      expect(named.map((one) => one.sku)).toEqual(["WID-1"]);

      const both = await harness.products.find({
        where: { sku: { in: ["WID-1", "GAD-1"] } },
        orderBy: { field: "sku" },
      });
      expect(both).toHaveLength(2);

      await expect(harness.products.count({ categoryId: rows.categoryId })).resolves.toBe(2);
      await expect(harness.products.exists({ sku: "WID-1" })).resolves.toBe(true);
    });

    it("joins nothing, and says so by needing two reads", async () => {
      const order = await harness.orders.insert({
        reference: "REF-READ",
        status: "placed",
        totalCents: 500,
      });
      await harness.lines.insert({
        orderId: order.pkOrder,
        productId: rows.widget.pkProduct,
        quantity: 1,
        unitPriceCents: 500,
      });

      const lines = await harness.lines.find({ where: { orderId: order.pkOrder } });
      const products = await harness.products.find({
        where: { pkProduct: { in: lines.map((line) => line.productId) } },
      });

      expect(lines).toHaveLength(1);
      expect(products[0]?.sku).toBe("WID-1");
    });
  });

  // ──────────────────────────────────────────────────────────── updates ───

  describe("updates", () => {
    it("writes one row and reads the change back", async () => {
      const updated = await harness.products.update(rows.widget.pkProduct as never, { stock: 7 });

      expect(updated?.stock).toBe(7);
      await expect(
        harness.products.getById(rows.widget.pkProduct).then((one) => one?.stock)
      ).resolves.toBe(7);
    });

    it("writes several rows at once and reports how many", async () => {
      const affected = await harness.products.updateWhere(
        { categoryId: rows.categoryId },
        { priceCents: 999 }
      );

      expect(affected).toBe(2);
      const all = await harness.products.getAll();
      expect(all.every((one) => one.priceCents === 999)).toBe(true);
    });

    it("soft deletes, hides, and restores", async () => {
      await expect(harness.products.softDelete(rows.gadget.pkProduct as never)).resolves.toBe(true);

      await expect(harness.products.getAll()).resolves.toHaveLength(1);
      await expect(
        harness.products.getAll({ withDeleted: true })
      ).resolves.toHaveLength(2);

      await expect(harness.products.restore(rows.gadget.pkProduct as never)).resolves.toBe(true);
      await expect(harness.products.getAll()).resolves.toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────── transactions ───

  describe("transactions", () => {
    /** An order is a header, its lines, and the stock it consumed. */
    const placeOrder = async (reference: string, quantity: number, thenThrow?: Error) => {
      return harness.unitOfWork.execute(async (scope) => {
        const products = scope.repository<IProduct>(ENTITY.products);
        const orders = scope.repository<IOrder>(ENTITY.orders);
        const lines = scope.repository(ENTITY.orderLines);

        await scope.lockRow(ENTITY.products, rows.widget.pkProduct);
        const product = await products.getById(rows.widget.pkProduct as never);
        if (!product) throw new Error("the seeded product vanished");

        const order = await orders.insert({
          reference,
          status: "placed",
          totalCents: product.priceCents * quantity,
        });

        await lines.insert({
          orderId: order.pkOrder,
          productId: product.pkProduct,
          quantity,
          unitPriceCents: product.priceCents,
        });

        await products.update(product.pkProduct as never, { stock: product.stock - quantity });

        if (thenThrow) throw thenThrow;
        return order;
      });
    };

    it("commits three tables together", async () => {
      const order = await placeOrder("REF-OK", 3);

      await expect(harness.orders.count()).resolves.toBe(1);
      await expect(harness.lines.count({ orderId: order.pkOrder })).resolves.toBe(1);
      await expect(
        harness.products.getById(rows.widget.pkProduct).then((one) => one?.stock)
      ).resolves.toBe(7);
    });

    /**
     * The half that matters. Three writes across three tables, and the last
     * statement throws — none of them may survive.
     *
     * This is what a double cannot check: a repository writing on the pool's
     * connection while a transaction is open looks identical until something
     * fails, and then the rows are already committed with nothing left to undo.
     */
    it("rolls all three back when the last one throws", async () => {
      await expect(placeOrder("REF-BAD", 3, new Error("no"))).rejects.toThrow("no");

      await expect(harness.orders.count()).resolves.toBe(0);
      await expect(harness.lines.count()).resolves.toBe(0);
      await expect(
        harness.products.getById(rows.widget.pkProduct).then((one) => one?.stock)
      ).resolves.toBe(10);
    });

    /**
     * The store a module injects, inside a transaction it was never handed.
     *
     * `registerPersistence` wraps every store in `transactionAware`, so a BLL
     * that injected one and never mentions a transaction still joins the open
     * one. Before 0.6.0 this wrote on the pool and committed on its own, which
     * only a real engine can show.
     */
    it("makes an injected store join the open transaction", async () => {
      await expect(
        harness.unitOfWork.execute(async () => {
          // Not `scope.repository(...)`: the very reference resolved at startup.
          await harness.products.update(rows.widget.pkProduct as never, { stock: 1 });
          throw new Error("undo it");
        })
      ).rejects.toThrow("undo it");

      await expect(
        harness.products.getById(rows.widget.pkProduct).then((one) => one?.stock)
      ).resolves.toBe(10);
    });

    (engine.sql ? it : it.skip)("holds a row lock until the transaction ends", async () => {
      // Both transactions take the same row. The unit of work serialises them,
      // so the second sees what the first committed rather than the snapshot it
      // started from — which is the whole reason the lock goes first.
      await placeOrder("REF-1", 2);
      await placeOrder("REF-2", 3);

      await expect(
        harness.products.getById(rows.widget.pkProduct).then((one) => one?.stock)
      ).resolves.toBe(5);
    });
  });

  // ───────────────────────────────────────────────────────── procedures ───

  (engine.sql ? describe : describe.skip)("stored procedures", () => {
    const raw = (): IRawQueryable<IProduct> => {
      const sql = asRawQueryable(harness.products);
      if (!sql) throw new Error(`${engine.id} should expose executeRaw`);
      return sql;
    };

    /** Engines disagree about the case and the type an aggregate comes back as. */
    const read = (row: Record<string, unknown>, column: string): number => {
      const found = Object.entries(row).find(([key]) => key.toLowerCase() === column.toLowerCase());
      return Number(found?.[1] ?? 0);
    };

    it("calls one that reads, through the documented escape hatch", async () => {
      const { sql, binds } = harness.procedures!.callSummary(rows.categoryId);
      const result = await raw().executeRaw<Record<string, unknown>>(sql, binds);

      expect(result).toHaveLength(1);
      expect(read(result[0]!, "products")).toBe(2);
      expect(read(result[0]!, "units")).toBe(14);
    });

    it("calls one that writes", async () => {
      const { sql, binds } = harness.procedures!.callTakeStock(rows.widget.pkProduct, 4);
      await raw().executeRaw(sql, binds);

      await expect(
        harness.products.getById(rows.widget.pkProduct).then((one) => one?.stock)
      ).resolves.toBe(6);
    });

    /**
     * And the one that ties the escape hatch back to everything above: a
     * procedure called inside a transaction has to run on that transaction's
     * connection.
     *
     * If `executeRaw` reached for the pool, the procedure's write would commit
     * on its own and survive the rollback — silently, and only ever on a real
     * server. This is the same failure as #22 wearing a different hat.
     */
    it("runs one inside the caller's transaction, and rolls it back", async () => {
      const { sql, binds } = harness.procedures!.callTakeStock(rows.widget.pkProduct, 4);

      await expect(
        harness.unitOfWork.execute(async (scope) => {
          const store = scope.repository<IProduct>(ENTITY.products);
          const scoped = asRawQueryable(store);
          if (!scoped) throw new Error("the scoped store should expose executeRaw");

          await scoped.executeRaw(sql, binds);
          throw new Error("undo the procedure");
        })
      ).rejects.toThrow("undo the procedure");

      await expect(
        harness.products.getById(rows.widget.pkProduct).then((one) => one?.stock)
      ).resolves.toBe(10);
    });

    it("still reads the mapping's own column names", () => {
      expect(raw().schema.columnOf("stock")).toBe("STOCK");
      expect(raw().schema.table).toBe(ENTITY.products);
    });
  });
});
