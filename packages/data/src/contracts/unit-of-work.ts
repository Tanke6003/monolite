import type { IGenericRepository } from "./generic-repository";

/**
 * Unit of work.
 *
 * Project rule: a transaction is **not** opened per operation. A single
 * statement (the generic repository's CRUD) is already atomic and travels with
 * auto-commit; wrapping it would only add a round trip to the database.
 *
 * The transaction is opened in two cases, and the boundary is drawn by the
 * service, not by the repository:
 *
 * 1. **More than one place is written to** and a half-finished result would be
 *    invalid: deactivating a branch and cancelling its appointments, or hard
 *    deleting a branch whose appointments reference it by foreign key.
 *
 * 2. **The decision depends on what was just read**, even if a single row ends
 *    up being written. That is the case when booking an appointment: checking
 *    that the slot is free and taking it are two statements, and another
 *    request doing the same thing fits between them. Here the transaction is
 *    not about atomicity but about isolation, and it comes with `lockRow`.
 *
 * What still does not justify a transaction is wrapping a single statement that
 * does not depend on any read: it is already atomic and travels with
 * auto-commit.
 */
export interface ITransactionScope {
  /**
   * Generic repository for an entity, bound to the transaction in progress.
   * Everything written through it lands in the same commit.
   *
   * @param entity Logical entity name (see the application's entity names).
   */
  repository<T extends object, TKey = number>(entity: string): IGenericRepository<T, TKey>;

  /**
   * Locks a row until commit. Transactions asking for the same row wait here,
   * in a queue.
   *
   * This is what is needed when the decision to write depends on what was just
   * read: without the lock, two concurrent requests read the same state, both
   * conclude that they may write, and both write. Locking the *parent* row —an
   * appointment's branch, not the appointment— serializes only those that
   * really compete and lets everyone else through in parallel.
   *
   * **It has to be the first statement of the transaction.** In MySQL, which
   * defaults to REPEATABLE READ, the snapshot is fixed by the first consistent
   * read; if a plain SELECT ran before the lock, later reads would still see
   * the old state even though the lock was granted. A locking read does not fix
   * a snapshot, so by opening with it the checks see the latest committed state
   * on all four engines.
   *
   * @param entity Logical entity name (see the application's entity names).
   * @param id Primary key of the row.
   * @returns `false` if the row does not exist, which is a useful answer too.
   */
  lockRow(entity: string, id: unknown): Promise<boolean>;
}

export interface IUnitOfWork {
  /**
   * Runs `work` atomically: commit if it finishes cleanly, rollback if it
   * throws. The original error propagates untouched, so the service decides.
   */
  execute<R>(work: (scope: ITransactionScope) => Promise<R>): Promise<R>;
}
