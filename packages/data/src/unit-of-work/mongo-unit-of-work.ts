// NOTE ON THE OPTIONAL DRIVER: only the `ClientSession` type is taken from
// `mongodb`, and `import type` is erased at compile time, so nothing is required
// at runtime. If a value from the driver were ever needed here, the import would
// have to become a lazy `await import("mongodb")`, otherwise a consumer that
// only uses PostgreSQL would be forced to install the optional peer dependency.
import type { ClientSession } from "mongodb";
import type { ITransactionScope, IUnitOfWork } from "../contracts/unit-of-work.js";
import type { IGenericRepository } from "../contracts/generic-repository.js";
import type { ITransactionContext } from "../contracts/transaction-context.js";
import { MongoGenericRepository } from "../drivers/mongo-generic-repository.js";

/**
 * The only thing the unit of work needs from the connector: to open a session
 * and run the block inside a transaction. `MongoConnector` satisfies it.
 */
export interface IMongoTransactionRunner {
  transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T>;
}

/**
 * Heterogeneous registry of repositories by logical entity name. The concrete
 * type is recovered in `repository<T>()`, which is where the caller declares
 * which entity it is asking for.
 */
export type MongoRepositoryRegistry = Map<string, MongoGenericRepository<never, never>>;

/**
 * Unit of work over MongoDB: a real multi-document transaction, with a commit
 * at the end and a rollback if anything throws.
 *
 * It is the twin of `SqlUnitOfWork`; the only difference is the shape of the
 * scope —a session instead of an executor— because in MongoDB the transaction
 * is not tied to the connection but to the session handed to every operation.
 */
export class MongoUnitOfWork implements IUnitOfWork {
  constructor(
    private readonly db: IMongoTransactionRunner,
    private readonly repositories: MongoRepositoryRegistry,
    /** See `SqlUnitOfWork`: it publishes the transaction for the repositories. */
    private readonly context?: ITransactionContext
  ) {}

  execute<R>(work: (scope: ITransactionScope) => Promise<R>): Promise<R> {
    return this.db.transaction(async (session) => {
      // Memoized per entity: two requests for the same repository inside the
      // transaction return the same instance.
      const bound = new Map<string, unknown>();

      const baseRepositoryOf = (entity: string): MongoGenericRepository<never, never> => {
        const repository = this.repositories.get(entity);
        if (!repository) {
          throw new Error(
            `[MongoUnitOfWork] The entity "${entity}" is not registered in the unit of work. ` +
              `Registered: ${[...this.repositories.keys()].join(", ")}.`
          );
        }
        return repository;
      };

      const boundRepositoryOf = (entity: string): MongoGenericRepository<never, never> => {
        const cached = bound.get(entity);
        if (cached) return cached as MongoGenericRepository<never, never>;

        const rebound = baseRepositoryOf(entity).withSession(session);
        bound.set(entity, rebound);
        return rebound;
      };

      const scope: ITransactionScope = {
        repository: <T extends object, TKey = number>(entity: string): IGenericRepository<T, TKey> =>
          boundRepositoryOf(entity) as unknown as IGenericRepository<T, TKey>,

        /**
         * MongoDB has no locking read: there is no way to say "reserve this
         * document until I commit". The closest thing would be writing to it to
         * force a write conflict, and that dirties the document with a change
         * the use case never asked for.
         *
         * Here the guarantee comes from a partial unique index on the
         * collection: if two transactions go for the same slot, the second one
         * fails with an 11000 that the error mapper already turns into a 409.
         * The document's existence is checked so that the contract returns the
         * same as in SQL, soft deletes included: the SQL version locks whichever
         * row is there, without looking at whether it is deactivated.
         */
        lockRow: async (entity: string, id: unknown): Promise<boolean> =>
          (await boundRepositoryOf(entity).getById(id as never, { withDeleted: true })) !== null,
      };

      return this.context ? this.context.run(scope, () => work(scope)) : work(scope);
    });
  }
}
