import type { ILogger, IRequestContext } from "@monolite/core";
import { MemoryGenericRepository } from "@monolite/data";
import type { EntityMetadata, IGenericRepository } from "@monolite/data";

/**
 * The persistence layer, for the in-memory driver.
 *
 * There is one of these files per engine and only the chosen one was generated.
 * That is deliberate: a single file with a switch over five engines carries the
 * connection code of four databases this project will never open, and the
 * `DataSource` shape below is the same in all of them, so moving to a real
 * engine is replacing this file — not rewriting the modules that use it.
 */

/** What startup and shutdown need from a connection, whatever the engine. */
export interface ManagedConnection {
  authenticate(): Promise<void>;
  close(): Promise<void>;
}

export interface DataSource {
  /** The active driver, as the health endpoint reports it. */
  readonly driver: string;
  /** Absent in memory: there is nothing to open and nothing to close. */
  readonly connection?: ManagedConnection;
  /**
   * The generic repository for one entity. `seed` is only honoured by the
   * in-memory driver — a real engine gets its rows from a migration, not from
   * the process that queries them.
   */
  repository<T extends object>(
    metadata: EntityMetadata<T>,
    seed?: Partial<T>[]
  ): IGenericRepository<T>;
}

export function createDataSource(_logger: ILogger, context: IRequestContext): DataSource {
  return {
    driver: "memory",
    repository: <T extends object>(metadata: EntityMetadata<T>, seed: Partial<T>[] = []) =>
      new MemoryGenericRepository<T>(metadata, seed, context),
  };
}
