import type { ClientSession } from "mongodb";
import {
  MongoGenericRepository,
  MongoUnitOfWork,
  type IMongoTransactionRunner,
} from "@monolite/data";
import { FakeMongoDataSource } from "../support/fake-mongo";
import { silentLogger } from "../support/fake-sql-executor";
import { ITestItem, TEST_ENTITY } from "../support/test-entity";

/**
 * Fake connector: it hands over a session and records whether the block finished
 * cleanly. That is enough to check what the unit of work does, which is to hand
 * out repositories bound to that session.
 */
class FakeTransactionRunner implements IMongoTransactionRunner {
  readonly session = { id: "session-1" } as unknown as ClientSession;
  started = 0;

  async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    this.started += 1;
    return work(this.session);
  }
}

describe("MongoUnitOfWork", () => {
  let db: FakeMongoDataSource;
  let runner: FakeTransactionRunner;
  let store: MongoGenericRepository<ITestItem>;
  let unitOfWork: MongoUnitOfWork;

  beforeEach(() => {
    db = new FakeMongoDataSource();
    db.collectionOf("ITEMS").seed([
      { PK_ITEM: 1, NAME: "alpha", QTY: 10, ACTIVE: 1 },
      { PK_ITEM: 2, NAME: "beta", QTY: 20, ACTIVE: 1 },
    ]);

    runner = new FakeTransactionRunner();
    store = new MongoGenericRepository<ITestItem>(db, TEST_ENTITY, silentLogger);
    unitOfWork = new MongoUnitOfWork(runner, new Map([["ITEMS", store as never]]));
  });

  it("opens a transaction and returns whatever the block produces", async () => {
    const result = await unitOfWork.execute(async (scope) => {
      await scope.repository<ITestItem>("ITEMS").hardDeleteWhere({ qty: { lte: 10 } });
      return "done";
    });

    expect(result).toBe("done");
    expect(runner.started).toBe(1);
    expect(await store.count()).toBe(1);
  });

  it("hands out the repositories bound to the transaction's session", async () => {
    await unitOfWork.execute(async (scope) => {
      await scope.repository<ITestItem>("ITEMS").getAll();
    });

    expect(db.calls.at(-1)?.session).toBe(runner.session);
  });

  it("memoizes per entity: two requests return the same instance", async () => {
    await unitOfWork.execute(async (scope) => {
      expect(scope.repository("ITEMS")).toBe(scope.repository("ITEMS"));
    });
  });

  it("throws a clear error when an unregistered entity is asked for", async () => {
    await expect(unitOfWork.execute(async (scope) => scope.repository("UNKNOWN"))).rejects.toThrow(
      /is not registered in the unit of work/
    );
  });

  it("propagates the block's error untouched, so the service decides", async () => {
    await expect(
      unitOfWork.execute(async () => {
        throw new Error("failed halfway");
      })
    ).rejects.toThrow("failed halfway");
  });
});
