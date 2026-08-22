import type { ColumnMetadata } from "../metadata/entity-metadata.js";

/**
 * What changes between engines when *creating* a schema, as opposed to querying
 * one.
 *
 * It is deliberately not part of `SqlDialect`. That one is read on every
 * statement a repository builds and is loaded by every consumer of the package;
 * this is read by a command somebody runs on purpose, before the application is
 * even started. Keeping them apart means an engine can gain DDL support without
 * touching the hot path, and a project that never generates a schema never
 * loads a line of it.
 *
 * They are also different questions. `SqlDialect` asks *how do I insert a row
 * and get its id back*; this asks *what is a boolean called here*. The overlap
 * is one identifier, `name`, which is what lets a caller pick this table with
 * the same string it configured `DATA_SOURCE` with.
 */
/** What a relation asks for when its parent row is deleted. */
export type OnDeleteRule = "restrict" | "cascade" | "set null" | "no action";

export interface DdlDialect {
  /** Matches the `SqlDialect` of the same engine, so one name selects both. */
  readonly name: string;

  /** The physical type for a column, `IDENTITY` clause excluded. */
  typeOf(column: ColumnMetadata): string;

  /**
   * The primary-key column's full declaration, generated key included.
   *
   * One method rather than a `identityClause` fragment because the engines do
   * not agree on where it goes or on whether it replaces the type: MySQL
   * appends `AUTO_INCREMENT`, PostgreSQL has a type of its own, SQL Server puts
   * `IDENTITY(1,1)` after the type, and Oracle spells out the whole standard
   * clause. A fragment would have to be positioned by the caller, and the
   * caller is the part that must not know these differences.
   */
  identityColumn(column: ColumnMetadata): string;

  /**
   * `IF NOT EXISTS`, where the engine has it.
   *
   * Oracle and SQL Server do not, and neither gets a hand-rolled `BEGIN ... IF
   * EXISTS` block here: emitting a PL/SQL wrapper around a `CREATE TABLE` turns
   * a file any tool can read into one only that engine's client can. The
   * generated header says so instead.
   */
  readonly supportsIfNotExists: boolean;

  /** Quotes an identifier. Used only where a name is not a plain word. */
  quote(identifier: string): string;

  /**
   * The `ON DELETE` clause, including its leading space — or nothing at all.
   *
   * Per dialect because the engines genuinely disagree, and not in a small way:
   * **SQL Server has no `RESTRICT`**, so the default every relation gets was a
   * syntax error there and no generated schema could be created at all. Oracle
   * has neither `RESTRICT` nor `NO ACTION` as clauses — omitting the clause
   * *is* restrict — so for those two rules it must emit nothing.
   *
   * Only a real server says any of this. The generator emitted `ON DELETE
   * RESTRICT` everywhere and every unit test agreed with it.
   */
  onDelete(rule: OnDeleteRule): string;
}


/**
 * The three engines that spell every rule the standard way.
 *
 * PostgreSQL and MySQL both accept all four; SQL Server accepts three of them
 * and calls the fourth something else, which is the whole reason this is not a
 * shared constant.
 */
const STANDARD_ON_DELETE: Record<OnDeleteRule, string> = {
  restrict: " ON DELETE RESTRICT",
  cascade: " ON DELETE CASCADE",
  "set null": " ON DELETE SET NULL",
  "no action": " ON DELETE NO ACTION",
};

/** Reserved words and anything that is not a bare identifier need quoting. */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function quoteWith(open: string, close: string) {
  return (identifier: string): string =>
    PLAIN.test(identifier) ? identifier : `${open}${identifier}${close}`;
}

/** `precision`/`scale` turn a number into a decimal; without them it is an integer. */
function isDecimal(column: ColumnMetadata): boolean {
  return column.precision !== undefined;
}

function decimalOf(column: ColumnMetadata): string {
  return column.scale === undefined
    ? `${column.precision}`
    : `${column.precision}, ${column.scale}`;
}

/** 255 is the default width; see `ColumnMetadata.length`. */
function widthOf(column: ColumnMetadata): number | "max" {
  return column.length ?? 255;
}

/**
 * Oracle.
 *
 * `NUMBER(1)` for a boolean because the mapping writes `1` and `0` — see
 * `EntitySchema.toColumnValue` — and a column typed anything else would reject
 * exactly the values the repository sends. That agreement between the mapping
 * and the schema is the whole reason generating the DDL is worth doing: it was
 * previously kept by hand, and the first project to get it wrong found out at
 * runtime.
 */
export const oracleDdl: DdlDialect = {
  name: "oracle",
  supportsIfNotExists: false,
  quote: quoteWith('"', '"'),

  typeOf(column) {
    switch (column.kind ?? "string") {
      case "number":
        return isDecimal(column) ? `NUMBER(${decimalOf(column)})` : "NUMBER(10)";
      case "boolean":
        return "NUMBER(1)";
      case "date":
        return "TIMESTAMP";
      default: {
        const width = widthOf(column);
        return width === "max" ? "CLOB" : `VARCHAR2(${width} CHAR)`;
      }
    }
  },

  identityColumn: (column) => `${oracleDdl.typeOf(column)} GENERATED BY DEFAULT AS IDENTITY`,

  // Oracle has exactly two: `CASCADE` and `SET NULL`. Refusing the delete is
  // what it does with no clause at all, so `restrict` emits nothing — writing
  // `ON DELETE RESTRICT` there is a syntax error, not a stricter constraint.
  onDelete: (rule) =>
    rule === "cascade" || rule === "set null" ? STANDARD_ON_DELETE[rule] : "",
};

