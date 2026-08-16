//
// `@Transactional()` and the base class that holds it up.
//
// The decorator replaces the `unitOfWork.execute(...)` that used to wrap the
// body of the method. What makes it worth having is the ambient transaction:
// without it the block received its scope as a parameter and there was no way
// to take it out of the signature.
import type { ITransactionContext, IUnitOfWork } from "monolite-data";

/**
 * What the decorator needs to find on the service. Extending
 * `TransactionalService` satisfies it.
 */
interface TransactionalHost {
  readonly unitOfWork: IUnitOfWork;
  readonly transactions: ITransactionContext;
}

/**
 * Locks a row of the transaction in flight.
 *
 * It stands on its own, and not only as a method of the base class, because
 * TypeScript has no multiple inheritance: a service that already extends
 * `CrudService` cannot extend `TransactionalService` as well, and it still
 * needs to lock.
 *
 * **It must be the first statement of the method.** MySQL fixes the snapshot on
 * the first consistent read; if a plain SELECT ran before it, everything read
 * afterwards keeps seeing the old state even though the lock was granted.
 */
export function lockRow(
  transactions: ITransactionContext,
  entity: string,
  id: unknown
): Promise<boolean> {
  const scope = transactions.current();

  if (!scope) {
    throw new Error(
      `[Transactional] lockRow("${entity}") was called outside a transaction. ` +
        "The method is missing @Transactional(), or somebody removed it."
    );
  }

  return scope.lockRow(entity, id);
}

/**
 * Base class for services that open transactions.
 *
 * It supplies the two dependencies the decorator looks for and, above all,
 * `lockRow`: without it the lock would be left without the scope it comes from,
 * which was the substantive objection against the decorator in the first place.
 */
export abstract class TransactionalService {
  protected constructor(
    readonly unitOfWork: IUnitOfWork,
    readonly transactions: ITransactionContext
  ) {}

  /** See the `lockRow` function; this is only the shortcut for subclasses. */
  protected lockRow(entity: string, id: unknown): Promise<boolean> {
    return lockRow(this.transactions, entity, id);
  }
}

/**
 * Runs the method inside a transaction.
 *
 * If one is already open it **joins it** instead of nesting another: two
 * transactional services that call each other share a commit, which is what one
 * expects and what stops the inner one from committing on its own what the
 * outer one may still roll back.
 *
 * It is no use for a method that needs to read *before* opening the
 * transaction — one that decides whether a transaction is warranted at all from
 * what it just read, and would otherwise hold a write transaction open across
 * that read. There the explicit `unitOfWork.execute(...)` remains the right
 * shape.
 */
export function Transactional() {
  return function (
    _target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;

    descriptor.value = function (this: TransactionalHost, ...args: unknown[]): Promise<unknown> {
      if (typeof this?.unitOfWork?.execute !== "function") {
        // It rejects instead of throwing: the decorated method is awaited, and
        // a synchronous error coming out of something that looks asynchronous
        // escapes the caller's try/catch.
        return Promise.reject(
          new Error(
            `[Transactional] ${propertyKey} is decorated but its class exposes no unit of ` +
              "work. Extend TransactionalService."
          )
        );
      }

      // Already inside a transaction: join it, do not open another.
      if (this.transactions?.current()) return original.apply(this, args);

      return this.unitOfWork.execute(() => original.apply(this, args));
    };

    return descriptor;
  };
}
