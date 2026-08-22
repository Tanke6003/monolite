import type { Options, Sequelize, Transaction } from "sequelize";
import type { ILogger } from "monolite-core";
import type {
  ISqlExecutor,
  SqlExecuteOptions,
  SqlExecuteResult,
} from "../contracts/sql-executor.js";
import type { DbEngine, ISqlDbPlugin } from "../contracts/db-plugin.js";
import { loadOptionalDriver } from "./optional-driver.js";

type SequelizeModule = typeof import("sequelize");

let loaded: SequelizeModule | undefined;

/**
 * Sequelize, required on first use rather than on import.
 *
 * `Sequelize` and `QueryTypes` are values, so importing them statically would
 * load the ORM —and, underneath it, `tedious`, `pg` or `mysql2`— for every
 * consumer of this package, including the ones on Oracle or MongoDB that
 * declared none of them. The types stay static and cost nothing.
 */
function driver(): SequelizeModule {
  loaded ??= loadOptionalDriver<SequelizeModule>("sequelize", "SQL Server, PostgreSQL and MySQL");
  return loaded;
}

/** Engines this connector covers; Sequelize speaks all three. */
export type SequelizeEngine = Extract<DbEngine, "mssql" | "postgres" | "mysql">;

export interface SequelizeConnectionConfig {
  engine: SequelizeEngine;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  poolMin?: number;
  poolMax?: number;
}

/** Alias of the engine as Sequelize names it. */
const SEQUELIZE_DIALECT: Record<SequelizeEngine, "mssql" | "postgres" | "mysql"> = {
  mssql: "mssql",
  postgres: "postgres",
  mysql: "mysql",
};

/** Alias of the column SQL Server reports the affected rows in. */
const AFFECTED_ROWS = "AFFECTEDROWS";
/** Alias the dialect expects to find the generated PK under. */
const INSERTED_ID = "insertedId";

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether this statement must be the only one in its batch.
 *
 * T-SQL only, and only about the `@@ROWCOUNT` probe below: the body of a
 * `CREATE PROCEDURE` runs to the end of the batch, so a statement appended
 * after it does not run *after* it — it is compiled *into* it, and the
 * procedure then returns a spurious row to everybody who calls it forever. The
 * same is true of CREATE FUNCTION, TRIGGER and VIEW.
 *
 * A keyword check rather than a parser, because that is all the question needs:
 * the four objects with a body are the four that begin this way, and none of
 * them reports a row count worth reading, so a false positive costs nothing.
 */
function ownsItsBatch(sql: string): boolean {
  return /^\s*(create|alter)\s+(or\s+alter\s+)?(procedure|proc|function|trigger|view)\b/i.test(sql);
}

/**
 * Connector for the SQL engines Sequelize speaks: SQL Server, PostgreSQL and
 * MySQL/MariaDB.
 *
 * It is a single one for all three because what differs between them —how a
 * generated PK is recovered, the date expression, the pagination— lives in the
 * `SqlDialect`, not here. The only thing this connector resolves per engine is
 * how to ask the driver for two pieces of data that not all of them return the
 * same way: the affected rows and the generated id.
 *
 * A note on the binds: Sequelize's `replacements` are escaped and interpolated,
 * they are not server-side parameters. The escaping is done by Sequelize
 * according to the dialect, so it is safe against injection, but it does not
 * reuse execution plans the way a real bind would.
 */
/**
 * MySQL answers a `CALL` with more than one result set.
 *
 * A procedure returns its own rows *and* a status packet, and one that returns
 * nothing answers with the status packet alone. Neither shape is what the two
 * paths below were written for: the row reader handed back the packet as if it
 * were a row, and the affected-rows reader crashed inside Sequelize trying to
 * map something that is not an array.
 *
 * The consequence was that `executeRaw` — the documented way to call a stored
 * procedure — could not call one at all on MySQL. It went unnoticed because the
 * only thing that had ever run it was a double, and a double accepts a `CALL`
 * that no server would.
 */
interface OkPacket {
  affectedRows: number;
  serverStatus: number;
  fieldCount: number;
}

function isOkPacket(value: unknown): value is OkPacket {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.affectedRows === "number" &&
    typeof candidate.serverStatus === "number" &&
    typeof candidate.fieldCount === "number"
  );
}

/**
 * The rows out of whatever MySQL answered.
 *
 * Read off a live server rather than reasoned about, because the driver uses
 * four different shapes and only two of them are documented anywhere:
 *
 * | statement          | raw answer                        |
 * | ------------------ | --------------------------------- |
 * | `SELECT`           | `[rows, rows]` — first is an array |
 * | `CALL` that reads  | `[row, row, ...]` — already flat   |
 * | `CALL` that writes | `undefined`                        |
 * | `UPDATE`, DDL      | `[okPacket, okPacket]`             |
 *
 * The third is the one that used to crash: Sequelize's `SELECT` normaliser
 * calls `.map` on it, so `executeRaw` could not call a writing procedure on
 * MySQL at all — the documented escape hatch, on one of the six engines.
 */
