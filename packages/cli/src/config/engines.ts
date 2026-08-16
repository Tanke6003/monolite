/**
 * Everything that changes in a generated project when the engine changes, in
 * one table.
 *
 * The alternative —an `if (engine === "postgres")` in the docker template, one
 * in the dependency list, one in the `.env` writer— is how a generator ends up
 * shipping a compose file for MySQL next to a Postgres connection string. Here
 * a new engine is a new row plus a directory under `templates/db/`.
 */

export type DatabaseFamily = "sql" | "nosql" | "none";

export type EngineId = "oracle" | "mssql" | "postgres" | "mysql" | "mongodb" | "memory";

export interface EngineSpec {
  id: EngineId;
  /** What the prompt shows and what the README calls it. */
  label: string;
  family: DatabaseFamily;
  /** Value written into `DATA_SOURCE`; `monolite-data` resolves the driver from it. */
  dataSource: string;
  /** Port on the host. Matches what the generated compose file publishes. */
  defaultPort: number;
  /** Port the server listens on inside its container. */
  containerPort: number;
  defaultUser: string;
  defaultDatabase: string;
  /**
   * Prefix of the environment variables its connector reads. SQL Server keeps
   * the historical `DB_` prefix; every other engine is named after itself, so
   * several can stay configured at once and `DATA_SOURCE` switches between them.
   */
  envPrefix: string;
  /** Runtime driver packages. Only the chosen engine's land in package.json. */
  dependencies: Record<string, string>;
  /** Type packages for the drivers that do not bundle their own. */
  devDependencies: Record<string, string>;
  /** Directory under `templates/db/`. Absent for in-memory: nothing to add. */
  templateDir?: string;
}

/**
 * Versions are pinned to the same ranges the reference project runs against, so
 * a scaffolded project starts on a combination that is known to work rather
 * than on whatever `latest` happens to be on the day it was generated.
 */
const SEQUELIZE = "^6.37.7";

export const ENGINES: Record<EngineId, EngineSpec> = {
  memory: {
    id: "memory",
    label: "None (in-memory)",
    family: "none",
    dataSource: "memory",
    defaultPort: 0,
    containerPort: 0,
    defaultUser: "",
    defaultDatabase: "",
    envPrefix: "",
    dependencies: {},
    devDependencies: {},
  },
  oracle: {
    id: "oracle",
    label: "Oracle",
    family: "sql",
    dataSource: "oracle",
    defaultPort: 1521,
    containerPort: 1521,
    defaultUser: "appuser",
    defaultDatabase: "FREEPDB1",
    envPrefix: "ORACLE",
    dependencies: { oracledb: "^7.0.1" },
    devDependencies: { "@types/oracledb": "^7.0.2" },
    templateDir: "oracle",
  },
  mssql: {
    id: "mssql",
    label: "SQL Server",
    family: "sql",
    dataSource: "sqlserver",
    defaultPort: 1434,
    containerPort: 1433,
    defaultUser: "sa",
    defaultDatabase: "appdb",
    envPrefix: "DB",
    dependencies: { sequelize: SEQUELIZE, tedious: "^18.6.1" },
    devDependencies: {},
    templateDir: "mssql",
  },
  postgres: {
    id: "postgres",
    label: "PostgreSQL",
    family: "sql",
    dataSource: "postgres",
    defaultPort: 5433,
    containerPort: 5432,
    defaultUser: "appuser",
    defaultDatabase: "appdb",
    envPrefix: "POSTGRES",
    dependencies: { pg: "^8.23.0", sequelize: SEQUELIZE },
    devDependencies: { "@types/pg": "^8.21.0" },
    templateDir: "postgres",
  },
  mysql: {
    id: "mysql",
    label: "MySQL",
    family: "sql",
    dataSource: "mysql",
    defaultPort: 3307,
    containerPort: 3306,
    defaultUser: "appuser",
    defaultDatabase: "appdb",
    envPrefix: "MYSQL",
    dependencies: { mysql2: "^3.23.3", sequelize: SEQUELIZE },
    devDependencies: {},
    templateDir: "mysql",
  },
  mongodb: {
    id: "mongodb",
    label: "MongoDB",
    family: "nosql",
    dataSource: "mongodb",
    defaultPort: 27017,
    containerPort: 27017,
    defaultUser: "",
    defaultDatabase: "appdb",
    envPrefix: "MONGO",
    dependencies: { mongodb: "^7.5.0" },
    devDependencies: {},
    templateDir: "mongo",
  },
};

/**
 * What `--database=` accepts. The spellings people actually type are all here
 * because rejecting `postgresql` teaches nothing and costs a re-run.
 */
const ALIASES: Record<string, EngineId> = {
  none: "memory",
  memory: "memory",
  "in-memory": "memory",
  inmemory: "memory",
  dummy: "memory",
  oracle: "oracle",
  oracledb: "oracle",
  sqlserver: "mssql",
  "sql-server": "mssql",
  mssql: "mssql",
  postgres: "postgres",
  postgresql: "postgres",
  pg: "postgres",
  mysql: "mysql",
  mariadb: "mysql",
  mongo: "mongodb",
  mongodb: "mongodb",
};

export function resolveEngine(raw: string): EngineSpec | null {
  const id = ALIASES[raw.trim().toLowerCase()];
  return id ? ENGINES[id] : null;
}

export function engineAliases(): string[] {
  return Object.keys(ALIASES);
}

export function enginesOfFamily(family: DatabaseFamily): EngineSpec[] {
  return Object.values(ENGINES).filter((engine) => engine.family === family);
}
