import path from "node:path";
import ts from "typescript";

import {
  AsyncTransactionContext,
  defineEntity,
  MemoryGenericRepository,
  MemoryUnitOfWork,
  transactionAware,
  type IGenericRepository,
  type ITransactionContext,
  type IUnitOfWork,
  type MemoryRepositoryRegistry,
} from "monolite-data";
import { CrudBLL, lockRow, Transactional, type EntityMapper } from "monolite-crud";

/**
 * `CrudBLL`'s transaction seam (#33), exercised on the in-memory driver with a
 * real unit of work rather than a fake one: the question here is whether a row
 * is left behind, and only a unit of work that actually rolls back can answer
 * it.
 */

interface Payment {
  pkPayment: number;
  amount: number;
  active?: boolean;
}

interface PaymentDto {
  id: number;
  amount: number;
}

const PAYMENT_ENTITY = defineEntity<Payment>({
  table: "PAYMENTS",
  primaryKey: "pkPayment",
  identity: true,
  columns: {
    pkPayment: { name: "PK_PAYMENT", kind: "number", insertable: false, updatable: false },
    amount: { name: "AMOUNT", kind: "number" },
    active: { name: "ACTIVE", kind: "boolean" },
  },
  softDelete: { property: "active", activeValue: 1, deletedValue: 0 },
});

const mapper: EntityMapper<Payment, PaymentDto> = {
  toDTO: (entity) => ({ id: entity.pkPayment, amount: entity.amount }),
  toDTOList: (entities) => entities.map((entity) => ({ id: entity.pkPayment, amount: entity.amount })),
  toEntity: (dto) => ({ amount: dto.amount }),
  toPartialEntity: (dto) => (dto.amount === undefined ? {} : { amount: dto.amount }),
};

/**
 * The persistence layer in miniature: one store, the unit of work over it and
 * the context both share — bound the way `registerPersistence` binds them.
 *
 * `withSeam: false` is the configuration with no unit of work registered, which
 * is what a module's unit tests and an application that never passed a
 * transaction context both run on.
 */
function persistence({ withSeam = true } = {}) {
  const table = new MemoryGenericRepository<Payment>(PAYMENT_ENTITY, []);
  const transactions = new AsyncTransactionContext();
  const unitOfWork = new MemoryUnitOfWork(
    new Map([["PAYMENTS", table]]) as unknown as MemoryRepositoryRegistry,
    transactions
  );
  const execute = jest.spyOn(unitOfWork, "execute");

  const store = withSeam
    ? transactionAware<Payment>(table, "PAYMENTS", transactions, unitOfWork)
    : (table as IGenericRepository<Payment>);

  return { table, store, unitOfWork, transactions, execute };
}

/** A module the way the generator writes it: repository and mapper, nothing else. */
class PaymentsBLL extends CrudBLL<Payment, PaymentDto> {
  constructor(store: IGenericRepository<Payment>) {
    super(store, mapper);
  }
}

/** The shape the issue asks for: a rule, a decorator, and no extra constructor argument. */
class RuledPaymentsBLL extends CrudBLL<Payment, PaymentDto> {
  /** Whether the rule ran inside a transaction, each time. */
  public readonly seen: boolean[] = [];

  constructor(
    store: IGenericRepository<Payment>,
    private readonly transactionsForTheTest: ITransactionContext
  ) {
    super(store, mapper);
  }

  @Transactional()
  override async create(dto: Partial<PaymentDto>): Promise<PaymentDto> {
    const created = await super.create(dto);
    this.seen.push(Boolean(this.transactionsForTheTest.current()));

    // The rule that fails after the write: the point at which a missing
    // transaction leaves a row nobody wanted behind.
    if ((dto.amount ?? 0) < 0) throw new Error("a negative payment");
    return created;
  }

  @Transactional()
  async createTwo(first: number, second: number): Promise<PaymentDto[]> {
    return [await this.create({ amount: first }), await this.create({ amount: second })];
  }

  @Transactional()
  async lockPayment(id: number): Promise<boolean> {
    return lockRow(this, "PAYMENTS", id);
  }

  async lockWithoutATransaction(id: number): Promise<boolean> {
    return lockRow(this, "PAYMENTS", id);
  }

  async createBoth(first: number, second: number): Promise<void> {
    await this.tx(async () => {
      await this.repository.insert({ amount: first });
      if (second < 0) throw new Error("the second one");
      await this.repository.insert({ amount: second });
    });
  }
}

