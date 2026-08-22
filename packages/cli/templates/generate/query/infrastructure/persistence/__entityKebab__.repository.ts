import { inject, injectable } from "tsyringe";
import { asRawQueryable } from "monolite-data";
import type { IGenericRepository, IRawQueryable } from "monolite-data";
import { __overUpper___TOKENS } from "../../composition/modules/__overKebab__.tokens";
import type { I__overName__ } from "../../domain/models/__overKebab__.model";

/**
 * One row of the __resourceLabel__, as the database answers it.
 *
 * It is not the DTO. Nothing here has crossed the HTTP boundary yet, and the
 * decision about what a client may see belongs a layer up — see the BLL.
 */
export interface __entityName__Row {
  total: number;
  lowestId: number | null;
  highestId: number | null;
}

export interface I__entityName__Repository {
  rows(): Promise<__entityName__Row[]>;
}

/**
 * The __resourceLabel__, over __overPlural__.
 *
 * A query is what you write when the generic API runs out. Aggregations,
 * `GROUP BY`, views and stored procedures are outside the filter language on
 * purpose — expressing them would turn it into an ORM — so this reaches for
 * `executeRaw` through `asRawQueryable`, which is the contract that says *this
 * store can run SQL*.
 *
 * It reads one entity because a generator can only be told one. A report over
 * three injects three stores the same way, and joins them in the SQL below.
 *
 * **Replace the aggregate.** What it computes now — how many rows, the lowest
 * and highest id — is a placeholder that is true of any table, so the module
 * compiles and answers before you have written a line. What it demonstrates is
 * the part worth keeping: binds instead of concatenation, column names out of
 * the mapping, and a fallback for the drivers that have no SQL.
 */
@injectable()
export class __entityName__Repository implements I__entityName__Repository {
  constructor(
    @inject(__overUpper___TOKENS.store)
    private readonly __overPluralCamel__: IGenericRepository<I__overName__>
  ) {}

  public async rows(): Promise<__entityName__Row[]> {
    const sql = asRawQueryable(this.__overPluralCamel__);

    // `null` is not a misconfiguration: the in-memory and MongoDB drivers have
    // no SQL to run. The in-memory one is what the generated test suite uses,
    // so the fallback below is the branch your tests actually exercise.
    return sql ? this.fromSql(sql) : this.fromMemory();
  }

  /**
   * The SQL path.
   *
   * Physical names come from the mapping rather than being written out, so
   * renaming a column in the entity does not leave a report pointing at a name
   * that no longer exists. Any value would travel as a named bind; nothing a
   * user sent is ever concatenated into the statement.
   */
  private async fromSql(sql: IRawQueryable<I__overName__>): Promise<__entityName__Row[]> {
    const pk = sql.schema.columnOf("__overPkProperty__");

    const rows = await sql.executeRaw<{ TOTAL: number; LOWEST: number; HIGHEST: number }>(
      `SELECT COUNT(*) AS TOTAL, MIN(${pk}) AS LOWEST, MAX(${pk}) AS HIGHEST FROM ${sql.schema.table}`
    );

    return rows.map((row) => ({
      // Engines disagree about whether an aggregate comes back as a number or a
      // string; `Number` settles it in one place instead of at each caller.
      total: Number(row.TOTAL ?? 0),
      lowestId: row.LOWEST === null || row.LOWEST === undefined ? null : Number(row.LOWEST),
      highestId: row.HIGHEST === null || row.HIGHEST === undefined ? null : Number(row.HIGHEST),
    }));
  }

  /** The same answer computed in the process, for the drivers with no SQL. */
  private async fromMemory(): Promise<__entityName__Row[]> {
    const all = await this.__overPluralCamel__.getAll();
    const ids = all.map((one) => one.__overPkProperty__);

    return [
      {
        total: ids.length,
        lowestId: ids.length ? Math.min(...ids) : null,
        highestId: ids.length ? Math.max(...ids) : null,
      },
    ];
  }
}
