import type { ISqlExecutor } from "./sql-executor.js";

/** Supported engines. It is also the value accepted by `DATA_SOURCE`. */
export type DbEngine = "memory" | "oracle" | "mssql" | "postgres" | "mysql" | "mongodb";

/**
 * Contract shared by **every** connector, SQL or document oriented.
 *
 * It only covers the connection lifecycle, which is the only thing they truly
 * have in common: open, check and close. That is what application start-up
 * needs, and it is why the entry point does not know which engine it is running
 * against.
 *
 * Uniformity as seen by the services does not live here but one floor above, in
 * `IGenericRepository<T>`: there every engine really is used in exactly the same
 * way. Trying to unify further down would mean pretending that SQL statements
 * can be sent to MongoDB.
 */
export interface IDbPlugin {
  /** Identifies the engine in logs and diagnostics. */
  readonly engine: DbEngine;

  /** Opens the connection if needed and checks that the database answers. */
  authenticate(): Promise<void>;

  /** Releases the pool or the client. */
  close(): Promise<void>;
}

/**
 * Connector for a SQL engine. It adds to the lifecycle what the generic
 * repository consumes: running statements and opening transactions.
 *
 * Oracle, SQL Server, PostgreSQL and MySQL/MariaDB implement it, and that is
 * why all four share a single `SqlGenericRepository`: what differs between them
 * lives in the `SqlDialect`, not in the connector.
 */
export interface ISqlDbPlugin extends IDbPlugin, ISqlExecutor {
  /** Runs `work` in a transaction; commit when it finishes, rollback if it throws. */
  transaction<T>(work: (tx: ISqlExecutor) => Promise<T>): Promise<T>;
}
