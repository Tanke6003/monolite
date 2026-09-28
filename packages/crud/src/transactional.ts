//
// `@Transactional()` and the base class that holds it up.
//
// The decorator replaces the `unitOfWork.execute(...)` that used to wrap the
// body of the method. What makes it worth having is the ambient transaction:
// without it the block received its scope as a parameter and there was no way
// to take it out of the signature.
import type { ITransactionContext, IUnitOfWork, TransactionSeam } from "monolite-data";

/**
 * What the decorator needs to find on the service: both members, not one.
 *
 * There are three ways to satisfy it, and none imposes an inheritance chain on
 * a service that did not ask for one. Extending `TransactionalBLL` supplies
 * them. Extending `CrudBLL` supplies them too, with no constructor argument,
 * whenever the store it was handed carries a seam (see `adoptTransactionSeam`).
 * And any class can declare them itself and inject the two dependencies, which
 * is one constructor argument more and nothing else.
 *
 * It is exported so that `implements TransactionalHost` turns a missing member
 * into a compile error at the class that forgot it, instead of a rejected
 * promise the first time the method is called in production.
 */
export interface TransactionalHost {
  readonly unitOfWork: IUnitOfWork;
  readonly transactions: ITransactionContext;
}

/**
 * The members of the contract the host does not actually supply.
 *
 * `transactions` counts as much as `unitOfWork`: it is what the decorator reads
 * to tell "already inside a transaction" from "not", and a host without it
 * would open a second transaction from a method called by another decorated
 * one — deadlocking against the rows the first already holds. Answering that
 * with a named error beats answering it with a lock wait.
 */
function missingMembersOf(host: Partial<TransactionalHost> | undefined): string[] {
  const missing: string[] = [];

  if (typeof host?.unitOfWork?.execute !== "function") missing.push("unitOfWork");
  if (typeof host?.transactions?.current !== "function") missing.push("transactions");

  return missing;
}

/**
 * Seams handed to a service by its base class rather than declared on it.
 *
 * A `WeakMap` and not two members on `CrudBLL`, and the reason is the classes
 * that already exist. A member named `unitOfWork` or `transactions` on the base
 * would collide with every subclass that declares its own: the shape #32 made
 * the documented one stops compiling under `noImplicitOverride` — which the
 * generated `tsconfig.json` turns on — and one that keeps a `private` field of
 * either name, or a domain repository called `transactions`, stops compiling
 * under any settings. Keyed off the instance, the seam cannot collide with
 * anything, and the service's own members still win when it has them.
 */
const adopted = new WeakMap<object, TransactionSeam>();

/**
 * Hands `service` a seam it did not have to declare. Internal to the package:
 * `CrudBLL` calls it with whatever the store it was given carries.
 */
export function adoptTransactionSeam(service: object, seam: TransactionSeam | undefined): void {
  if (seam) adopted.set(service, seam);
}

/**
 * The members the transaction is opened with.
 *
 * Its own, when the service declares a complete pair — the #32 shape, and
 * `TransactionalBLL`, keep behaving exactly as they did. Otherwise the seam its
 * base class adopted for it. Never half of each: a unit of work from one place
 * and a context from another is precisely the pair that fails to see its own
 * transaction and opens a second one.
 */
function hostOf(service: object | undefined): Partial<TransactionalHost> | undefined {
  const own = service as Partial<TransactionalHost> | undefined;

  if (missingMembersOf(own).length === 0 || !service) return own;
  return adopted.get(service) ?? own;
}

/** Whether `service` has everything it needs to open a transaction. */
export function canOpenTransaction(service: object): boolean {
  return missingMembersOf(hostOf(service)).length === 0;
}

/**
 * Runs `work` in a transaction on behalf of `service`, joining one already
 * open. Both `@Transactional()` and `CrudBLL.tx` come through here, so the two
 * cannot drift apart on what "joining" means or on how a missing member is
 * reported.
 *
 * `caller` opens the error message: it names the method a developer would go
 * and look at.
 */
export function runInTransaction<R>(
  service: object,
  caller: string,
  work: () => Promise<R>
): Promise<R> {
  const host = hostOf(service);
  const missing = missingMembersOf(host);

  if (missing.length > 0 || !host?.unitOfWork || !host.transactions) {
    // It rejects instead of throwing: the decorated method is awaited, and
    // a synchronous error coming out of something that looks asynchronous
    // escapes the caller's try/catch.
    //
    // The message names both routes on purpose. It used to name only the
    // base class, which contradicted the guide it was meant to serve: a BLL
    // extending CrudBLL cannot extend TransactionalBLL as well, and reading
    // that it had to was enough to give up on the transaction entirely.
    return Promise.reject(
      new Error(
        `[Transactional] ${caller} but its class exposes no ` +
          `${missing.join(" and no ")}. Inject IUnitOfWork and ITransactionContext and ` +
          "keep them as `unitOfWork` and `transactions` — a service that already extends " +
          "CrudBLL can, with no second base class — or extend TransactionalBLL."
      )
    );
  }

  // Already inside a transaction: join it, do not open another.
  if (host.transactions.current()) return work();

  return host.unitOfWork.execute(() => work());
}

/**
 * Locks a row of the transaction in flight.
 *
 * It stands on its own, and not only as a method of the base class, because
 * TypeScript has no multiple inheritance: a service that already extends
 * `CrudBLL` cannot extend `TransactionalBLL` as well, and it still
 * needs to lock.
 *
 * **It must be the first statement of the method.** MySQL fixes the snapshot on
 * the first consistent read; if a plain SELECT ran before it, everything read
 * afterwards keeps seeing the old state even though the lock was granted.
 *
 * The first argument is the transaction context, or the service itself: a
 * `CrudBLL` subclass that took its seam from its store (#33) has no
 * `transactions` member to pass, and `lockRow(this, ...)` finds the context
 * the same way `@Transactional()` found it.
 */
export function lockRow(
  from: ITransactionContext | object,
  entity: string,
  id: unknown
): Promise<boolean> {
  const transactions =
    typeof (from as Partial<ITransactionContext>).current === "function"
      ? (from as ITransactionContext)
      : hostOf(from)?.transactions;
  const scope = transactions?.current();

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
export abstract class TransactionalBLL {
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

    descriptor.value = function (this: object, ...args: unknown[]): Promise<unknown> {
      return runInTransaction(this, `${propertyKey} is decorated`, () =>
        original.apply(this, args)
      );
    };

    return descriptor;
  };
}
