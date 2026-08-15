// NOTE ON THE OPTIONAL DRIVER: `oracledb` is declared as an *optional* peer
// dependency, but this static import defeats that: requiring this module loads
// the driver, so a consumer that only uses PostgreSQL still needs `oracledb`
// installed or the import throws before a single line of their code runs. The
// module-level configuration below makes it worse, because it runs on import.
// Before the optional peer dependency truly works this has to become a lazy
// `const oracledb = await import("oracledb")` resolved inside `getPool()` —the
// first place that really needs the driver— with the global settings applied
// right after loading it. The import is kept static for now to keep this port a
// straight translation; making it lazy is a separate change.
import oracledb from "oracledb";
import type { ILogger } from "@monolite/core";
import type { ISqlExecutor, SqlExecuteResult } from "../contracts/sql-executor.js";

/**
 * An Oracle bind: either the value itself, or a descriptor for output
 * parameters (`RETURNING ... INTO`). It is modelled here so that the `oracledb`
 * types are not dragged into the contracts.
 */
export interface OracleOutBind {
  dir: number;
  type?: number;
  maxSize?: number;
}

export type OracleBindValue = unknown | OracleOutBind;
export type OracleBinds = Record<string, OracleBindValue> | unknown[];

/** Oracle returns rows, affected rows and output binds in a single response. */
export type OracleExecuteResult<TRow = Record<string, unknown>> = SqlExecuteResult<TRow>;

/**
 * Runs statements inside an open transaction. The commit/rollback is handled by
 * `transaction()`, not by whoever receives this context.
 */
export type IOracleTransaction = ISqlExecutor;

/**
 * Connection to Oracle over `node-oracledb`.
 *
 * Its contract is the generic `ISqlExecutor` —what the generic repository
 * consumes— plus what managing the connection requires. It only adds one method
 * outside that script: stored procedures, which have no equivalent in the
 * generic API.
 */
export interface IOracleConnector extends ISqlExecutor {
  /** Opens the pool if needed and verifies that the database answers. */
  authenticate(): Promise<void>;

  /** Runs `work` in a transaction; commit at the end, rollback if it throws. */
  transaction<T>(work: (tx: IOracleTransaction) => Promise<T>): Promise<T>;

  /**
   * Calls a stored procedure and returns the contents of its output cursor.
   * Convention: the last parameter must be an `OUT SYS_REFCURSOR`, which is the
   * only way for an Oracle stored procedure to return rows.
   */
  execStoredProcedure<TRow = Record<string, unknown>>(
    spName: string,
    params?: unknown[]
  ): Promise<TRow[]>;

  /** Closes the pool. */
  close(): Promise<void>;
}

export interface OracleConnectionConfig {
  user: string;
  password: string;
  /** Easy Connect: `host:port/service`, e.g. `localhost:1521/FREEPDB1`. */
  connectString: string;
  poolMin?: number;
  poolMax?: number;
  poolIncrement?: number;
}

// Returning objects (`{ PK_USER: 1 }`) instead of positional arrays is what lets
// the generic repository map column -> property without knowing the order of the
// SELECT. It is global driver configuration, set exactly once.
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
// LOBs arrive as strings instead of as streams: it simplifies the mapping and
// our text columns are small.
oracledb.fetchAsString = [oracledb.CLOB];

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Connection to Oracle over `node-oracledb` in *thin* mode: it speaks the native
 * protocol from Node, so there is no need to install the Oracle Instant Client.
 *
 * It exposes what the generic repository consumes (`ISqlExecutor`), the pool
 * management and the stored procedures. What the generic API already covers
 * —projections, bulk insert— is not duplicated here.
 *
 * The pool is created lazily and memoized: the first operation that arrives
 * opens it and the rest wait on that same promise, so a start-up with several
 * requests in parallel does not create duplicate pools.
 */
export class OracleConnector implements IOracleConnector {
  private pool: oracledb.Pool | null = null;
  private pending: Promise<oracledb.Pool> | null = null;
  private closed = false;

  constructor(
    private readonly config: OracleConnectionConfig,
    private readonly logger: ILogger
  ) {}

  // ---------------------------------------------------------------- pool ----

  private async getPool(): Promise<oracledb.Pool> {
    if (this.pool) return this.pool;
    if (this.closed) throw new Error("[OracleConnector] The pool has already been closed.");

    if (!this.pending) {
      this.pending = oracledb
        .createPool({
          user: this.config.user,
          password: this.config.password,
          connectString: this.config.connectString,
          poolMin: this.config.poolMin ?? 1,
          poolMax: this.config.poolMax ?? 10,
          poolIncrement: this.config.poolIncrement ?? 1,
        })
        .then((pool) => {
          this.pool = pool;
          this.logger.info("Oracle pool created", {
            connectString: this.config.connectString,
            user: this.config.user,
          });
          return pool;
        })
        .catch((err) => {
          // Without this, a transient failure (the database still starting up)
          // would leave the rejected promise cached forever.
          this.pending = null;
          this.logger.error("The Oracle pool could not be created", { err: toMessage(err) });
          throw new Error(`[OracleConnector] createPool failed: ${toMessage(err)}`, { cause: err });
        });
    }

    return this.pending;
  }

