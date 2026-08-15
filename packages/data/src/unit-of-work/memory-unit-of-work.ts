import type { ITransactionScope, IUnitOfWork } from "../contracts/unit-of-work";
import type { IGenericRepository } from "../contracts/generic-repository";
import type { ITransactionContext } from "../contracts/transaction-context";
import { MemoryGenericRepository, MemorySnapshot } from "../drivers/memory-generic-repository";

export type MemoryRepositoryRegistry = Map<string, MemoryGenericRepository<never, never>>;

/**
 * In-memory equivalent of `SqlUnitOfWork`.
 *
 * There are no real transactions, so atomicity is emulated by snapshotting the
 * state of the stores before starting and restoring it if the block throws. It
 * is enough for the in-memory mode to behave like a real engine in the face of
 * a failure halfway through an operation.
 *
 * ## Why they run one at a time
 *
 * Node has a single thread, but that does not provide isolation: between the
 * `await` of a read and the `await` of the write that depends on it, the event
 * loop serves other requests. That is exactly the window a race lives in, and
 * here it would also break the rollback: two overlapping transactions snapshot
 * the same state, and if the second one fails it would restore a picture taken
 * before what the first had already committed, wiping it out.
 *
 * That is why transactions are queued and run exclusively. It is stricter than a
 * real engine —which only serializes whoever competes for the same row— but for
 * a development driver it is the right choice: the guarantee it gives is the
 * same or stronger, and the cost does not exist because there is no real
 * concurrency to take advantage of.
 */
export class MemoryUnitOfWork implements IUnitOfWork {
  /** Transaction queue. It never rejects: the failure belongs to the caller. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repositories: MemoryRepositoryRegistry,
    /** See `SqlUnitOfWork`: it publishes the transaction for the repositories. */
    private readonly context?: ITransactionContext
  ) {}

  private repositoryOf(entity: string): MemoryGenericRepository<never, never> {
    const repository = this.repositories.get(entity);
    if (!repository) {
      throw new Error(
        `[MemoryUnitOfWork] The entity "${entity}" is not registered in the unit of work. ` +
          `Registered: ${[...this.repositories.keys()].join(", ")}.`
      );
    }
    return repository;
  }

  execute<R>(work: (scope: ITransactionScope) => Promise<R>): Promise<R> {
    const result = this.queue.then(() => this.runExclusive(work));

    // The queue keeps a version that does not reject; otherwise the failure of
    // one transaction would take down every following one and would also
    // surface as an "unhandled rejection" when the caller had already handled
    // it.
    this.queue = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  }

  private async runExclusive<R>(work: (scope: ITransactionScope) => Promise<R>): Promise<R> {
    const snapshots = new Map<string, MemorySnapshot<never>>();
    for (const [entity, repository] of this.repositories) {
      snapshots.set(entity, repository.snapshot());
    }

    const scope: ITransactionScope = {
      repository: <T extends object, TKey = number>(entity: string): IGenericRepository<T, TKey> =>
        this.repositoryOf(entity) as unknown as IGenericRepository<T, TKey>,

      /**
       * There is nothing to lock: the whole transaction already runs
       * exclusively, which is a stronger guarantee than the row's. The
       * existence check is kept so that the contract answers the same as in
       * SQL, soft deletes included.
       */
      lockRow: async (entity: string, id: unknown): Promise<boolean> =>
        (await this.repositoryOf(entity).getById(id as never, { withDeleted: true })) !== null,
    };

    try {
      return await (this.context ? this.context.run(scope, () => work(scope)) : work(scope));
    } catch (error) {
      for (const [entity, snapshot] of snapshots) {
        this.repositories.get(entity)?.restoreSnapshot(snapshot);
      }
      throw error;
    }
  }
}
