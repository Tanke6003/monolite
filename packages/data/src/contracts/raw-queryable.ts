import type { EntitySchema } from "../metadata/entity-metadata.js";
import type { IGenericRepository } from "./generic-repository.js";

/**
 * A store that can run SQL of its own.
 *
 * `executeRaw` is the documented escape hatch for what the generic API
 * deliberately does not express — aggregations, `GROUP BY`, views, stored
 * procedures. It lives on the SQL store, and until this existed it lived on no
 * interface, so a module that injected its store as `IGenericRepository<T>` —
 * which is what the container binds and what every generated module asks for —
 * could not see it. Writing one report meant writing ten lines of narrowing
 * first, and every project would invent its own: a cast here, a duck-type
 * there, an `as any` in the third.
 *
 * The escape hatch needs `schema` as much as it needs `executeRaw`: raw SQL has
 * to name real columns, and `schema.columnOf(property)` is what keeps a report
 * from hard-coding a name the mapping could change underneath it.
 *
 * ---
 *
 * **Why it is not on `IGenericRepository`.**
 *
 * The obvious alternative is to put `executeRaw` on the one contract and be
 * done. It is wrong: the in-memory and MongoDB drivers have no SQL to run and
 * cannot pretend otherwise, so they would have to throw — and a contract whose
 * implementations throw is not a contract. The whole point of the generic API
 * is that it means the same thing on all six engines.
 *
 * A separate interface says the true thing, which is that *some* stores can run
 * SQL. `asRawQueryable` is how a module asks, and the answer being `null` is
 * information rather than a failure: it is what tells a report it needs the
 * in-process fallback, which matters because the in-memory driver is the one
 * the generated test suite runs on.
 */
export interface IRawQueryable<T extends object> {
  /** The mapping, so raw SQL can name columns instead of guessing them. */
  readonly schema: EntitySchema<T>;

  /**
   * Runs SQL against the same connection the store uses — the transaction's,
   * when one is open.
   *
   * Values travel as named binds. The SQL itself is the caller's, so it must
   * never be assembled by concatenating anything a user sent.
   */
  executeRaw<TRow = Record<string, unknown>>(
    sql: string,
    binds?: Record<string, unknown>
  ): Promise<TRow[]>;
}

/**
 * The store as one that can run SQL, or `null` on a driver where there is none.
 *
 * ```ts
 * const sql = asRawQueryable(this.products);
 * return sql ? this.fromSql(sql) : this.fromMemory();
 * ```
 *
 * Checked at runtime rather than by configuration, because the answer genuinely
 * varies: the same module runs on PostgreSQL in production and in memory under
 * test, and it is the store in front of it that knows which.
 */
export function asRawQueryable<T extends object, TKey = number>(
  store: IGenericRepository<T, TKey>
): IRawQueryable<T> | null {
  const candidate = store as Partial<IRawQueryable<T>>;

  return typeof candidate.executeRaw === "function" && candidate.schema
    ? (candidate as IRawQueryable<T>)
    : null;
}
