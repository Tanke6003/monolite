import type { ILogger, IRequestContext } from "monolite-core";
import {
  MemoryAuditTrail,
  MemoryGenericRepository,
  MemoryUnitOfWork,
  MongoAuditTrail,
  MongoConnector,
  MongoGenericRepository,
  MongoUnitOfWork,
  OracleConnector,
  SequelizeConnector,
  SqlAuditTrail,
  SqlGenericRepository,
  SqlUnitOfWork,
  mysqlDialect,
  oracleDialect,
  postgresDialect,
  sqlServerDialect,
} from "monolite-data";
import type {
  DbEngine,
  EntityMetadata,
  IAuditLog,
  IAuditTrail,
  IGenericRepository,
  ITransactionContext,
  IUnitOfWork,
  MongoConnectionConfig,
  OracleConnectionConfig,
  SequelizeConnectionConfig,
  SequelizeEngine,
  SqlDialect,
} from "monolite-data";
import type { IManagedConnection } from "./container.js";
import type { IEnvs } from "./env.js";

/** Persistence driver resolved from `DATA_SOURCE`. */
export type PersistenceDriver = DbEngine;

/**
 * A repository whose entity type is not known at this point.
 *
 * The persistence layer holds entities of different shapes in the same map, so
 * the type parameter is erased here and given back where it can be checked:
 * `PersistenceLayer.store<T>()` returns the concrete type the caller asks for.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGenericRepository = IGenericRepository<any, any>;

/**
 * One entity the persistence layer has to build a repository for.
 *
 * This is where the port generalises its original: there the entities of the
 * sample application were named inside the factory, so adding a table meant
 * editing it. Here the caller passes them in and the factory is the same code
 * for any set of entities — which is the whole point, because the factory is
 * also the only place that knows which engine is running.
 */
export interface EntityRegistration<T extends object> {
  /**
   * Logical entity name. It is the key the unit of work indexes by —the string
   * a service passes to `scope.repository(name)`— so it has to be the same one
   * the application uses in its own entity-name table.
   */
  name: string;

  /** Entity <-> table mapping. The only place column names are spelled out. */
  metadata: EntityMetadata<T>;

  /**
   * Rows loaded when the in-memory driver starts, so the application looks the
   * same with or without a database up. Every other engine ignores them: their
   * seed lives in the database itself.
   */
  seed?: Partial<T>[];

  /**
   * Container token for this entity's store. Defaults to the convention in
   * `storeToken` and exists so an application can keep the exact spelling its
   * feature modules already inject.
   */
  token?: string;
}

/** An entity registration whatever its model type; see `AnyGenericRepository`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEntityRegistration = EntityRegistration<any>;

/**
 * The persistence layer already built: the generic repository of every entity,
 * the unit of work, the change log and —when the driver has one— the
 * connection.
 */
export interface PersistenceLayer {
  driver: PersistenceDriver;

  /**
   * Generic repositories indexed by logical entity name. Heterogeneous by
   * nature: use `store<T>()` to get one back with its type.
   */
  stores: ReadonlyMap<string, AnyGenericRepository>;

  /** The repository of an entity, typed. Throws if the entity was not registered. */
  store<T extends object, TKey = number>(name: string): IGenericRepository<T, TKey>;

  unitOfWork: IUnitOfWork;

  /** Change log fed by the repositories. Absent when no log entity was given. */
  auditTrail?: IAuditTrail;

  /** Read-only from the application: it is written by the repositories. */
  auditLogStore?: IGenericRepository<IAuditLog>;

  /** Absent in memory: there is nothing to open and nothing to close. */
  connection?: IManagedConnection;

  /** The registrations the layer was built from, in the order they were given. */
  entities: readonly AnyEntityRegistration[];
}

/**
 * Aliases accepted in `DATA_SOURCE`. The value is validated against this table
 * instead of falling back to memory on an unknown one: a misspelled
 * `DATA_SOURCE=postgress` would start in memory and the failure would surface
 * much later, as data that does not persist.
 */