/** SQL Server. `SMALLINT` for a boolean, for the reason given on Oracle's. */
export const sqlServerDdl: DdlDialect = {
  name: "mssql",
  supportsIfNotExists: false,
  quote: quoteWith("[", "]"),

  typeOf(column) {
    switch (column.kind ?? "string") {
      case "number":
        return isDecimal(column) ? `DECIMAL(${decimalOf(column)})` : "INT";
      case "boolean":
        return "SMALLINT";
      // `DATETIME2` and not `DATETIME`: the older type rounds to 3.33 ms, and
      // the driver already sends the value as a UTC wall clock with three
      // decimals — see `asUtcWallClock` in the query dialect.
      case "date":
        return "DATETIME2";
      default: {
        const width = widthOf(column);
        return `NVARCHAR(${width === "max" ? "MAX" : width})`;
      }
    }
  },

  identityColumn: (column) => `${sqlServerDdl.typeOf(column)} IDENTITY(1,1)`,

  // T-SQL has no `RESTRICT`. `NO ACTION` is the same refusal under the name it
  // does accept, and it is what the standard calls the immediate check anyway.
  onDelete: (rule) => STANDARD_ON_DELETE[rule === "restrict" ? "no action" : rule],
};

/**
 * PostgreSQL.
 *
 * `SMALLINT` for a boolean is the one that surprises people, and it is not a
 * limitation of the engine — it is that the mapping writes `1` and `0`, and
 * `BOOLEAN` in PostgreSQL will not take an integer. A demo lost an afternoon to
 * exactly that before this generator existed.
 *
 * `TIMESTAMPTZ` because the driver binds a `Date` respecting the instant, so
 * the column that stores it should keep the zone rather than drop it.
 *
 * Identifiers are left unquoted, which means the engine folds them to lower
 * case — and that is correct here: the repository generates upper-case SQL,
 * which resolves against those columns precisely because neither side is
 * quoted, and the column-to-property mapping is case-insensitive.
 */
export const postgresDdl: DdlDialect = {
  name: "postgres",
  supportsIfNotExists: true,
  quote: quoteWith('"', '"'),

  typeOf(column) {
    switch (column.kind ?? "string") {
      case "number":
        return isDecimal(column) ? `NUMERIC(${decimalOf(column)})` : "INTEGER";
      case "boolean":
        return "SMALLINT";
      case "date":
        return "TIMESTAMPTZ";
      default: {
        const width = widthOf(column);
        return width === "max" ? "TEXT" : `VARCHAR(${width})`;
      }
    }
  },

  // The standard clause rather than `SERIAL`: `SERIAL` is a macro for a
  // sequence plus a default, and the sequence it leaves behind outlives the
  // column. `GENERATED BY DEFAULT` — not `ALWAYS` — because seeding a table
  // with explicit ids has to stay possible.
  identityColumn: (column) => `${postgresDdl.typeOf(column)} GENERATED BY DEFAULT AS IDENTITY`,
  onDelete: (rule) => STANDARD_ON_DELETE[rule],
};

/** MySQL and MariaDB. */
export const mysqlDdl: DdlDialect = {
  name: "mysql",
  supportsIfNotExists: true,
  quote: quoteWith("`", "`"),

  typeOf(column) {
    switch (column.kind ?? "string") {
      case "number":
        return isDecimal(column) ? `DECIMAL(${decimalOf(column)})` : "INT";
      case "boolean":
        return "TINYINT(1)";
      // Three decimals, matching `CURRENT_TIMESTAMP(3)` in the query dialect: a
      // `DATETIME` with no precision truncates to the second, and a timestamp
      // that loses its milliseconds makes two rows written in the same second
      // unorderable.
      case "date":
        return "DATETIME(3)";
      default: {
        const width = widthOf(column);
        return width === "max" ? "TEXT" : `VARCHAR(${width})`;
      }
    }
  },

  identityColumn: (column) => `${mysqlDdl.typeOf(column)} AUTO_INCREMENT`,
  onDelete: (rule) => STANDARD_ON_DELETE[rule],
};

/**
 * Every engine that has a schema to generate, by the name `DATA_SOURCE` uses.
 *
 * MongoDB and the in-memory driver are absent rather than present-and-throwing:
 * neither has DDL, and a caller asking for one should get "there is no schema
 * to emit for this engine" from a lookup that fails, not a statement that turns
 * out to be a lie at execution time.
 */
export const DDL_DIALECTS: Record<string, DdlDialect> = {
  oracle: oracleDdl,
  mssql: sqlServerDdl,
  sqlserver: sqlServerDdl,
  postgres: postgresDdl,
  postgresql: postgresDdl,
  mysql: mysqlDdl,
  mariadb: mysqlDdl,
};

/** The dialect for an engine name, or `null` where there is no schema to emit. */
export function ddlDialectFor(engine: string): DdlDialect | null {
  return DDL_DIALECTS[engine.trim().toLowerCase()] ?? null;
}
