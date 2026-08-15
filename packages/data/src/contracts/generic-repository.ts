/**
 * Generic data-access contract, along the lines of what EF Core or LINQ offer:
 * a classic CRUD (getAll / getById / insert / update / logical and physical
 * delete) plus a small declarative query language that every driver translates
 * into its own terms (SQL for Oracle, in-memory filtering for the memory
 * driver).
 *
 * The point of it is that a new module never writes SQL again: it describes its
 * table with `EntityMetadata` and gets all of this for free.
 */

export type SortDirection = "asc" | "desc";

/**
 * Comparison operators supported by the filter. They translate 1:1 to SQL:
 * `{ gte: 18 }` -> `COL >= :bind`.
 */
export interface FieldOperators<V> {
  eq?: V;
  ne?: V;
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
  /** SQL LIKE; the pattern (`%`, `_`) is written by the caller. */
  like?: string;
  notLike?: string;
  /** Case-insensitive LIKE (`UPPER(col) LIKE UPPER(:bind)`). */
  ilike?: string;
  /**
   * Contains this **literal text**, ignoring case.
   *
   * This is the operator for searching with whatever a user types. `like` and
   * `ilike` take a pattern, so a `%` or a `_` coming from a form is read as a
   * wildcard: searching for `%` returns the whole table and `a_b` matches
   * `axb`. Here there is no pattern to write, and each driver resolves it its
   * own way —LIKE with ESCAPE, `includes`, an escaped `$regex`—, so the caller
   * cannot get it wrong.
   */
  contains?: string;
  in?: V[];
  notIn?: V[];
  between?: [V, V];
  /** `true` -> IS NULL, `false` -> IS NOT NULL. */
  isNull?: boolean;
}

/**
 * A direct value (`{ name: "Ana" }`, sugar for `eq`), `null` (IS NULL) or an
 * operator object.
 */
export type FieldFilter<V> = V | null | FieldOperators<V>;

/**
 * Composite filter. The entity keys are combined with AND; `$and`, `$or` and
 * `$not` allow nesting arbitrary groups.
 */
export type WhereFilter<T> = {
  [K in keyof T]?: FieldFilter<T[K]>;
} & {
  $and?: WhereFilter<T>[];
  $or?: WhereFilter<T>[];
  $not?: WhereFilter<T>;
};

export interface OrderByClause<T> {
  field: Extract<keyof T, string>;
  direction?: SortDirection;
}

export interface QueryOptions<T> {
  where?: WhereFilter<T>;
  orderBy?: OrderByClause<T> | OrderByClause<T>[];
  /** Records to skip (OFFSET). */
  skip?: number;
  /** Maximum number of records to return (FETCH NEXT). */
  take?: number;
  /** Projection; if omitted, every mapped column is returned. */
  select?: Extract<keyof T, string>[];
  /**
   * By default reads exclude soft-deleted records. Set it to `true` to include
   * them (the equivalent of `IgnoreQueryFilters()`).
   */
  withDeleted?: boolean;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

/**
 * Chainable query, in the style of LINQ's `IQueryable<T>`. It is lazy: it does
 * not touch the database until a terminal method is called (`toList`,
 * `count`, ...).
 */
export interface IQueryable<T> {
  /** Cumulative: several calls are combined with AND. */
  where(filter: WhereFilter<T>): IQueryable<T>;
  orderBy(field: Extract<keyof T, string>, direction?: SortDirection): IQueryable<T>;
  orderByDescending(field: Extract<keyof T, string>): IQueryable<T>;
  select(...fields: Extract<keyof T, string>[]): IQueryable<T>;
  skip(count: number): IQueryable<T>;
  take(count: number): IQueryable<T>;
  withDeleted(): IQueryable<T>;

  // ----- Terminal operators -----
  toList(): Promise<T[]>;
  firstOrDefault(): Promise<T | null>;
  count(): Promise<number>;
  any(): Promise<boolean>;
  toPagedList(page: number, limit: number): Promise<PagedResult<T>>;

  /** Returns the accumulated options (handy for debugging or reusing). */
  toOptions(): QueryOptions<T>;
}

export interface IGenericRepository<T, TKey = number> {
  getAll(options?: QueryOptions<T>): Promise<T[]>;
  getPaged(
    page: number,
    limit: number,
    options?: Omit<QueryOptions<T>, "skip" | "take">
  ): Promise<PagedResult<T>>;
  getById(
    id: TKey,
    options?: Pick<QueryOptions<T>, "select" | "withDeleted">
  ): Promise<T | null>;
  find(options: QueryOptions<T>): Promise<T[]>;
  firstOrDefault(options?: QueryOptions<T>): Promise<T | null>;
  count(where?: WhereFilter<T>, withDeleted?: boolean): Promise<number>;
  exists(where: WhereFilter<T>, withDeleted?: boolean): Promise<boolean>;

  /** Inserts and returns the persisted entity (with the generated PK). */
  insert(entity: Partial<T>): Promise<T>;
  /** Bulk insert; returns how many rows were written. */
  insertMany(entities: Partial<T>[]): Promise<number>;
  /** Updates by PK and returns the resulting entity, or `null` if it did not exist. */
  update(id: TKey, changes: Partial<T>): Promise<T | null>;
  /** Updates everything matching the filter; returns the affected rows. */
  updateWhere(where: WhereFilter<T>, changes: Partial<T>): Promise<number>;

  /** Soft delete: flags the soft-delete column. */
  softDelete(id: TKey): Promise<boolean>;
  /** Reverts a soft delete. */
  restore(id: TKey): Promise<boolean>;
  /** Hard delete: a real DELETE. */
  hardDelete(id: TKey): Promise<boolean>;
  /**
   * Bulk hard delete; returns the deleted rows. Unlike reads, it also reaches
   * the soft-deleted records: if it did not, it would leave orphan rows
   * pointing by foreign key at something already gone.
   */
  hardDeleteWhere(where: WhereFilter<T>): Promise<number>;

  /** Entry point to the chainable API. */
  query(): IQueryable<T>;
}