const DRIVER_ALIASES: Record<string, PersistenceDriver> = {
  dummy: "memory",
  memory: "memory",
  oracle: "oracle",
  sqlserver: "mssql",
  mssql: "mssql",
  postgres: "postgres",
  postgresql: "postgres",
  mysql: "mysql",
  mariadb: "mysql",
  mongodb: "mongodb",
  mongo: "mongodb",
};

export function resolveDriver(dataSource?: string): PersistenceDriver {
  const value = (dataSource || "dummy").trim().toLowerCase();
  const driver = DRIVER_ALIASES[value];

  if (!driver) {
    throw new Error(
      `[config] Unknown DATA_SOURCE "${dataSource}". Valid values: ` +
        `${Object.keys(DRIVER_ALIASES).join(", ")}.`
    );
  }

  return driver;
}

/**
 * The variables an engine cannot be reached without, by driver.
 *
 * Only the ones with no honest default. Hosts, ports, users and database names
 * all default to the values in the compose file this repository ships, so a
 * developer who has just run `docker compose up` needs none of them; a password
 * cannot have a default, because any default it had would be one that works.
 *
 * The table lives here, beside the functions that read those very variables,
 * for the reason such tables usually drift: an engine added in one place and
 * forgotten in the other is a project that starts with no credentials and
 * fails, much later, as a connection error nobody can place.
 */
const REQUIRED_ENV: Record<PersistenceDriver, string[]> = {
  memory: [],
  oracle: ["ORACLE_PASSWORD"],
  // SQL Server reads the unprefixed `DB_*` set; the others use their own name.
  mssql: ["DB_PASSWORD"],
  postgres: ["POSTGRES_PASSWORD"],
  mysql: ["MYSQL_PASSWORD"],
  // MongoDB is the exception and it is deliberate: its development container
  // runs with authentication off, so demanding a password would stop the normal
  // local setup from starting at all. What is checked instead is the halfway
  // state — a user with no password — because that one is always a mistake.
  mongodb: [],
};

/**
 * Which of them are missing for the configured engine. Empty means the process
 * has what it needs to connect.
 *
 * A variable set to an empty string counts as missing: `MYSQL_PASSWORD=` in a
 * `.env` is a line somebody meant to fill in.
 */
export function missingDataSourceEnv(envs: IEnvs, dataSource?: string): string[] {
  const driver = resolveDriver(dataSource ?? envs.getEnv("DATA_SOURCE"));

  const missing = REQUIRED_ENV[driver].filter((name) => envs.getEnv(name).trim() === "");

  if (driver === "mongodb" && envs.getEnv("MONGO_USER").trim() !== "") {
    if (envs.getEnv("MONGO_PASSWORD").trim() === "") missing.push("MONGO_PASSWORD");
  }

  return missing;
}

/**
 * The same check, as a start-up assertion. Hand it to `registerPlugins`'s
 * `validate` and a misconfigured deployment stops in the boot log, with the
 * names in it, instead of at whichever request first touches the database.
 */
export function validateDataSourceEnv(envs: IEnvs, dataSource?: string): void {
  const missing = missingDataSourceEnv(envs, dataSource);
  if (missing.length === 0) return;

  const driver = resolveDriver(dataSource ?? envs.getEnv("DATA_SOURCE"));

  throw new Error(
    `[config] DATA_SOURCE=${driver} needs ${missing.join(", ")}, and ` +
      `${missing.length === 1 ? "it is" : "they are"} not set. ` +
      "Refusing to start rather than failing at the first query."
  );
}

export function isOracleDriver(dataSource?: string): boolean {
  return resolveDriver(dataSource) === "oracle";
}

/**
 * A configuration integer together with its lowest acceptable value.
 *
 * The minimum is per parameter rather than a single global one: `poolMin` and
 * `poolIncrement` accept 0 —no idle connections, a pool that does not grow—
 * whereas a `poolMax` or a port of 0 mean nothing at all. A value out of range
 * falls back to the default instead of propagating a NaN.
 */
