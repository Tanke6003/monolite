import type { ITransactionContext, ITransactionScope, IUnitOfWork } from "monolite-data";
import { Transactional, TransactionalBLL, lockRow } from "monolite-crud";

/**
 * A fake unit of work and transaction context, chained the way the real ones
 * are: `execute` publishes the scope for as long as the block runs, and takes
 * it away again afterwards.
 */
function harness() {
  const rowLock = jest.fn().mockResolvedValue(true);
  const scope = { repository: jest.fn(), lockRow: rowLock } as unknown as ITransactionScope;

  let active: ITransactionScope | undefined;

  const transactions: ITransactionContext = {
    current: () => active,
    run: (_scope, fn) => fn(),
  };

  const execute = jest.fn(async (work: (s: ITransactionScope) => Promise<unknown>) => {
    active = scope;
    try {
      return await work(scope);
    } finally {
      active = undefined;
    }
  });

  return {
    unitOfWork: { execute } as unknown as IUnitOfWork,
    transactions,
    execute,
    rowLock,
  };
}

class Service extends TransactionalBLL {
  /** Whether a transaction was open each time the method ran. */
  public readonly seen: boolean[] = [];

  constructor(unitOfWork: IUnitOfWork, transactions: ITransactionContext) {
    super(unitOfWork, transactions);
  }

  @Transactional()
  async inATransaction(): Promise<string> {
    this.seen.push(Boolean(this.transactions.current()));
    return "done";
  }

  @Transactional()
  async locking(id: number): Promise<boolean> {
    return this.lockRow("BRANCHES", id);
  }

  @Transactional()
  async callsAnotherDecoratedOne(): Promise<string> {
    return this.inATransaction();
  }

  @Transactional()
  async fails(): Promise<never> {
    throw new Error("a business rule");
  }

  async undecorated(): Promise<boolean> {
    return this.lockRow("BRANCHES", 1);
  }
}

describe("@Transactional", () => {
  it("opens a transaction and runs the method inside it", async () => {
    const { unitOfWork, transactions, execute } = harness();
    const service = new Service(unitOfWork, transactions);

    await expect(service.inATransaction()).resolves.toBe("done");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.seen).toEqual([true]);
  });

  it("lets lockRow find the transaction without receiving it as a parameter", async () => {
    // Taking the scope out of the signature is the whole reason the decorator
    // is worth having; without the ambient transaction the block would have to
    // be handed its scope and every caller would have to thread it down.
    const { unitOfWork, transactions, rowLock } = harness();

    await expect(new Service(unitOfWork, transactions).locking(7)).resolves.toBe(true);

    expect(rowLock).toHaveBeenCalledWith("BRANCHES", 7);
  });

  it("joins an open transaction instead of nesting another", async () => {
    const { unitOfWork, transactions, execute } = harness();

    await new Service(unitOfWork, transactions).callsAnotherDecoratedOne();

    // One transaction for both: if the inner one opened its own, it would
    // commit on its own what the outer one may still roll back.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates the error so the unit of work rolls back", async () => {
    const { unitOfWork, transactions } = harness();

    await expect(new Service(unitOfWork, transactions).fails()).rejects.toThrow("a business rule");
  });

  it("returns what the method returned, untouched", async () => {
    const { unitOfWork, transactions } = harness();

    await expect(new Service(unitOfWork, transactions).inATransaction()).resolves.toBe("done");
  });

  it("explains the failure when the class supplies no unit of work", async () => {
    class Loose {
      @Transactional()
      async something(): Promise<void> {}
    }

    // It rejects rather than throwing: the decorated method is awaited, and a
    // synchronous error escaping something that looks asynchronous slips past
    // the caller's try/catch.
    await expect(new Loose().something()).rejects.toThrow(/Extend TransactionalBLL/i);
  });
});

describe("lockRow", () => {
  it("fails outside a transaction, saying what is missing", async () => {
    // The silent failure would be writing with no lock while believing the
    // exclusion was in place.
    const { unitOfWork, transactions } = harness();

    await expect(new Service(unitOfWork, transactions).undecorated()).rejects.toThrow(
      /missing @Transactional/
    );
  });

  /**
   * It stands on its own, and not only as a method of the base class, because
   * TypeScript has no multiple inheritance: a service that already extends
   * `CrudBLL` cannot also extend `TransactionalBLL`, and it still needs
   * to lock.
   */
  it("works as a plain function for a service that cannot extend the base", async () => {
    const { unitOfWork, transactions, rowLock } = harness();

    class Standalone {
      constructor(
        readonly unitOfWork: IUnitOfWork,
        readonly transactions: ITransactionContext
      ) {}

      @Transactional()
      async book(id: number): Promise<boolean> {
        return lockRow(this.transactions, "BRANCHES", id);
      }
    }

    await expect(new Standalone(unitOfWork, transactions).book(3)).resolves.toBe(true);
    expect(rowLock).toHaveBeenCalledWith("BRANCHES", 3);
  });

  it("names the entity that was being locked", () => {
    const transactions: ITransactionContext = { current: () => undefined, run: (_s, fn) => fn() };

    expect(() => lockRow(transactions, "APPOINTMENTS", 1)).toThrow(/lockRow\("APPOINTMENTS"\)/);
  });
});
