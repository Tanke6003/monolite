import type { SqlExecuteResult } from "../contracts/sql-executor.js";
import { loadOptionalDriver } from "../connectors/optional-driver.js";

export interface BuildInsertParams {
  table: string;
  /** Columns to write, already in the order of `values`. */
  columns: string[];
  /** Expression per column: a bind (`:b0`) or an engine expression. */
  values: string[];
  primaryKeyColumn: string;
  /** `true` if the database generates the PK and it has to be recovered. */
  identity: boolean;
}

/**
 * Where the generated PK comes from. It is the difference that separates the
 * engines the most:
 *
 * - `outBinds`: Oracle, with `RETURNING ... INTO` and an output parameter.
 * - `rows`: SQL Server (`OUTPUT INSERTED`) and PostgreSQL (`RETURNING`), which
 *   return the row as a result set.
 * - `driver`: MySQL/MariaDB, which has neither of the two and exposes the id
 *   through the driver itself (`LAST_INSERT_ID()`).
 * - `none`: the entity does not use identity, so there is no id to recover.
 */
export type InsertedIdSource = "outBinds" | "rows" | "driver" | "none";

export interface InsertStatement {
  sql: string;
  /** Extra binds the engine requires in order to return the PK (Oracle). */
  binds: Record<string, unknown>;
  idFrom: InsertedIdSource;
}

/**
 * What changes between SQL engines when generating statements. Everything else
 * —the WHERE, the ORDER BY, the projection, the soft delete, the auditing— is
 * identical and lives exactly once in `SqlGenericRepository`.
 */
export interface SqlDialect {
  readonly name: string;
  /** Server date-and-time expression. */
  readonly currentTimestamp: string;
  buildInsert(params: BuildInsertParams): InsertStatement;
  /** Recovers the generated PK from the INSERT result. */
  readInsertedId(result: SqlExecuteResult): unknown;
  /**
   * Last conversion before handing a value to the driver. It exists because not
   * all of them read a date the same way (see `sqlServerDialect`).
   */
  toBindValue(value: unknown): unknown;
  /** Pagination clause. */
  buildPagination(hasTake: boolean): string;
  /**
   * A read that locks a row by PK until commit, with the `:pk` bind.
   *
   * It is what serializes a use case that decides based on what it reads. The
   * three engines that speak standard SQL write it the same way; T-SQL has no
   * `FOR UPDATE` and solves it with hints, which is exactly the kind of
   * difference this dialect exists to absorb.
   */
  buildRowLock(table: string, primaryKeyColumn: string): string;
}

/** Name of the output bind and of the alias the generated PK comes back under. */
const INSERTED_ID = "insertedId";

/** Standard SQL OFFSET/FETCH: Oracle, SQL Server and PostgreSQL all speak it. */
const STANDARD_PAGINATION = (hasTake: boolean): string =>
  ` OFFSET :pgskip ROWS${hasTake ? " FETCH NEXT :pgtake ROWS ONLY" : ""}`;

const passthrough = (value: unknown): unknown => value;

/**
 * `SELECT ... FOR UPDATE`, spoken by Oracle, PostgreSQL and MySQL/InnoDB. The
 * lock is released by the commit or the rollback, never by hand.
 */
const STANDARD_ROW_LOCK = (table: string, primaryKeyColumn: string): string =>
  `SELECT ${primaryKeyColumn} FROM ${table} WHERE ${primaryKeyColumn} = :pk FOR UPDATE`;

/**
 * Sends dates in UTC and without an offset.
 *
 * Sequelize escapes a `Date` as **local time with an offset**; SQL Server and
 * MySQL discard that offset when storing it in DATETIME2/DATETIME and then read
 * it back **as if it were UTC**. The instant ends up shifted by as many hours as
 * the time zone has, and with it any later comparison —that is what made the
 * appointment-overlap rule stop detecting clashes—. Sending it already in UTC is
 * exactly what the read assumes.
 */
const asUtcWallClock = (value: unknown): unknown =>
  value instanceof Date ? value.toISOString().slice(0, 23).replace("T", " ") : value;

/** Looks the column up case-insensitively: every driver returns it its own way. */
function readIdFromRows(result: SqlExecuteResult): unknown {
  const [row] = result.rows;
  if (!row) return undefined;

  const match = Object.entries(row).find(
    ([column]) => column.toLowerCase() === INSERTED_ID.toLowerCase()
  );
  return match?.[1];
}

/**
 * Oracle recovers the PK with `RETURNING ... INTO`, which needs an output bind
 * and produces no rows.
 */