describe("@Transactional on a CrudBLL subclass, with no second base class", () => {
  it("resolves, running the override inside a transaction", async () => {
    // It used to reject: CrudBLL had no unit of work for the decorator to find,
    // and a generated module had no way to get one without a second base class
    // or an extra constructor argument.
    const { store, transactions, execute } = persistence();
    const service = new RuledPaymentsBLL(store, transactions);

    await expect(service.create({ amount: 10 })).resolves.toEqual({ id: 1, amount: 10 });

    expect(service.seen).toEqual([true]);
    // One transaction: the default create inside the override joined it.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("leaves no row behind when the override throws after super.create", async () => {
    // The assertion that fails without the seam: the insert went out on its
    // own, the rule threw afterwards, and the row stayed.
    const { table, store, transactions } = persistence();

    await expect(new RuledPaymentsBLL(store, transactions).create({ amount: -5 })).rejects.toThrow(
      "a negative payment"
    );

    expect(await table.count()).toBe(0);
  });

  it("commits once when a decorated method calls another decorated one", async () => {
    const { table, store, transactions, execute } = persistence();

    await new RuledPaymentsBLL(store, transactions).createTwo(1, 2);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(await table.count()).toBe(2);
  });

  it("rolls the first write back when the second call of a nested pair throws", async () => {
    // Joining is only worth anything if the inner call cannot commit on its
    // own what the outer one then rolls back.
    const { table, store, transactions } = persistence();

    await expect(new RuledPaymentsBLL(store, transactions).createTwo(1, -1)).rejects.toThrow();

    expect(await table.count()).toBe(0);
  });

  it("still rejects, with the same message, when no unit of work is registered", async () => {
    // That configuration keeps its explicit failure rather than silently
    // auto-committing: a decorator that ran the body bare would look atomic
    // and not be.
    const { table, store, transactions } = persistence({ withSeam: false });

    const rejection = new RuledPaymentsBLL(store, transactions).create({ amount: 10 });

    await expect(rejection).rejects.toThrow(
      /\[Transactional\] create is decorated but its class exposes no unitOfWork and no transactions\./
    );
    expect(await table.count()).toBe(0);
  });
});

