import type { ILogger, IRequestContext } from "@monolite/core";
import { SequelizeDbPlugin, SqlGenericRepository, sqlServerDialect } from "@monolite/data";
import type { EntityMetadata, IGenericRepository } from "@monolite/data";
import { readEnv, requireEnv, toInt } from "../../config/env";

/**
 * The persistence layer, for SQL Server.
 *
 * There is one of these files per engine and only the chosen one was generated.
 * The `DataSource` shape is identical in all of them, so switching engines
 * later is replacing this file — nothing in `application/` or `presentation/`
 * knows which database is underneath.
 *
 * SQL Server, PostgreSQL and MySQL share `SequelizeDbPlugin`: what actually
 * differs between them —quoting, pagination, how a generated key comes back—
 * lives in the dialect, not in the connector.
 */

/** What startup and shutdown need from a connection, whatever the engine. */
export interface ManagedConnection {
  authenticate(): Promise<void>;
  close(): Promise<void>;
}

export interface DataSource {
  /** The active driver, as the health endpoint reports it. */
  readonly driver: string;
  readonly connection?: ManagedConnection;
  /**
   * The generic repository for one entity. `seed` is ignored here: a real
   * engine gets its rows from a migration, not from the process that queries
   * them. The parameter exists so the in-memory driver is a drop-in swap.
   */
  repository<T extends object>(
    metadata: EntityMetadata<T>,
    seed?: Partial<T>[]
  ): IGenericRepository<T>;
}

export function createDataSource(logger: ILogger, context: IRequestContext): DataSource {
  const plugin = new SequelizeDbPlugin(
    {
      engine: "mssql",
      host: readEnv("DB_HOST", "__dbHost__"),
      port: toInt(readEnv("DB_PORT"), __dbPort__, 1),
      username: readEnv("DB_USER", "__dbUser__"),
      // No default, on purpose: a connection that silently falls back to an
      // empty password fails later and less clearly than one that refuses to
      // start.
      password: requireEnv("DB_PASSWORD"),
      database: readEnv("DB_NAME", "__dbName__"),
      poolMin: toInt(readEnv("DB_POOL_MIN"), 0),
      poolMax: toInt(readEnv("DB_POOL_MAX"), 10, 1),
    },
    logger
  );

  return {
    driver: "mssql",
    connection: plugin,
    repository: <T extends object>(metadata: EntityMetadata<T>) =>
      new SqlGenericRepository<T>(plugin, metadata, logger, sqlServerDialect, context),
  };
}