export const oracleDialect: SqlDialect = {
  name: "oracle",
  currentTimestamp: "SYSTIMESTAMP",

  buildInsert({ table, columns, values, primaryKeyColumn, identity }): InsertStatement {
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")})`;

    if (!identity) return { sql, binds: {}, idFrom: "none" };

    // The two constants are read from the driver rather than inlined as the
    // numbers it documents, and the driver is loaded here rather than at the
    // top of the file: this module is imported by every consumer of the
    // package, and only an insert against Oracle actually needs `oracledb`.
    const oracle = loadOptionalDriver<typeof import("oracledb")>("oracledb", "Oracle");

    return {
      sql: `${sql} RETURNING ${primaryKeyColumn} INTO :${INSERTED_ID}`,
      binds: { [INSERTED_ID]: { dir: oracle.BIND_OUT, type: oracle.NUMBER } },
      idFrom: "outBinds",
    };
  },

  readInsertedId: (result) =>
    (result.outBinds?.[INSERTED_ID] as unknown[] | undefined)?.[0],

  // node-oracledb binds a JS Date preserving the instant.
  toBindValue: passthrough,
  buildPagination: STANDARD_PAGINATION,
  buildRowLock: STANDARD_ROW_LOCK,
};

/**
 * SQL Server does it with `OUTPUT INSERTED`, preferable to `SCOPE_IDENTITY()`
 * because it does not depend on the session scope.
 */
export const sqlServerDialect: SqlDialect = {
  name: "mssql",
  currentTimestamp: "SYSDATETIME()",

  buildInsert({ table, columns, values, primaryKeyColumn, identity }): InsertStatement {
    const output = identity ? ` OUTPUT INSERTED.${primaryKeyColumn} AS ${INSERTED_ID}` : "";

    return {
      sql: `INSERT INTO ${table} (${columns.join(", ")})${output} VALUES (${values.join(", ")})`,
      binds: {},
      idFrom: identity ? "rows" : "none",
    };
  },

  readInsertedId: readIdFromRows,

  toBindValue: asUtcWallClock,
  buildPagination: STANDARD_PAGINATION,

  /**
   * T-SQL has no `FOR UPDATE`; the equivalent are the hints. `UPDLOCK` takes the
   * update lock that prevents two sessions from reading at the same time with
   * the intention of writing, and `HOLDLOCK` holds it until commit instead of
   * releasing it when the statement ends, which is what is needed here.
   */
  buildRowLock: (table, primaryKeyColumn) =>
    `SELECT ${primaryKeyColumn} FROM ${table} WITH (UPDLOCK, HOLDLOCK) WHERE ${primaryKeyColumn} = :pk`,
};

/**
 * PostgreSQL uses `RETURNING`, which gives back the inserted row.
 *
 * A note on identifiers: Postgres folds everything that is not quoted to lower
 * case, so the upper-case SQL the repository generates resolves against tables
 * created without quotes too. The column-to-property mapping is
 * case-insensitive, so the columns that come back in lower case resolve just the
 * same.
 */
export const postgresDialect: SqlDialect = {
  name: "postgres",
  currentTimestamp: "NOW()",

  buildInsert({ table, columns, values, primaryKeyColumn, identity }): InsertStatement {
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")})`;

    if (!identity) return { sql, binds: {}, idFrom: "none" };

    return {
      sql: `${sql} RETURNING ${primaryKeyColumn} AS ${INSERTED_ID}`,
      binds: {},
      idFrom: "rows",
    };
  },

  readInsertedId: readIdFromRows,
  // node-postgres binds a Date respecting the instant, and the column is
  // TIMESTAMPTZ: there is nothing to adjust.
  toBindValue: passthrough,
  buildPagination: STANDARD_PAGINATION,
  buildRowLock: STANDARD_ROW_LOCK,
};

/**
 * MySQL and MariaDB have neither `RETURNING` nor `OUTPUT`: the generated id is
 * exposed by the driver itself after the INSERT. They do not understand
 * `OFFSET ... FETCH NEXT` either, so they paginate with `LIMIT`.
 */
export const mysqlDialect: SqlDialect = {
  name: "mysql",
  currentTimestamp: "CURRENT_TIMESTAMP(3)",

  buildInsert({ table, columns, values, identity }): InsertStatement {
    return {
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")})`,
      binds: {},
      idFrom: identity ? "driver" : "none",
    };
  },

  readInsertedId: readIdFromRows,
  // Same shift as SQL Server: DATETIME does not store the offset either.
  toBindValue: asUtcWallClock,

  /**
   * MySQL requires a `LIMIT` in order to use `OFFSET`. When there is only an
   * offset, the maximum it accepts is used, which is the trick documented by the
   * manual itself for "from row N to the end".
   */
  buildPagination: (hasTake) =>
    hasTake ? " LIMIT :pgtake OFFSET :pgskip" : " LIMIT 18446744073709551615 OFFSET :pgskip",

  buildRowLock: STANDARD_ROW_LOCK,
};
