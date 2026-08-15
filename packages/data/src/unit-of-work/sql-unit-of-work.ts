import type { ITransactionScope, IUnitOfWork } from "../contracts/unit-of-work";
import type { IGenericRepository } from "../contracts/generic-repository";
import type { ISqlExecutor } from "../contracts/sql-executor";
import type { ITransactionContext } from "../contracts/transaction-context";
import { SqlGenericRepository } from "../drivers/sql-generic-repository";

/**
 * The only thing the unit of work needs from the driver: to open a transaction
 * and hand back an executor bound to it. Both `OracleConnector` and
 * `SequelizeConnector` satisfy it.
 */
export interface ISqlTransactionRunner {
  transaction<T>(work: (tx: ISqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * Heterogeneous registry of repositories by logical entity name. The concrete
 * type is recovered in `repository<T>()`, which is where the caller declares
 * which entity it is asking for.
 */
export type SqlRepositoryRegistry = Map<string, SqlGenericRepository<never, never>>;

/**
 * Unit of work over SQL: a real transaction, with a commit at the end and a
 * rollback if anything throws.
 *
 * Inside the block, `scope.repository(...)` returns the usual generic
 * repository but bound to the transaction's connection, so the service uses
 * exactly the same API as outside it.
 */
export class SqlUnitOfWork implements IUnitOfWork {
  constructor(
    private readonly db: ISqlTransactionRunner,
    private readonly repositories: SqlRepositoryRegistry,
    /**
     * Publishes the transaction so that module repositories join it without
     * receiving it as a parameter.
     */
    private readonly context?: ITransactionContext
  ) {}

  execute<R>(work: (scope: ITransactionScope) => Promise<R>): Promise<R> {
    return this.db.transaction(async (tx) => {
      // Memoized per entity: two requests for the same repository inside the
      // transaction return the same instance.
      const bound = new Map<string, unknown>();

      const baseRepositoryOf = (entity: string): SqlGenericRepository<never, never> => {
        const repository = this.repositories.get(entity);
        if (!repository) {
          throw new Error(
            `[SqlUnitOfWork] The entity "${entity}" is not registered in the unit of work. ` +
              `Registered: ${[...this.repositories.keys()].join(", ")}.`
          );
        }
        return repository;
      };

      const boundRepositoryOf = (entity: string): SqlGenericRepository<never, never> => {
        const cached = bound.get(entity);
        if (cached) return cached as SqlGenericRepository<never, never>;

        const rebound = baseRepositoryOf(entity).withExecutor(tx);
        bound.set(entity, rebound);
        return rebound;
      };

      const scope: ITransactionScope = {
        repository: <T extends object, TKey = number>(entity: string): IGenericRepository<T, TKey> =>
          boundRepositoryOf(entity) as unknown as IGenericRepository<T, TKey>,

        // The lock goes through the same executor as the rest of the
        // transaction, so its commit or rollback releases it. The statement is
        // written by the dialect, which is where what differs between engines
        // lives.
        lockRow: (entity: string, id: unknown): Promise<boolean> =>
          boundRepositoryOf(entity).lockById(id as never),
      };

      // Inside this `run`, any module repository that consults the context will
      // use the transaction's connection instead of the pool.
      return this.context ? this.context.run(scope, () => work(scope)) : work(scope);
    });
  }
}
