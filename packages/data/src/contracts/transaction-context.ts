import type { ITransactionScope } from "./unit-of-work";

/**
 * The transaction in progress, reachable from wherever it is needed without
 * passing it as a parameter.
 *
 * Without this, opening a transaction forces the scope to be dragged downwards:
 * a service method that only needed an id ends up receiving the repository as
 * well, because inside the transaction the scoped one must be used and outside
 * it the injected one. With the context, the module repository checks whether a
 * transaction is open and joins it by itself.
 *
 * It is the same technique `IRequestContext` uses for the request identity
 * —`AsyncLocalStorage`— and for the same reason: the store survives `await`, so
 * a call three layers down still sees the transaction, and two concurrent
 * requests do not step on each other.
 */
export interface ITransactionContext {
  /** Runs `fn` with `scope` as the active transaction. */
  run<T>(scope: ITransactionScope, fn: () => Promise<T>): Promise<T>;

  /** The active transaction, or `undefined` outside of one. */
  current(): ITransactionScope | undefined;
}