function mysqlRows<TRow>(answered: unknown): TRow[] {
  if (answered === undefined || answered === null) return [];
  if (!Array.isArray(answered)) return isOkPacket(answered) ? [] : [answered as TRow];

  const [first] = answered;

  if (first === undefined) return [];
  // An UPDATE or a DDL statement: a count, not a result set.
  if (isOkPacket(first)) return [];
  // A plain SELECT: the pair is (rows, metadata) and both are the rows.
  if (Array.isArray(first)) return first as TRow[];

  // A procedure that selected: the driver already flattened its result set.
  return answered as TRow[];
}

/**
 * The rows a MySQL statement touched, from whichever shape it reported.
 *
 * Measured, like `mysqlRows`, and the INSERT one is a trap: the pair is
 * **(insertId, affectedRows)**, so reading the first element gives a row's id
 * where a count was wanted. It is a plausible-looking number — a bulk insert of
 * two rows reported nine, which was simply the auto-increment where it happened
 * to be — and nothing but a real server would produce it.
 *
 * | statement          | raw answer                | count is        |
 * | ------------------ | ------------------------- | --------------- |
 * | `INSERT`           | `[insertId, affected]`    | the second      |
 * | `UPDATE`, DDL      | `[okPacket, okPacket]`    | `affectedRows`  |
 * | `CALL` that writes | `undefined`               | unreported: 0   |
 */
function mysqlAffected(answered: unknown): number {
  if (!Array.isArray(answered)) return isOkPacket(answered) ? answered.affectedRows : 0;

  const [first, second] = answered;

  if (isOkPacket(first)) return first.affectedRows;
  if (typeof second === "number") return second;

  return 0;
}

export class SequelizeConnector implements ISqlDbPlugin {
  readonly engine: DbEngine;
  private readonly connection: Sequelize;

  constructor(
    private readonly config: SequelizeConnectionConfig,
    private readonly logger: ILogger
  ) {
    this.engine = config.engine;
    this.connection = new (driver().Sequelize)({
      dialect: SEQUELIZE_DIALECT[config.engine],
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      database: config.database,
      pool: { max: config.poolMax ?? 10, min: config.poolMin ?? 0, idle: 10000 },
      logging:
        process.env.NODE_ENV !== "production"
          ? (sql: string) => this.logger.debug(sql)
          : false,
    } as Options);
  }

  async authenticate(): Promise<void> {
    try {
      await this.connection.authenticate();
      this.logger.info(`Connection to ${this.engine} established successfully.`);
    } catch (err) {
      this.logger.error(`Could not connect to ${this.engine}`, { err: toMessage(err) });
      throw new Error(`[SequelizeConnector:${this.engine}] authenticate failed: ${toMessage(err)}`, {
        cause: err,
      });
    }
  }

  // ----------------------------------------------------------- execution ----

  /**
   * Affected rows.
   *
   * SQL Server does not report them in the response, so a `SELECT @@ROWCOUNT`
   * is appended and read as a result set. PostgreSQL and MySQL do return them,
   * and Sequelize exposes them through `QueryTypes.BULKUPDATE`.
   */
  private async runAffected(
    sql: string,
    binds: Record<string, unknown>,
    transaction?: Transaction
  ): Promise<number> {
    if (this.engine === "mssql") {
      // Nothing may be appended to a statement that owns its batch; see above.
      if (ownsItsBatch(sql)) {
        await this.connection.query(sql, {
          replacements: binds,
          type: driver().QueryTypes.RAW,
          transaction,
        });
        return 0;
      }

      // @@ROWCOUNT reflects the last statement of the batch, which is the write.
      const rows = (await this.connection.query(
        `${sql}; SELECT @@ROWCOUNT AS ${AFFECTED_ROWS};`,
        { replacements: binds, type: driver().QueryTypes.SELECT, transaction }
      )) as Record<string, unknown>[];

      return Number(rows.at(-1)?.[AFFECTED_ROWS] ?? 0);
    }

    if (this.engine === "mysql") {
      // `RAW` rather than `BULKUPDATE`: the latter assumes the driver answered
      // with something it can map, and a `CALL` does not. Raw gives back what
      // the server said, and `affectedFrom` reads the count out of it — the
      // same number for an UPDATE, and the only way to get one for a CALL.
      //
      // Only MySQL: it is the engine that answers with status packets, and
      // PostgreSQL's raw answer for an UPDATE is an empty row list, from which
      // no count can be read at all.
      // Not destructured: a procedure that only writes answers `undefined`, and
      // there is nothing to take a first element of.
      const answered = (await this.connection.query(sql, {
        replacements: binds,
        type: driver().QueryTypes.RAW,
        transaction,
      })) as unknown;

      return mysqlAffected(answered);
    }

    const affected = (await this.connection.query(sql, {
      replacements: binds,
      type: driver().QueryTypes.BULKUPDATE,
      transaction,
    })) as unknown as number;

    return Number(affected ?? 0);
  }

