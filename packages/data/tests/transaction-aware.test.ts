import type { IGenericRepository, ITransactionContext, ITransactionScope } from "monolite-data";
import { transactionAware } from "monolite-data";

interface Widget {
  pkWidget: number;
  name: string;
}

/**
 * The store a module injects, and the one the transaction hands out.
 *
 * They are deliberately different objects with different recorders: the whole
 * question this file answers is *which one a call reached*, and two stores that
 * shared state could not tell them apart.
 */
function recorder(label: string) {
  const calls: string[] = [];

  const store = {
    calls,
    label,
    insert: jest.fn(async (entity: Partial<Widget>) => {
      calls.push(`insert ${entity.name}`);
      return { pkWidget: 1, name: entity.name ?? "" };
    }),
    update: jest.fn(async () => {
      calls.push("update");
      return null;
    }),
    getById: jest.fn(async () => {
      calls.push("getById");
      return null;
    }),
  };

  return store as unknown as IGenericRepository<Widget> & { calls: string[]; label: string };
}

/** A context that is inside a transaction only while `scope` is set. */
function contextOf(scope: ITransactionScope | null): ITransactionContext {
  return { current: () => scope } as unknown as ITransactionContext;
}

function scopeOf(store: IGenericRepository<Widget>): ITransactionScope {
  return {
    repository: () => store,
    lockRow: async () => true,
  } as unknown as ITransactionScope;
}

describe("transactionAware", () => {
  let pool: ReturnType<typeof recorder>;
  let bound: ReturnType<typeof recorder>;

  beforeEach(() => {
    pool = recorder("pool");
    bound = recorder("transaction");
  });

  it("uses the pool's store when no transaction is open", async () => {
    const store = transactionAware<Widget>(pool, "WIDGETS", contextOf(null));

    await store.insert({ name: "outside" });

    expect(pool.calls).toEqual(["insert outside"]);
    expect(bound.calls).toEqual([]);
  });

  /**
   * The regression, and the one that would have failed before this existed.
   *
   * A service holding an injected store used to write on the pool's connection
   * no matter what `@Transactional()` had opened — quietly, because three
   * auto-commits look exactly like one transaction until something throws in
   * the middle.
   */
  it("uses the transaction's store while one is open", async () => {
    const store = transactionAware<Widget>(pool, "WIDGETS", contextOf(scopeOf(bound)));

    await store.insert({ name: "inside" });

    expect(bound.calls).toEqual(["insert inside"]);
    expect(pool.calls).toEqual([]);
  });

  /**
   * Resolved per call, not once when it was built. The same reference a module
   * injected at startup has to answer differently depending on when it is used,
   * which is the only way ambient transactions can work at all.
   */
  it("follows the transaction opening and closing under the same reference", async () => {
    // The context is read on every access, so moving what `current()` answers is
    // what a real unit of work does when it opens and commits.
    let scope: ITransactionScope | null = null;
    const live = transactionAware<Widget>(
      pool,
      "WIDGETS",
      { current: () => scope } as unknown as ITransactionContext
    );

    await live.insert({ name: "before" });
    scope = scopeOf(bound);
    await live.insert({ name: "during" });
    scope = null;
    await live.insert({ name: "after" });

    expect(pool.calls).toEqual(["insert before", "insert after"]);
    expect(bound.calls).toEqual(["insert during"]);
  });

  it("asks the transaction for this entity and no other", async () => {
    const asked: string[] = [];
    const scope = {
      repository: (entity: string) => {
        asked.push(entity);
        return bound;
      },
      lockRow: async () => true,
    } as unknown as ITransactionScope;

    await transactionAware<Widget>(pool, "WIDGETS", contextOf(scope)).insert({ name: "x" });

    expect(asked).toEqual(["WIDGETS"]);
  });

  /**
   * `executeRaw` and `schema` are not on `IGenericRepository` — they belong to
   * the SQL store — and a module that narrows to them has to keep finding them
   * through the wrapper. Inside a transaction they must come from the
   * transaction's store too: raw SQL on the pool's connection while a
   * transaction holds locks is the deadlock this whole change is about.
   */
  it("forwards what is not on the contract, from whichever store is live", async () => {
    const poolSql = Object.assign(pool, { executeRaw: jest.fn(async () => ["pool"]) });
    const boundSql = Object.assign(bound, { executeRaw: jest.fn(async () => ["transaction"]) });

    const outside = transactionAware<Widget>(poolSql, "WIDGETS", contextOf(null));
    const inside = transactionAware<Widget>(poolSql, "WIDGETS", contextOf(scopeOf(boundSql)));

    type Raw = { executeRaw(sql: string): Promise<string[]> };

    await expect((outside as unknown as Raw).executeRaw("SELECT 1")).resolves.toEqual(["pool"]);
    await expect((inside as unknown as Raw).executeRaw("SELECT 1")).resolves.toEqual(["transaction"]);
  });

  it("reports a member as present when the live store has it", () => {
    const withRaw = Object.assign(recorder("sql"), { executeRaw: jest.fn() });
    const plain = recorder("memory");

    expect("executeRaw" in transactionAware<Widget>(withRaw, "W", contextOf(null))).toBe(true);
    expect("executeRaw" in transactionAware<Widget>(plain, "W", contextOf(null))).toBe(false);
  });
});
