import {
  MemoryGenericRepository,
  MemoryUnitOfWork,
  oracleDialect,
  SqlGenericRepository,
  SqlUnitOfWork,
} from "monolite-data";
import { FakeSqlExecutor, silentLogger } from "../support/fake-sql-executor";
import { ITestItem, SEED, TEST_ENTITY } from "../support/test-entity";

describe("MemoryUnitOfWork", () => {
  let store: MemoryGenericRepository<ITestItem>;
  let unitOfWork: MemoryUnitOfWork;

  beforeEach(() => {
    store = new MemoryGenericRepository<ITestItem>(TEST_ENTITY, SEED);
    unitOfWork = new MemoryUnitOfWork(new Map([["ITEMS", store as never]]));
  });

  it("commits the changes when the block finishes cleanly", async () => {
    const result = await unitOfWork.execute(async (scope) => {
      await scope.repository<ITestItem>("ITEMS").hardDeleteWhere({ qty: { lte: 10 } });
      return "done";
    });

    expect(result).toBe("done");
    expect(await store.count()).toBe(2);
  });

  it("rolls everything back if the block throws", async () => {
    await expect(
      unitOfWork.execute(async (scope) => {
        const items = scope.repository<ITestItem>("ITEMS");
        await items.hardDeleteWhere({});
        expect(await items.count()).toBe(0);
        throw new Error("failed halfway");
      })
    ).rejects.toThrow("failed halfway");

    // The state goes back to how it was before starting.
    expect(await store.count()).toBe(3);
    expect((await store.getAll({ orderBy: { field: "pkItem" } })).map((i) => i.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("throws a clear error when an unregistered entity is asked for", async () => {
    await expect(unitOfWork.execute(async (scope) => scope.repository("UNKNOWN"))).rejects.toThrow(
      /is not registered in the unit of work/
    );
  });

  describe("isolation", () => {
    it("lockRow says whether the row exists", async () => {
      await unitOfWork.execute(async (scope) => {
        expect(await scope.lockRow("ITEMS", 1)).toBe(true);
        expect(await scope.lockRow("ITEMS", 999)).toBe(false);
      });
    });

    it("does not interleave two transactions: the second sees what the first committed", async () => {
      const observed: number[] = [];

      // Each block reads, yields to the event loop and writes. Without exclusion
      // both would read 3 and both would insert: it is exactly the shape of the
      // "check and then write" race.
      const transaction = () =>
        unitOfWork.execute(async (scope) => {
          const items = scope.repository<ITestItem>("ITEMS");
          const before = await items.count();
          observed.push(before);

          await new Promise((resolve) => setImmediate(resolve));
          await items.insert({ name: `item-${before}`, qty: 1 });
        });

      await Promise.all([transaction(), transaction(), transaction()]);

      // Each one started from what the previous one left, not from the same snapshot.
      expect(observed).toEqual([3, 4, 5]);
      expect(await store.count()).toBe(6);
    });

    it("a failing transaction does not roll back what another one had already committed", async () => {
      await unitOfWork.execute(async (scope) => {
        await scope.repository<ITestItem>("ITEMS").insert({ name: "committed", qty: 1 });
      });

      await expect(
        unitOfWork.execute(async (scope) => {
          await scope.repository<ITestItem>("ITEMS").insert({ name: "rolled-back", qty: 1 });
          throw new Error("failure");
        })
      ).rejects.toThrow("failure");

      const names = (await store.getAll()).map((item) => item.name);
      expect(names).toContain("committed");
      expect(names).not.toContain("rolled-back");
    });

    it("a failure does not break the queue: the next transaction still runs", async () => {
      await expect(
        unitOfWork.execute(async () => Promise.reject(new Error("boom")))
      ).rejects.toThrow("boom");

      await expect(unitOfWork.execute(async () => "still alive")).resolves.toBe("still alive");
    });
  });
});

describe("SqlUnitOfWork", () => {
  let executor: FakeSqlExecutor;
  let transactionExecutor: FakeSqlExecutor;
  let repository: SqlGenericRepository<ITestItem>;
  let db: any;
  let unitOfWork: SqlUnitOfWork;

  beforeEach(() => {
    executor = new FakeSqlExecutor();
    transactionExecutor = new FakeSqlExecutor();
    repository = new SqlGenericRepository<ITestItem>(
      executor,
      TEST_ENTITY,
      silentLogger,
      oracleDialect
    );

    // Stand-in for the pool: it hands the transaction context to the block.
    db = { transaction: jest.fn((work: any) => work(transactionExecutor)) };

    unitOfWork = new SqlUnitOfWork(db, new Map([["ITEMS", repository as never]]));
  });

  it("runs the block inside a driver transaction", async () => {
    const result = await unitOfWork.execute(async () => "ok");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(result).toBe("ok");
  });

  it("the scope's repository writes through the transaction's connection", async () => {
    transactionExecutor.queue({ rowsAffected: 1 });

    await unitOfWork.execute(async (scope) => {
      await scope.repository<ITestItem>("ITEMS").hardDelete(1);
    });

    expect(transactionExecutor.calls).toHaveLength(1);
    // Nothing went out through the pool with auto-commit.
    expect(executor.calls).toHaveLength(0);
  });

  it("returns the same instance when the same entity is asked for twice", async () => {
    await unitOfWork.execute(async (scope) => {
      expect(scope.repository("ITEMS")).toBe(scope.repository("ITEMS"));
    });
  });

  it("throws a clear error when the entity is not registered", async () => {
    await expect(unitOfWork.execute(async (scope) => scope.repository("UNKNOWN"))).rejects.toThrow(
      /is not registered in the unit of work/
    );
  });

  it("propagates the block's error so that the driver rolls back", async () => {
    await expect(
      unitOfWork.execute(async () => {
        throw new Error("failure");
      })
    ).rejects.toThrow("failure");
  });

  describe("lockRow", () => {
    it("locks the row through the transaction's connection, not through the pool", async () => {
      transactionExecutor.queue({ rows: [{ PK_ITEM: 1 }] });

      const locked = await unitOfWork.execute((scope) => scope.lockRow("ITEMS", 1));

      expect(locked).toBe(true);
      expect(executor.calls).toHaveLength(0);

      const [call] = transactionExecutor.calls;
      expect(call.sql).toBe("SELECT PK_ITEM FROM ITEMS WHERE PK_ITEM = :pk FOR UPDATE");
      expect(call.binds).toEqual({ pk: 1 });
    });

    it("returns false when the row does not exist", async () => {
      transactionExecutor.queue({ rows: [] });

      await expect(unitOfWork.execute((scope) => scope.lockRow("ITEMS", 99))).resolves.toBe(false);
    });
  });
});
