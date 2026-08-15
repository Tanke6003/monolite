import type { ILogger, IRequestContext } from "@monolite/core";
import { oracleDialect, OraclePlugin, SqlGenericRepository } from "@monolite/data";
import type { EntityMetadata, IGenericRepository } from "@monolite/data";
import { readEnv, requireEnv, toInt } from "../../config/env";

/**
 * The persistence layer, for Oracle.
 *
 * There is one of these files per engine and only the chosen one was generated.
 * The `DataSource` shape is identical in all of them, so switching engines
 * later is replacing this file — nothing in `application/` or `presentation/`
 * knows which database is underneath.
 *
 * Oracle is the one engine with its own connector rather than Sequelize: the
 * driver has a real session pool and returns generated keys its own way, and
 * `OraclePlugin` is what wraps both.
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
  const plugin = new OraclePlugin(
    {
      user: readEnv("ORACLE_USER", "__dbUser__"),
      // No default, on purpose: a connection that silently falls back to an
      // empty password fails later and less clearly than one that refuses to
      // start.
      password: requireEnv("ORACLE_PASSWORD"),
      // Easy Connect descriptor: host:port/service.
      connectString: readEnv("ORACLE_CONNECT_STRING", "__oracleConnectString__"),
      // 0 is a valid minimum: it means keeping no idle session open.
      poolMin: toInt(readEnv("ORACLE_POOL_MIN"), 1),
      poolMax: toInt(readEnv("ORACLE_POOL_MAX"), 10, 1),
      poolIncrement: toInt(readEnv("ORACLE_POOL_INCREMENT"), 1),
    },
    logger
  );

  return {
    driver: "oracle",
    connection: plugin,
    repository: <T extends object>(metadata: EntityMetadata<T>) =>
      new SqlGenericRepository<T>(plugin, metadata, logger, oracleDialect, context),
  };
}
