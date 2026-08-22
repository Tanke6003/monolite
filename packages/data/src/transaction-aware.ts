import type { IGenericRepository } from "./contracts/generic-repository.js";
import type { ITransactionContext } from "./contracts/transaction-context.js";

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
  transactions: ITransactionContext
): IGenericRepository<T, TKey> {
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
      const current = active();
      const value = Reflect.get(current, property, current) as unknown;

      // Bound to the store it came from: an unbound method would run with the
      // proxy as `this` and resolve `active()` again on every internal call,
      // which is one transaction check per private field access.
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(current) : value;
    },

    has(_target, property) {
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