describe("CrudBLL's default writes", () => {
  it("open a transaction for create, update and softDelete when there is a unit of work", async () => {
    // A generated module overrides nothing, so the default is what decides
    // whether it is atomic. Safe by default is the direction that fails
    // cheaply: a transaction around one insert, rather than none around four.
    const { store, execute } = persistence();
    const service = new PaymentsBLL(store);

    const created = await service.create({ amount: 10 });
    await service.update(created.id, { amount: 20 });
    await service.softDelete(created.id);

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("do not open one for reads", async () => {
    const { store, execute } = persistence();
    const service = new PaymentsBLL(store);

    await service.list(1, 10);
    await service.get(1);

    expect(execute).not.toHaveBeenCalled();
  });

  it("keep working on a store with no unit of work, as they always did", async () => {
    // What every generated test suite runs on. `tx()` refuses there; the
    // default path must not, or no module could be created in a unit test.
    const { table, store } = persistence({ withSeam: false });

    await expect(new PaymentsBLL(store).create({ amount: 10 })).resolves.toEqual({
      id: 1,
      amount: 10,
    });
    expect(await table.count()).toBe(1);
  });

  it("go back to auto-commit when a module overrides tx() to run the callback as is", async () => {
    // The documented way out, for a hot insert path or a deployment with no
    // transactions to open (MongoDB without a replica set).
    class AutoCommitBLL extends PaymentsBLL {
      protected override tx<R>(fn: () => Promise<R>): Promise<R> {
        return fn();
      }
    }

    const { store, execute } = persistence();

    await new AutoCommitBLL(store).create({ amount: 10 });

    expect(execute).not.toHaveBeenCalled();
  });

  it("find the seam through a module repository wrapping the store", async () => {
    // The generator tells people to swap the plain store for their module
    // repository; doing it must not quietly turn the defaults back into
    // auto-commits.
    const { BaseModuleRepository } = await import("monolite-data");

    class PaymentsRepository extends BaseModuleRepository<Payment> {
      constructor(store: IGenericRepository<Payment>) {
        super(store, { error: () => undefined } as never, "PaymentsRepository");
      }
    }

    const { store, execute } = persistence();

    await new PaymentsBLL(new PaymentsRepository(store)).create({ amount: 10 });

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("lockRow(this, ...) on a CrudBLL subclass", () => {
  it("finds the transaction through the service, with no context member to pass", async () => {
    // The seam came with the store, so the class has no `transactions` to hand
    // lockRow; passing the service is how it still locks.
    const { store, transactions } = persistence();
    const service = new RuledPaymentsBLL(store, transactions);
    const { id } = await service.create({ amount: 10 });

    await expect(service.lockPayment(id)).resolves.toBe(true);
  });

  it("still fails outside a transaction, saying what is missing", async () => {
    const { store, transactions } = persistence();

    await expect(
      new RuledPaymentsBLL(store, transactions).lockWithoutATransaction(1)
    ).rejects.toThrow(/missing @Transactional/);
  });
});

describe("CrudBLL.tx", () => {
  it("keeps a multi-write block together", async () => {
    const { table, store, transactions } = persistence();

    await expect(new RuledPaymentsBLL(store, transactions).createBoth(1, -1)).rejects.toThrow(
      "the second one"
    );

    expect(await table.count()).toBe(0);
  });

  it("joins a transaction already open instead of opening a second", async () => {
    const { store, transactions, unitOfWork, execute } = persistence();
    const service = new RuledPaymentsBLL(store, transactions);

    await unitOfWork.execute(() => service.createBoth(1, 2));

    // The outer call is the only one; a second would queue behind the first on
    // the in-memory driver and never start.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses with no unit of work, naming the call", async () => {
    // Running the block bare would be the silent auto-commit this exists to
    // remove.
    const { table, store, transactions } = persistence({ withSeam: false });

    await expect(new RuledPaymentsBLL(store, transactions).createBoth(1, 2)).rejects.toThrow(
      /RuledPaymentsBLL\.tx\(\) was called but its class exposes no unitOfWork and no transactions/
    );
    expect(await table.count()).toBe(0);
  });

  it("uses the members a subclass declares itself before the seam of its store", async () => {
    // The #32 shape keeps meaning what it meant: a class that injected its own
    // unit of work is the one that decides which unit of work that is.
    const { store, execute } = persistence();
    const own = persistence();

    class DeclaresItsOwn extends CrudBLL<Payment, PaymentDto> {
      constructor(
        repository: IGenericRepository<Payment>,
        readonly unitOfWork: IUnitOfWork,
        readonly transactions: ITransactionContext
      ) {
        super(repository, mapper);
      }
    }

    await new DeclaresItsOwn(store, own.unitOfWork, own.transactions).create({ amount: 1 });

    expect(own.execute).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});

/**
 * Compiled rather than run, because Jest here strips types without checking
 * them, and the property at stake is one only the compiler sees.
 *
 * The seam is kept off `CrudBLL`'s members on purpose. Two members named
 * `unitOfWork` and `transactions` on the base would stop compiling the
 * subclasses that already declare their own — the #32 shape under
 * `noImplicitOverride`, which the generated `tsconfig.json` turns on, and any
 * subclass with a `private` field of either name.
 */
describe("CrudBLL's seam and the subclasses that already exist", () => {
  const root = path.resolve(__dirname, "..", "..");

  function typeErrors(body: string): string[] {
    const file = path.join(__dirname, "__seam-probe__.ts");

    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      noImplicitOverride: true,
      experimentalDecorators: true,
      types: [],
      baseUrl: root,
      // The sources, not `dist`: a stale build would check yesterday's code.
      paths: { "monolite-*": ["*/src/index.ts"] },
    };

    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);

    host.readFile = (name) => (path.resolve(name) === file ? body : readFile(name));
    host.fileExists = (name) => path.resolve(name) === file || fileExists(name);
    host.getSourceFile = (name, language) =>
      path.resolve(name) === file
        ? ts.createSourceFile(name, body, language)
        : getSourceFile(name, language);

    const program = ts.createProgram([file], options, host);

    return ts
      .getPreEmitDiagnostics(program, program.getSourceFile(file))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  }

  const preamble = `
    import { CrudBLL, type EntityMapper, type TransactionalHost } from "monolite-crud";
    import type { IGenericRepository, ITransactionContext, IUnitOfWork } from "monolite-data";

    interface Row { pk: number }
    interface Dto { id: number }
    declare const mapper: EntityMapper<Row, Dto>;
  `;

  it("still compiles a subclass that declares unitOfWork and transactions itself", () => {
    expect(
      typeErrors(`${preamble}
        export class Documented extends CrudBLL<Row, Dto> implements TransactionalHost {
          constructor(
            repository: IGenericRepository<Row>,
            readonly unitOfWork: IUnitOfWork,
            readonly transactions: ITransactionContext
          ) {
            super(repository, mapper);
          }
        }

        export class Hidden extends CrudBLL<Row, Dto> {
          constructor(
            repository: IGenericRepository<Row>,
            private readonly unitOfWork: IUnitOfWork,
            private readonly transactions: { total(): number }
          ) {
            super(repository, mapper);
          }

          count(): number {
            return this.transactions.total() + (this.unitOfWork ? 1 : 0);
          }
        }
      `)
    ).toEqual([]);

    // The control: had the base declared the two members, the very same
    // subclass would have stopped compiling. The check has to be able to fail,
    // or the assertion above proves nothing.
    expect(
      typeErrors(`${preamble}
        abstract class WithMembers extends CrudBLL<Row, Dto> {
          protected readonly unitOfWork?: IUnitOfWork;
        }

        export class Documented extends WithMembers {
          constructor(repository: IGenericRepository<Row>, readonly unitOfWork: IUnitOfWork) {
            super(repository, mapper);
          }
        }
      `)
    ).toEqual([expect.stringMatching(/must have an 'override' modifier/)]);
  });
});