  async authenticate(): Promise<void> {
    const pool = await this.getPool();
    const connection = await pool.getConnection();
    try {
      await connection.execute("SELECT 1 FROM DUAL");
      this.logger.info("Connection to Oracle established successfully.");
    } catch (err) {
      this.logger.error("Could not connect to Oracle", { err: toMessage(err) });
      throw new Error(`[OracleConnector] authenticate failed: ${toMessage(err)}`, { cause: err });
    } finally {
      await connection.close();
    }
  }

  // ----------------------------------------------------------- execution ----

  // The third parameter is part of the `ISqlExecutor` contract but Oracle does
  // not need it: it returns rows and affected rows in the same response.
  async execute<TRow = Record<string, unknown>>(
    sql: string,
    binds: OracleBinds = {}
  ): Promise<OracleExecuteResult<TRow>> {
    const pool = await this.getPool();
    const connection = await pool.getConnection();
    try {
      const result = await connection.execute(
        sql,
        binds as oracledb.BindParameters,
        { autoCommit: true }
      );
      this.logger.debug("Oracle execute", { sql });
      return {
        rows: (result.rows ?? []) as TRow[],
        rowsAffected: result.rowsAffected ?? 0,
        outBinds: (result.outBinds ?? {}) as Record<string, unknown[]>,
      };
    } catch (err) {
      this.logger.error("Error running a statement on Oracle", { sql, err: toMessage(err) });
      throw new Error(`[OracleConnector] execute failed: ${toMessage(err)}`, { cause: err });
    } finally {
      await connection.close();
    }
  }

  async executeMany(sql: string, binds: Record<string, unknown>[]): Promise<number> {
    if (binds.length === 0) return 0;

    const pool = await this.getPool();
    const connection = await pool.getConnection();
    try {
      const result = await connection.executeMany(
        sql,
        binds as oracledb.BindParameters[],
        { autoCommit: true }
      );
      this.logger.debug("Oracle executeMany", { sql, batch: binds.length });
      return result.rowsAffected ?? 0;
    } catch (err) {
      this.logger.error("Error in executeMany", { sql, err: toMessage(err) });
      throw new Error(`[OracleConnector] executeMany failed: ${toMessage(err)}`, { cause: err });
    } finally {
      await connection.close();
    }
  }

  /**
   * Calls a stored procedure and returns the contents of its output cursor.
   *
   * Convention: the procedure must declare an `OUT SYS_REFCURSOR` as its last
   * parameter. It is the only way for an Oracle stored procedure to return a set
   * of rows, and it lets this method keep the same signature as in the rest of
   * the drivers.
   */
  async execStoredProcedure<TRow = Record<string, unknown>>(
    spName: string,
    params: unknown[] = []
  ): Promise<TRow[]> {
    const binds: Record<string, unknown> = {};
    params.forEach((value, i) => {
      binds[`p${i}`] = value;
    });
    binds.cursor = { dir: oracledb.BIND_OUT, type: oracledb.CURSOR };

    const placeholders = params.map((_, i) => `:p${i}`).concat(":cursor").join(", ");
    const sql = `BEGIN ${spName}(${placeholders}); END;`;

    const pool = await this.getPool();
    const connection = await pool.getConnection();
    try {
      const result = await connection.execute(sql, binds as oracledb.BindParameters);
      const outBinds = result.outBinds as { cursor?: oracledb.ResultSet<TRow> } | undefined;
      const resultSet = outBinds?.cursor;
      if (!resultSet) return [];

      const rows = await resultSet.getRows();
      await resultSet.close();
      return rows as TRow[];
    } catch (err) {
      this.logger.error("Error running a stored procedure", {
        spName,
        err: toMessage(err),
      });
      throw new Error(`[OracleConnector] execStoredProcedure ${spName} failed: ${toMessage(err)}`, {
        cause: err,
      });
    } finally {
      await connection.close();
    }
  }

  /**
   * Runs `work` on a single connection and without auto-commit: if it finishes
   * cleanly there is a commit, if it throws there is a rollback.
   */
  async transaction<T>(work: (tx: IOracleTransaction) => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    const connection = await pool.getConnection();

    // Same contract as the pool but without auto-commit, so the generic
    // repository can run inside the transaction without knowing it.
    const tx: IOracleTransaction = {
      execute: async <TRow = Record<string, unknown>>(sql: string, binds: OracleBinds = {}) => {
        const result = await connection.execute(sql, binds as oracledb.BindParameters, {
          autoCommit: false,
        });
        return {
          rows: (result.rows ?? []) as TRow[],
          rowsAffected: result.rowsAffected ?? 0,
          outBinds: (result.outBinds ?? {}) as Record<string, unknown[]>,
        };
      },
      executeMany: async (sql: string, binds: Record<string, unknown>[]) => {
        if (binds.length === 0) return 0;
        const result = await connection.executeMany(
          sql,
          binds as oracledb.BindParameters[],
          { autoCommit: false }
        );
        return result.rowsAffected ?? 0;
      },
    };

    try {
      const result = await work(tx);
      await connection.commit();
      return result;
    } catch (err) {
      await connection.rollback();
      this.logger.error("Transaction rolled back", { err: toMessage(err) });
      throw err;
    } finally {
      await connection.close();
    }
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    // The 10 s drain lets in-flight queries finish instead of cutting them off.
    await this.pool.close(10);
    this.pool = null;
    this.pending = null;
    this.closed = true;
    this.logger.info("Oracle pool closed.");
  }
}
