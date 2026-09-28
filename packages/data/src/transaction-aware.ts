import type { IGenericRepository } from "./contracts/generic-repository.js";
import type { ITransactionContext } from "./contracts/transaction-context.js";
import type { IUnitOfWork } from "./contracts/unit-of-work.js";

/**
 * The two things a service needs to open a transaction its stores will join.
 *
 * They travel together or not at all: the unit of work opens the transaction
 * and the context is what tells "already inside one" from "not". Either one
 * alone is a way to open a second transaction from inside the first.
 */
export interface TransactionSeam {
  readonly unitOfWork: IUnitOfWork;
  readonly transactions: ITransactionContext;
}

/**
 * The key a store carries its seam under.
 *
 * A symbol rather than a property name, because a store is a contract other
 * people implement and extend: no name we could pick is guaranteed not to be a
 * column, a method or a field of somebody's repository, and a symbol is. It is
 * `Symbol.for` so that two copies of this package in one `node_modules` — which
 * npm produces more often than anybody would like — still recognise each
 * other's stores.
 */
export const TRANSACTION_SEAM: unique symbol = Symbol.for("monolite.transactionSeam");

/**
 * The seam a store was bound with, or `undefined` when it has none.
 *
 * This is how a service that was handed nothing but a store finds out how to
 * open a transaction around its writes, with no second constructor argument.
 * The service in question is `CrudBLL`: every generated module extends it, and
 * it used to have no way at all to be atomic (#33).
 *
 * It is read off the store rather than resolved from the container on purpose.
 * The seam is only sound where the store actually joins the transaction it
 * opens: a unit of work around writes that go out on the pool's auto-commit
 * would look atomic and not be. Asking the store answers both questions at
 * once — a store that carries a seam is, by construction, one that joins it.
 */
export function transactionSeamOf(repository: unknown): TransactionSeam | undefined {
  if (typeof repository !== "object" || repository === null) return undefined;

  const seam = (repository as { [TRANSACTION_SEAM]?: TransactionSeam })[TRANSACTION_SEAM];
  if (typeof seam?.unitOfWork?.execute !== "function") return undefined;
  if (typeof seam.transactions?.current !== "function") return undefined;

  return seam;
}

/**
 * A store that joins whatever transaction is open, and uses the pool when none
 * is.
 *
 * This is the mechanism the documentation has always described —
 * "every repository called inside a `@Transactional()` method joins the same
 * transaction, nothing is passed" — and until now the only thing that had it was
 * `BaseModuleRepository`, which a module has to extend. The stores
 * `registerPersistence` binds are the driver's own, with auto-commit, so a
 * service that injected one and decorated its method opened a transaction and
 * then wrote outside it.
 *
 * That failure is quiet, which is what makes it worth a wrapper rather than a
 * note in the guide. Three statements on three auto-commits look exactly like
 * one transaction until something in the middle throws, and then half the work
 * is committed and there is nothing to roll back.
 *
 * ---
 *
 * **Why a proxy and not seventeen delegating methods.**
 *
 * `IGenericRepository` has seventeen members today and the wrapper has to
 * forward all of them, plus the ones that are not on the contract at all:
 * `schema` and `executeRaw` exist on `SqlGenericRepository` and a module that
 * narrows to them must keep finding them *through* the wrapper — including
 * inside the transaction, where raw SQL had better run on the transaction's
 * connection like everything else.
 *
 * A hand-written class would forward the seventeen and silently drop the rest,
 * and would need editing every time the contract grows. Resolving per access is
 * the behaviour being asked for anyway: *which* store this is depends on when
 * you ask, not on when it was built.
 */
export function transactionAware<T extends object, TKey = number>(
  store: IGenericRepository<T, TKey>,
  entity: string,
  transactions: ITransactionContext,
  /**
   * The unit of work whose transactions this store joins. Optional, and without
   * it the store behaves exactly as it always has; with it the store also
   * carries the seam `transactionSeamOf` reads, so a service holding nothing
   * but this store can open a transaction around its own writes.
   */
  unitOfWork?: IUnitOfWork
): IGenericRepository<T, TKey> {
  const seam: TransactionSeam | undefined = unitOfWork ? { unitOfWork, transactions } : undefined;

  /**
   * The store to answer with, decided per access.
   *
   * The scope's repository is a full one bound to the transaction's connection,
   * so anything the pool's store can do it can do too — there is no member to
   * fall back for.
   */
  const active = (): object => {
    const scoped = transactions.current()?.repository<T, TKey>(entity);
    return (scoped as object | undefined) ?? (store as object);
  };

  return new Proxy(store as object, {
    get(_target, property) {
      // Answered by the wrapper itself: the seam belongs to this binding, not
      // to either of the stores it switches between.
      if (property === TRANSACTION_SEAM) return seam;

      const current = active();
      const value = Reflect.get(current, property, current) as unknown;

      // Bound to the store it came from: an unbound method would run with the
      // proxy as `this` and resolve `active()` again on every internal call,
      // which is one transaction check per private field access.
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(current) : value;
    },

    has(_target, property) {
      if (property === TRANSACTION_SEAM) return seam !== undefined;
      return property in active();
    },

    // `getPrototypeOf` and `getOwnPropertyDescriptor` follow the live store too,
    // so `instanceof` and property enumeration say the same thing `get` does.
    getPrototypeOf() {
      return Reflect.getPrototypeOf(active());
    },

    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(active(), property);
      // A proxy may not report a non-configurable property that its target does
      // not have, and the two stores are different objects.
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },

    ownKeys() {
      return Reflect.ownKeys(active());
    },
  }) as IGenericRepository<T, TKey>;
}
