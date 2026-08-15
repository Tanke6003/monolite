import type { ILogger } from "@monolite/core";
import type {
  IGenericRepository,
  IQueryable,
  PagedResult,
  QueryOptions,
  WhereFilter,
} from "./contracts/generic-repository.js";
import type { ITransactionContext } from "./contracts/transaction-context.js";
import { QueryBuilder } from "./query/query-builder.js";

/**
 * Module repository: it wraps the generic repository of the active driver and
 * adds what this layer is expected to provide —error logging and a stable
 * message upwards— without repeating the try/catch in every method.
 *
 * A concrete module simply extends this class and adds, if anything, its own
 * queries. Relationships between aggregates are not resolved here: that is a
 * business rule and lives in the services.
 */
export abstract class BaseModuleRepository<T extends object, TKey = number>
  implements IGenericRepository<T, TKey>
{
  protected constructor(
    /** Store of the active engine, with auto-commit. */
    private readonly baseStore: IGenericRepository<T, TKey>,
    protected readonly logger: ILogger,
    /** Name of the concrete repository; it shows up in the logs and in the errors. */
    protected readonly context: string,
    /** Logical entity name; the transaction asks for it. */
    private readonly entity?: string,
    /** Without it, the repository never joins a transaction. */
    private readonly transactions?: ITransactionContext
  ) {}

  /**
   * The store every method below operates on.
   *
   * If a transaction is open in this context, it returns the repository bound
   * to it; otherwise, the pool's one. It is a single point because this whole
   * class goes through `this.store`: that way a module joins the transaction
   * without the service having to pass it anything.
   *
   * Being ambient has a price, and it is worth knowing: reading
   * `repository.insert(...)` does not show whether it is inside a transaction.
   * What does show is the boundary, the service's `unitOfWork.execute(...)`. It
   * is the same deal `IRequestContext` already makes with the request identity.
   */
  protected get store(): IGenericRepository<T, TKey> {
    if (!this.entity) return this.baseStore;

    const scoped = this.transactions?.current()?.repository<T, TKey>(this.entity);
    return (scoped as IGenericRepository<T, TKey> | undefined) ?? this.baseStore;
  }

  /**
   * Runs a store operation translating any failure into a generic error: the
   * driver details stay in the log, not in the HTTP response.
   */
  protected async guard<R>(operation: string, work: () => Promise<R>, meta?: object): Promise<R> {
    try {
      return await work();
    } catch (error) {
      this.logger.error(`Error in ${this.context}.${operation}`, { ...meta, error });
      // The original error travels in `cause`: a neutral message goes out to
      // the client, but the global handler can still recognise an ORA-00001 and
      // answer 409 instead of a generic 500.
      throw new Error(`${this.context}.${operation} failed.`, { cause: error });
    }
  }

  getAll(options?: QueryOptions<T>): Promise<T[]> {
    return this.guard("getAll", () => this.store.getAll(options));
  }

  getPaged(
    page: number,
    limit: number,
    options?: Omit<QueryOptions<T>, "skip" | "take">
  ): Promise<PagedResult<T>> {
    return this.guard("getPaged", () => this.store.getPaged(page, limit, options), { page, limit });
  }

  getById(id: TKey, options?: Pick<QueryOptions<T>, "select" | "withDeleted">): Promise<T | null> {
    return this.guard("getById", () => this.store.getById(id, options), { id });
  }

  find(options: QueryOptions<T>): Promise<T[]> {
    return this.guard("find", () => this.store.find(options));
  }

  firstOrDefault(options?: QueryOptions<T>): Promise<T | null> {
    return this.guard("firstOrDefault", () => this.store.firstOrDefault(options));
  }

  count(where?: WhereFilter<T>, withDeleted?: boolean): Promise<number> {
    return this.guard("count", () => this.store.count(where, withDeleted));
  }

  exists(where: WhereFilter<T>, withDeleted?: boolean): Promise<boolean> {
    return this.guard("exists", () => this.store.exists(where, withDeleted));
  }

  insert(entity: Partial<T>): Promise<T> {
    return this.guard("insert", () => this.store.insert(entity), { entity });
  }

  insertMany(entities: Partial<T>[]): Promise<number> {
    return this.guard("insertMany", () => this.store.insertMany(entities), {
      batch: entities.length,
    });
  }

  update(id: TKey, changes: Partial<T>): Promise<T | null> {
    return this.guard("update", () => this.store.update(id, changes), { id, changes });
  }

  updateWhere(where: WhereFilter<T>, changes: Partial<T>): Promise<number> {
    return this.guard("updateWhere", () => this.store.updateWhere(where, changes), { changes });
  }

  softDelete(id: TKey): Promise<boolean> {
    return this.guard("softDelete", () => this.store.softDelete(id), { id });
  }

  restore(id: TKey): Promise<boolean> {
    return this.guard("restore", () => this.store.restore(id), { id });
  }

  hardDelete(id: TKey): Promise<boolean> {
    return this.guard("hardDelete", () => this.store.hardDelete(id), { id });
  }

  hardDeleteWhere(where: WhereFilter<T>): Promise<number> {
    return this.guard("hardDeleteWhere", () => this.store.hardDeleteWhere(where));
  }

  /**
   * The builder points at `this`, not at the store: that way the terminal
   * operators (`toList`, `count`, ...) also go through `guard`.
   */
  query(): IQueryable<T> {
    return new QueryBuilder<T, TKey>(this);
  }
}