const toInt = (value: string, fallback: number, min = 1): number => {
  // `Number("")` is 0, so without this early exit an undefined variable would
  // read as a zero somebody configured on purpose.
  if (value.trim() === "") return fallback;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
};

/** Oracle configuration, with defaults aligned with the reference compose file. */
export function buildOracleConfig(envs: IEnvs): OracleConnectionConfig {
  return {
    user: envs.getEnv("ORACLE_USER") || "appuser",
    password: envs.getEnv("ORACLE_PASSWORD"),
    connectString: envs.getEnv("ORACLE_CONNECT_STRING") || "localhost:1521/FREEPDB1",
    // 0 is valid: it means keeping no idle connection at all.
    poolMin: toInt(envs.getEnv("ORACLE_POOL_MIN"), 1, 0),
    poolMax: toInt(envs.getEnv("ORACLE_POOL_MAX"), 10),
    poolIncrement: toInt(envs.getEnv("ORACLE_POOL_INCREMENT"), 1, 0),
  };
}

/**
 * Defaults for each engine Sequelize speaks, aligned with the reference compose
 * file. Each one reads its own variable prefix so several can be configured at
 * the same time and switching between them is a change of `DATA_SOURCE`.
 */
const SEQUELIZE_DEFAULTS: Record<
  SequelizeEngine,
  { prefix: string; port: number; user: string; database: string }
> = {
  mssql: { prefix: "DB", port: 1434, user: "sa", database: "testdb" },
  postgres: { prefix: "POSTGRES", port: 5433, user: "appuser", database: "testdb" },
  mysql: { prefix: "MYSQL", port: 3307, user: "appuser", database: "testdb" },
};

export function buildSequelizeConfig(
  envs: IEnvs,
  engine: SequelizeEngine
): SequelizeConnectionConfig {
  const { prefix, port, user, database } = SEQUELIZE_DEFAULTS[engine];
  const read = (suffix: string) => envs.getEnv(`${prefix}_${suffix}`);

  return {
    engine,
    host: read("HOST") || "localhost",
    port: toInt(read("PORT"), port),
    username: read("USER") || user,
    password: read("PASSWORD"),
    // SQL Server uses DB_NAME; the others, the usual name of their image.
    database: read("DB") || read("NAME") || database,
    poolMin: toInt(read("POOL_MIN"), 0, 0),
    poolMax: toInt(read("POOL_MAX"), 10),
  };
}

/**
 * MongoDB configuration, with defaults aligned with the reference compose file.
 * User and password stay empty when they are not defined: the development
 * container runs without authentication, and an empty user is how the connector
 * is told not to write credentials into the URI.
 */
export function buildMongoConfig(envs: IEnvs): MongoConnectionConfig {
  return {
    host: envs.getEnv("MONGO_HOST") || "localhost",
    port: toInt(envs.getEnv("MONGO_PORT"), 27017),
    database: envs.getEnv("MONGO_DB") || "testdb",
    username: envs.getEnv("MONGO_USER") || undefined,
    password: envs.getEnv("MONGO_PASSWORD") || undefined,
  };
}

/** Dialect of each engine Sequelize speaks. */
const SEQUELIZE_DIALECTS: Record<SequelizeEngine, SqlDialect> = {
  mssql: sqlServerDialect,
  postgres: postgresDialect,
  mysql: mysqlDialect,
};

/** What is needed to build the persistence layer, whichever engine it runs on. */
export interface PersistenceOptions {
  /** The entities to build a repository for. */
  entities: readonly AnyEntityRegistration[];

  logger: ILogger;

  /**
   * Where `DATA_SOURCE` and the connection settings are read from. Optional:
   * an application that configures the engine explicitly does not need it.
   */
  envs?: IEnvs;

  /** Engine to use, overriding `DATA_SOURCE`. Accepts any alias of the table above. */
  dataSource?: string;

  /**
   * Mapping of the change-log entity. Without it the layer is built with no
   * change log: nothing is recorded and `auditTrail` comes back undefined.
   */
  auditLog?: EntityMetadata<IAuditLog>;