  /** Id generated by the engine, for the ones that have neither RETURNING nor OUTPUT. */
  private async runIdentity(
    sql: string,
    binds: Record<string, unknown>,
    transaction?: Transaction
  ): Promise<SqlExecuteResult<never>> {
    // `QueryTypes.INSERT` returns [id, rows]; it is how Sequelize exposes
    // LAST_INSERT_ID() without having to emit a second statement, which in a
    // pool could end up on another connection and return the wrong id.
    const [insertedId, affected] = (await this.connection.query(sql, {
      replacements: binds,
      type: driver().QueryTypes.INSERT,
      transaction,
    })) as unknown as [number, number];

    return {
      rows: [{ [INSERTED_ID]: insertedId }] as never[],
      rowsAffected: Number(affected ?? 1),
      outBinds: {},
    };
  }

  private async run<TRow>(
    sql: string,
    binds: Record<string, unknown>,
    options: SqlExecuteOptions,
    transaction?: Transaction
  ): Promise<SqlExecuteResult<TRow>> {
    try {
      const expects = options.expects ?? "rows";

      if (expects === "rows") {
        // Sequelize's `SELECT` normaliser assumes one result set. MySQL sends
        // several for a `CALL`, and none at all for one that only writes, so
        // that engine reads the raw answer and sorts the shapes out itself.
        if (this.engine === "mysql") {
          const answered = (await this.connection.query(sql, {
            replacements: binds,
            type: driver().QueryTypes.RAW,
            transaction,
          })) as unknown;

          const rows = mysqlRows<TRow>(answered);
          return { rows, rowsAffected: rows.length, outBinds: {} };
        }

        const rows = (await this.connection.query(sql, {
          replacements: binds,
          type: driver().QueryTypes.SELECT,
          transaction,
        })) as TRow[];

        return { rows, rowsAffected: rows.length, outBinds: {} };
      }

      if (expects === "identity") {
        return (await this.runIdentity(sql, binds, transaction)) as SqlExecuteResult<TRow>;
      }

      return {
        rows: [],
        rowsAffected: await this.runAffected(sql, binds, transaction),
        outBinds: {},
      };
    } catch (err) {
      this.logger.error(`Error running a statement on ${this.engine}`, {
        sql,
        err: toMessage(err),
      });
      throw new Error(`[SequelizeConnector:${this.engine}] execute failed: ${toMessage(err)}`, {
        cause: err,
      });
    }
  }

  execute<TRow = Record<string, unknown>>(
    sql: string,
    binds: Record<string, unknown> = {},
    options: SqlExecuteOptions = {}
  ): Promise<SqlExecuteResult<TRow>> {
    return this.run<TRow>(sql, binds, options, undefined);
  }

  /**
   * Sequelize has no `executeMany` like node-oracledb's, so the statement is
   * repeated inside a transaction: either every row goes in or none does, which
   * is the guarantee Oracle's bulk gives.
   */
  private async runMany(
    sql: string,
    binds: Record<string, unknown>[],
    transaction: Transaction
  ): Promise<number> {
    let affected = 0;
    for (const row of binds) {
      affected += await this.runAffected(sql, row, transaction);
    }
    return affected;
  }

  async executeMany(sql: string, binds: Record<string, unknown>[]): Promise<number> {
    if (binds.length === 0) return 0;

    const affected = await this.connection.transaction((t) => this.runMany(sql, binds, t));
    this.logger.debug(`${this.engine} executeMany`, { sql, batch: binds.length, affected });
    return affected;
  }

  /**
   * Transaction managed by Sequelize: commit on resolve, rollback on throw. The
   * block receives an executor bound to it.
   */
  transaction<T>(work: (tx: ISqlExecutor) => Promise<T>): Promise<T> {
    return this.connection.transaction(async (t) => {
      const tx: ISqlExecutor = {
        execute: <TRow = Record<string, unknown>>(
          sql: string,
          binds: Record<string, unknown> = {},
          options: SqlExecuteOptions = {}
        ) => this.run<TRow>(sql, binds, options, t),
        executeMany: (sql: string, binds: Record<string, unknown>[]) =>
          binds.length === 0 ? Promise.resolve(0) : this.runMany(sql, binds, t),
      };

      return work(tx);
    });
  }

  async close(): Promise<void> {
    await this.connection.close();
    this.logger.info(`Connection to ${this.engine} closed.`);
  }
}
