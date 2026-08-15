import type { ILogger, IRequestContext } from "@monolite/core";
import { MongoDbPlugin, MongoGenericRepository } from "@monolite/data";
import type { EntityMetadata, IGenericRepository } from "@monolite/data";
import { readEnv, toInt } from "../../config/env";

/**
 * The persistence layer, for MongoDB.
 *
 * There is one of these files per engine and only the chosen one was generated.
 * The `DataSource` shape is identical in all of them, so switching engines
 * later is replacing this file — nothing in `application/` or `presentation/`
 * knows which database is underneath.
 *
 * MongoDB does not share the SQL repository —there are no statements to
 * generate— but it does implement the same contract, so from the service layer
 * upwards nothing can tell the difference.
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
   * engine gets its documents from a migration, not from the process that
   * queries them. The parameter exists so the in-memory driver is a drop-in swap.
   */
  repository<T extends object>(
    metadata: EntityMetadata<T>,
    seed?: Partial<T>[]
  ): IGenericRepository<T>;
}

export function createDataSource(logger: ILogger, context: IRequestContext): DataSource {
  const plugin = new MongoDbPlugin(
    {
      host: readEnv("MONGO_HOST", "__dbHost__"),
      port: toInt(readEnv("MONGO_PORT"), __dbPort__, 1),
      database: readEnv("MONGO_DB", "__dbName__"),
      // Left undefined rather than empty when unset: the development container
      // runs without authentication, and that is the way to tell the connector
      // not to send credentials at all.
      username: readEnv("MONGO_USER") || undefined,
      password: readEnv("MONGO_PASSWORD") || undefined,
    },
    logger
  );

  return {
    driver: "mongodb",
    connection: plugin,
    repository: <T extends object>(metadata: EntityMetadata<T>) =>
      new MongoGenericRepository<T>(plugin, metadata, logger, context),
  };
}