  /** Provides the user of the audit columns. */
  context?: IRequestContext;

  /** Publishes the open transaction so the repositories can join it. */
  transactions?: ITransactionContext;

  /** Explicit Oracle settings; replaces the ones read from the environment. */
  oracle?: OracleConnectionConfig;

  /** Explicit settings for the engine Sequelize speaks; same idea. */
  sequelize?: SequelizeConnectionConfig;

  /** Explicit MongoDB settings; same idea. */
  mongo?: MongoConnectionConfig;
}

/**
 * Builds a repository for one entity on the active engine. The seed only means
 * something in memory; the SQL and document drivers ignore it.
 */
type StoreFactory = <T extends object>(
  metadata: EntityMetadata<T>,
  seed: Partial<T>[] | undefined,
  auditTrail: IAuditTrail | undefined
) => IGenericRepository<T>;

interface Assembly {
  driver: PersistenceDriver;
  entities: readonly AnyEntityRegistration[];
  auditLog?: EntityMetadata<IAuditLog>;
  create: StoreFactory;
  /** Wraps the change-log store in the trail this engine understands. */
  trail: (store: IGenericRepository<IAuditLog>) => IAuditTrail;
  /** Builds the unit of work over the registry of repositories. */
  unitOfWork: (stores: ReadonlyMap<string, AnyGenericRepository>) => IUnitOfWork;
  connection?: IManagedConnection;
}

function storeOf<T extends object, TKey>(
  stores: ReadonlyMap<string, AnyGenericRepository>,
  name: string
): IGenericRepository<T, TKey> {
  const store = stores.get(name);

  if (!store) {
    throw new Error(
      `[persistence] Entity "${name}" has no store in the persistence layer. ` +
        `Registered: ${[...stores.keys()].join(", ")}.`
    );
  }

  return store as IGenericRepository<T, TKey>;
}

/**
 * The registry the unit of work indexes by entity name.
 *
 * It is heterogeneous by nature —repositories of different entities— and each
 * driver's unit of work asks for its own repository class, because inside a
 * transaction it has to rebind them to the open scope. That is knowledge the
 * registry cannot express, so the cast happens here, in one place.
 */
function registryOf<R>(stores: ReadonlyMap<string, AnyGenericRepository>): Map<string, R> {
  return new Map([...stores].map(([name, store]) => [name, store as unknown as R]));
}

/**
 * Mounts the entities and the unit of work on an engine. Everything that
 * changes between engines arrives as a callback, so this is literally the same
 * assembly for all six: build the log, build every store over it, index them
 * and hand the unit of work the index.
 */
function assemble(assembly: Assembly): PersistenceLayer {
  // The change log is built first and with no log of its own: recording itself
  // would be recursive.
  const auditLogStore = assembly.auditLog
    ? assembly.create<IAuditLog>(assembly.auditLog, undefined, undefined)
    : undefined;
  const auditTrail = auditLogStore ? assembly.trail(auditLogStore) : undefined;

  const stores = new Map<string, AnyGenericRepository>();
  for (const entity of assembly.entities) {
    stores.set(entity.name, assembly.create(entity.metadata, entity.seed, auditTrail));
  }

  return {
    driver: assembly.driver,
    stores,
    store<T extends object, TKey = number>(name: string): IGenericRepository<T, TKey> {
      return storeOf<T, TKey>(stores, name);
    },
    unitOfWork: assembly.unitOfWork(stores),
    auditTrail,
    auditLogStore,
    connection: assembly.connection,
    entities: assembly.entities,
  };
}

/**
 * Settings for the chosen engine: whatever the caller passed explicitly, or
 * whatever comes out of the environment. Failing here, before the connector is
 * built, is what turns a missing configuration into one readable line instead
 * of a connection error at the first query.
 */
