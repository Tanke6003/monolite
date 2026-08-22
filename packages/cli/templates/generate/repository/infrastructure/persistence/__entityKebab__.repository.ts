import type { ILogger } from "monolite-core";
import { asRawQueryable, BaseModuleRepository } from "monolite-data";
import type { IGenericRepository, IRawQueryable } from "monolite-data";
import { TOKENS } from "monolite-di";
import { inject, injectable } from "tsyringe";
import { __entityUpper___TOKENS } from "../../composition/modules/__entityKebab__.tokens";
import type { I__entityName__ } from "../../domain/models/__entityKebab__.model";

/**
 * The __entityKebab__ store, plus this module's own queries.
 *
 * You do not need this to do CRUD. `defineEntity` already produced a repository
 * that selects, inserts, updates, pages, filters and soft-deletes on every
 * engine, and a module that only does those should inject it directly and stop
 * there — a class that forwards seventeen methods and adds nothing is a layer
 * for the sake of having one.
 *
 * What this is for is the query the generic API deliberately does not express:
 * an aggregate, a `GROUP BY`, a view, a stored procedure. It extends
 * `BaseModuleRepository`, which forwards the whole contract to the store and
 * wraps every call in a guard that logs the driver's error and re-throws a
 * neutral one — so the details stay in the log and never reach a client.
 *
 * Compare with `generate query`: that one is for an answer computed across
 * entities and owns no table. This one belongs to **this** entity and adds
 * methods to its own repository.
 */
export interface I__entityPlural__Repository extends IGenericRepository<I__entityName__> {
  /** Replace this. It is here so the file compiles and answers on day one. */
  countAll(): Promise<number>;
}

@injectable()
export class __entityPlural__Repository
  extends BaseModuleRepository<I__entityName__>
  implements I__entityPlural__Repository
{
  constructor(
    // The store the persistence layer registered for this entity. Since 0.6.0
    // it already joins whatever transaction is open, so nothing here has to be
    // told about one.
    @inject(__entityUpper___TOKENS.store) store: IGenericRepository<I__entityName__>,
    @inject(TOKENS.ILogger) logger: ILogger
  ) {
    // The third argument is what shows up in the log line and in the error
    // message, so it should read like the class it is.
    super(store, logger, "__entityPlural__Repository");
  }

  /**
   * How many rows there are, the long way round.
   *
   * `count()` on the generic contract already answers this, and that is the
   * point of the example: it shows the two paths side by side without needing a
   * schema you do not have yet. Replace the body with the aggregate you
   * actually came here for.
   *
   * `guard` is what turns a driver error into a logged detail and a neutral
   * throw. Use it for anything that touches the database.
   */
  public countAll(): Promise<number> {
    return this.guard("countAll", async () => {
      const sql = asRawQueryable(this.store);

      // `null` on the drivers with no SQL to run — the in-memory one, which is
      // what your generated test suite uses. The fallback is not optional.
      if (!sql) return this.store.count();

      return this.countBySql(sql);
    });
  }

  /**
   * The SQL path.
   *
   * Physical names come from the mapping rather than being written out, so
   * renaming a column in the entity cannot leave this pointing at a name that
   * no longer exists. Any value travels as a named bind; nothing a user sent is
   * ever concatenated into the statement.
   */
  private async countBySql(sql: IRawQueryable<I__entityName__>): Promise<number> {
    const rows = await sql.executeRaw<{ TOTAL: number }>(
      `SELECT COUNT(*) AS TOTAL FROM ${sql.schema.table}`
    );

    // Engines disagree about whether an aggregate comes back as a number or a
    // string; `Number` settles it here instead of at every caller.
    return Number(rows[0]?.TOTAL ?? 0);
  }
}
