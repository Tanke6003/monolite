// The ambient transaction: a module repository joins the open transaction by
// itself, without the service passing it anything.
//
// It is tested against SQL and deliberately not against memory. In memory the
// scope's repository **is the very same object** as the store, so a test there
// would pass just as well with the mechanism as without it: it would prove
// nothing. With SQL the difference is observable —the statement goes out through
// the transaction's connection or through the pool— and that is exactly what has
// to be checked.
import {
  AsyncTransactionContext,
  BaseModuleRepository,
  oracleDialect,
  SqlGenericRepository,
  SqlUnitOfWork,
  type IGenericRepository,
  type ITransactionContext,
} from "@monolite/data";
import type { ILogger } from "@monolite/core";
import { FakeSqlExecutor, silentLogger } from "../support/fake-sql-executor";
import { ITestItem, TEST_ENTITY } from "../support/test-entity";

/**
 * Stand-in for a module's repository. The original suite used the application's
 * `UsersRepository`; what it exercises is `BaseModuleRepository`, so the toy
 * entity serves just as well —and the logical entity name is what the ambient
 * transaction looks up.
 */
class ItemsRepository extends BaseModuleRepository<ITestItem> {
  constructor(
    store: IGenericRepository<ITestItem>,
    logger: ILogger,
    transactions?: ITransactionContext
  ) {
    super(store, logger, "ItemsRepository", "ITEMS", transactions);
  }
}

describe("ambient transaction", () => {
  /** The pool's connection, with auto-commit. */
  let pool: FakeSqlExecutor;
  /** The connection bound to the transaction. */
  let tx: FakeSqlExecutor;
  let transactions: AsyncTransactionContext;
  let unitOfWork: SqlUnitOfWork;
  let repository: ItemsRepository;

  /** Answers for an insert: the affected row and the read-back of the row. */
  const queueInsert = (executor: FakeSqlExecutor) =>
    executor
      .queue({ outBinds: { insertedId: [1] }, rowsAffected: 1 })
      .queue({ rows: [{ PK_ITEM: 1, NAME: "Ana" }] });

  beforeEach(() => {
    pool = new FakeSqlExecutor();
    tx = new FakeSqlExecutor();

    const store = new SqlGenericRepository<ITestItem>(
      pool,
      TEST_ENTITY,
      silentLogger,
      oracleDialect
    );
    transactions = new AsyncTransactionContext();

    unitOfWork = new SqlUnitOfWork(
      { transaction: (work) => work(tx) },
      new Map([["ITEMS", store as never]]),
      transactions
    );

    repository = new ItemsRepository(store, silentLogger, transactions);
  });

  it("outside a transaction, the statement goes out through the pool", async () => {
    queueInsert(pool);

    await repository.insert({ name: "Ana" });

    expect(pool.calls.length).toBeGreaterThan(0);
    expect(tx.calls).toHaveLength(0);
  });

  it("inside a transaction, the very same injected repository goes out through it", async () => {
    queueInsert(tx);

    // This is everything the service writes: not one extra parameter, no
    // `scope.repository(...)`.
    await unitOfWork.execute(async () => {
      await repository.insert({ name: "Ana" });
    });

    expect(tx.calls.length).toBeGreaterThan(0);
    expect(tx.calls[0].sql).toContain("INSERT INTO ITEMS");
    // And nothing went out through the pool, which is what would break
    // atomicity: an insert with auto-commit would survive the transaction's
    // rollback.
    expect(pool.calls).toHaveLength(0);
  });

  it("on leaving the transaction it goes back out through the pool", async () => {
    queueInsert(tx);
    await unitOfWork.execute(async () => repository.insert({ name: "Ana" }));

    expect(transactions.current()).toBeUndefined();

    queueInsert(pool);
    await repository.insert({ name: "Another" });

    expect(pool.calls.length).toBeGreaterThan(0);
  });

  it("with no context the repository never joins — the behaviour from before", async () => {
    const store = new SqlGenericRepository<ITestItem>(
      pool,
      TEST_ENTITY,
      silentLogger,
      oracleDialect
    );
    const isolated = new ItemsRepository(store, silentLogger);
    queueInsert(pool);

    await unitOfWork.execute(async () => {
      await isolated.insert({ name: "Ana" });
    });

    // It goes out through the pool even though a transaction is open. It is not
    // a bug: it is what lets a repository be built by hand in a test without
    // setting anything up.
    expect(pool.calls.length).toBeGreaterThan(0);
    expect(tx.calls).toHaveLength(0);
  });
});
