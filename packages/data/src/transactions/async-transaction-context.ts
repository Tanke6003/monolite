import { AsyncLocalStorage } from "node:async_hooks";
import type { ITransactionContext } from "../contracts/transaction-context";
import type { ITransactionScope } from "../contracts/unit-of-work";

/**
 * The transaction in progress, held in an `AsyncLocalStorage`.
 *
 * Twin of the request context: a module-level variable would not do, because
 * two concurrent requests would step on each other, whereas the ALS store does
 * survive `await` and belongs to each chain of calls.
 *
 * Nesting replaces: if another transaction were opened inside one, the inner
 * one would be the active one for as long as it lasts and the outer one would
 * come back on exit. No service nests today —and in memory the unit of work
 * would prevent it, because it serializes— but that is the correct behaviour if
 * it ever happens.
 */
export class AsyncTransactionContext implements ITransactionContext {
  private readonly storage = new AsyncLocalStorage<ITransactionScope>();

  run<T>(scope: ITransactionScope, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(scope, fn);
  }

  current(): ITransactionScope | undefined {
    return this.storage.getStore();
  }
}