function configFor<C>(
  driver: PersistenceDriver,
  explicit: C | undefined,
  envs: IEnvs | undefined,
  build: (envs: IEnvs) => C
): C {
  if (explicit) return explicit;
  if (envs) return build(envs);

  throw new Error(
    `[config] The "${driver}" driver needs connection settings: pass them explicitly ` +
      "or give the factory an environment reader."
  );
}

/**
 * Builds the persistence layer for the configured engine.
 *
 * - `oracle`: generic repositories over the Oracle pool, real transactions.
 * - `sqlserver` / `postgres` / `mysql`: the same repositories over Sequelize.
 * - `mongodb`: document repositories, with transactions over the replica set.
 * - `dummy`: in-memory repositories with the same sample data, so development
 *   and the test suite run without bringing any container up.
 *
 * In every case the services receive exactly the same interface, which is what
 * makes swapping engines a change of configuration rather than a change of
 * code.
 */
export function createPersistenceLayer(options: PersistenceOptions): PersistenceLayer {
  const { entities, logger, envs, auditLog, context, transactions } = options;
  const driver = resolveDriver(options.dataSource ?? envs?.getEnv("DATA_SOURCE"));

  if (driver === "oracle") {
    const oracle = new OracleConnector(
      configFor(driver, options.oracle, envs, buildOracleConfig),
      logger
    );

    return assemble({
      driver,
      entities,
      auditLog,
      create: (metadata, _seed, trail) =>
        new SqlGenericRepository(oracle, metadata, logger, oracleDialect, context, trail),
      trail: (store) => new SqlAuditTrail(store as SqlGenericRepository<IAuditLog>),
      unitOfWork: (stores) =>
        new SqlUnitOfWork(
          oracle,
          registryOf<SqlGenericRepository<never, never>>(stores),
          transactions
        ),
      connection: oracle,
    });
  }

  // The three engines Sequelize speaks share a connector: what differs between
  // them lives in the dialect, not in the plugin.
  if (driver === "mssql" || driver === "postgres" || driver === "mysql") {
    const plugin = new SequelizeConnector(
      configFor(driver, options.sequelize, envs, (source) =>
        buildSequelizeConfig(source, driver)
      ),
      logger
    );
    const dialect = SEQUELIZE_DIALECTS[driver];

    return assemble({
      driver,
      entities,
      auditLog,
      create: (metadata, _seed, trail) =>
        new SqlGenericRepository(plugin, metadata, logger, dialect, context, trail),
      trail: (store) => new SqlAuditTrail(store as SqlGenericRepository<IAuditLog>),
      unitOfWork: (stores) =>
        new SqlUnitOfWork(
          plugin,
          registryOf<SqlGenericRepository<never, never>>(stores),
          transactions
        ),
      connection: plugin,
    });
  }

  // MongoDB does not share the repository of the four SQL engines —there are no
  // statements to generate— but it does share the contract, so from here on
  // everything is assembled in exactly the same way.
  if (driver === "mongodb") {
    const mongo = new MongoConnector(
      configFor(driver, options.mongo, envs, buildMongoConfig),
      logger
    );

    return assemble({
      driver,
      entities,
      auditLog,
      create: (metadata, _seed, trail) =>
        new MongoGenericRepository(mongo, metadata, logger, context, trail),
      trail: (store) => new MongoAuditTrail(store as MongoGenericRepository<IAuditLog>),
      unitOfWork: (stores) =>
        new MongoUnitOfWork(
          mongo,
          registryOf<MongoGenericRepository<never, never>>(stores),
          transactions
        ),
      connection: mongo,
    });
  }

  // In memory there is no connection: nothing to open, nothing to close, and
  // that is why `connection` is optional in the layer.
  return assemble({
    driver,
    entities,
    auditLog,
    create: (metadata, seed, trail) =>
      new MemoryGenericRepository(metadata, seed ?? [], context, trail),
    trail: (store) => new MemoryAuditTrail(store),
    unitOfWork: (stores) =>
      new MemoryUnitOfWork(
        registryOf<MemoryGenericRepository<never, never>>(stores),
        transactions
      ),
  });
}
