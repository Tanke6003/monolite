import type {
  IGenericRepository,
  IQueryable,
  PagedResult,
  QueryOptions,
  SortDirection,
  WhereFilter,
} from "../contracts/generic-repository.js";
import { normalizeOrderBy } from "./filter-helpers.js";

/**
 * Implementation of `IQueryable<T>` shared by every driver: it knows nothing
 * about SQL or about memory, it just accumulates `QueryOptions` and delegates
 * the terminal methods to the repository that created it.
 *
 * It is immutable, like `IQueryable` in LINQ: every operator returns a new
 * instance, so a base query can be derived into several without them
 * contaminating each other.
 */
export class QueryBuilder<T, TKey = number> implements IQueryable<T> {
  constructor(
    private readonly repository: IGenericRepository<T, TKey>,
    private readonly options: QueryOptions<T> = {}
  ) {}

  private derive(patch: Partial<QueryOptions<T>>): QueryBuilder<T, TKey> {
    return new QueryBuilder<T, TKey>(this.repository, { ...this.options, ...patch });
  }

  where(filter: WhereFilter<T>): IQueryable<T> {
    // Several chained `where`s are combined with AND, as in LINQ.
    const merged: WhereFilter<T> = this.options.where
      ? ({ $and: [this.options.where, filter] } as WhereFilter<T>)
      : filter;
    return this.derive({ where: merged });
  }

  orderBy(field: Extract<keyof T, string>, direction: SortDirection = "asc"): IQueryable<T> {
    return this.derive({
      orderBy: [...normalizeOrderBy(this.options.orderBy), { field, direction }],
    });
  }

  orderByDescending(field: Extract<keyof T, string>): IQueryable<T> {
    return this.orderBy(field, "desc");
  }

  select(...fields: Extract<keyof T, string>[]): IQueryable<T> {
    return this.derive({ select: fields });
  }

  skip(count: number): IQueryable<T> {
    return this.derive({ skip: count });
  }

  take(count: number): IQueryable<T> {
    return this.derive({ take: count });
  }

  withDeleted(): IQueryable<T> {
    return this.derive({ withDeleted: true });
  }

  // ---------------------------------------------------- terminal operators ---

  toList(): Promise<T[]> {
    return this.repository.find(this.options);
  }

  firstOrDefault(): Promise<T | null> {
    return this.repository.firstOrDefault(this.options);
  }

  count(): Promise<number> {
    return this.repository.count(this.options.where, this.options.withDeleted);
  }

  async any(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  toPagedList(page: number, limit: number): Promise<PagedResult<T>> {
    // `skip`/`take` are set by the pagination, which is why they are not
    // propagated here.
    const { where, orderBy, select, withDeleted } = this.options;
    return this.repository.getPaged(page, limit, { where, orderBy, select, withDeleted });
  }

  toOptions(): QueryOptions<T> {
    return { ...this.options };
  }
}
