import {
  buildMongoConfig,
  buildOracleConfig,
  buildSequelizeConfig,
  createPersistenceLayer,
  isOracleDriver,
  resolveDriver,
} from "monolite-di";
import {
  AUDIT_LOG_ENTITY,
  envsFrom,
  GADGET_ENTITY,
  silentLogger,
  WIDGET_ENTITY,
  type IWidget,
} from "./support/test-entity";

describe("resolveDriver", () => {
  it("accepts the spellings people actually write", () => {
    expect(resolveDriver("postgresql")).toBe("postgres");
    expect(resolveDriver("sqlserver")).toBe("mssql");
    expect(resolveDriver("mariadb")).toBe("mysql");
    expect(resolveDriver("mongo")).toBe("mongodb");
    expect(resolveDriver("dummy")).toBe("memory");
  });

  it("ignores case and surrounding space", () => {
    expect(resolveDriver("  Postgres ")).toBe("postgres");
  });

  it("treats nothing at all as the in-memory driver", () => {
    expect(resolveDriver(undefined)).toBe("memory");
    expect(resolveDriver("")).toBe("memory");
  });

  /**
   * The reason this validates instead of falling back: `DATA_SOURCE=postgress`
   * would otherwise start in memory, and the failure would surface much later
   * as data that does not persist.
   */
  it("refuses an unknown value, and lists the ones it knows", () => {
    expect(() => resolveDriver("postgress")).toThrow(/Unknown DATA_SOURCE "postgress"/);
    expect(() => resolveDriver("postgress")).toThrow(/memory, oracle/);
  });
});

describe("isOracleDriver", () => {
  it("recognises Oracle under either spelling and nothing else", () => {
    expect(isOracleDriver("oracle")).toBe(true);
    expect(isOracleDriver("postgres")).toBe(false);
    expect(isOracleDriver(undefined)).toBe(false);
  });
});

describe("buildOracleConfig", () => {
  it("reads the whole connection from the environment", () => {
    const config = buildOracleConfig(
      envsFrom({
        ORACLE_USER: "billing",
        ORACLE_PASSWORD: "s3cret",
        ORACLE_CONNECT_STRING: "db.internal:1521/PROD",
        ORACLE_POOL_MIN: "2",
        ORACLE_POOL_MAX: "40",
        ORACLE_POOL_INCREMENT: "5",
      })
    );

    expect(config).toEqual({
      user: "billing",
      password: "s3cret",
      connectString: "db.internal:1521/PROD",
      poolMin: 2,
      poolMax: 40,
      poolIncrement: 5,
    });
  });

  it("falls back to the settings the reference compose file publishes", () => {
    const config = buildOracleConfig(envsFrom({}));

    expect(config.user).toBe("appuser");
    expect(config.connectString).toBe("localhost:1521/FREEPDB1");
    expect(config.poolMin).toBe(1);
    expect(config.poolMax).toBe(10);
  });

  /**
   * The minimum is per parameter and not global: keeping no idle connection is
   * a real choice, a pool of zero connections is not.
   */
  it("accepts zero where zero means something, and rejects it where it does not", () => {
    const zeroed = buildOracleConfig(
      envsFrom({ ORACLE_POOL_MIN: "0", ORACLE_POOL_INCREMENT: "0", ORACLE_POOL_MAX: "0" })
    );

    expect(zeroed.poolMin).toBe(0);
    expect(zeroed.poolIncrement).toBe(0);
    expect(zeroed.poolMax).toBe(10);
  });

  it("falls back rather than propagating a value that is not a whole number", () => {
    expect(buildOracleConfig(envsFrom({ ORACLE_POOL_MAX: "ten" })).poolMax).toBe(10);
    expect(buildOracleConfig(envsFrom({ ORACLE_POOL_MAX: "10.5" })).poolMax).toBe(10);
  });
});

describe("buildSequelizeConfig", () => {
  /**
   * Each engine reads its own prefix so that several can stay configured at
   * once and switching between them is a change of `DATA_SOURCE` alone.
   */
  it("reads each engine from its own prefix", () => {
    const envs = envsFrom({
      POSTGRES_HOST: "pg.internal",
      POSTGRES_DB: "shop",
      MYSQL_HOST: "my.internal",
      MYSQL_DB: "legacy",
      DB_HOST: "sqlserver.internal",
      DB_NAME: "erp",
    });

    expect(buildSequelizeConfig(envs, "postgres")).toMatchObject({
      host: "pg.internal",
      database: "shop",
      port: 5433,
    });
    expect(buildSequelizeConfig(envs, "mysql")).toMatchObject({
      host: "my.internal",
      database: "legacy",
      port: 3307,
    });
    expect(buildSequelizeConfig(envs, "mssql")).toMatchObject({
      host: "sqlserver.internal",
      database: "erp",
      port: 1434,
    });
  });

  it("takes the database from either spelling of the variable", () => {
    expect(buildSequelizeConfig(envsFrom({ POSTGRES_DB: "first" }), "postgres").database).toBe(
      "first"
    );
    expect(buildSequelizeConfig(envsFrom({ POSTGRES_NAME: "second" }), "postgres").database).toBe(
      "second"
    );
  });

  it("carries the engine through, since the connector is shared", () => {
    expect(buildSequelizeConfig(envsFrom({}), "mysql").engine).toBe("mysql");
  });

  it("lets the pool shrink to nothing but not the ceiling", () => {
    const config = buildSequelizeConfig(
      envsFrom({ POSTGRES_POOL_MIN: "0", POSTGRES_POOL_MAX: "0" }),
      "postgres"
    );

    expect(config.poolMin).toBe(0);
    expect(config.poolMax).toBe(10);
  });
});

describe("buildMongoConfig", () => {
  it("reads the connection from the environment", () => {
    const config = buildMongoConfig(
      envsFrom({
        MONGO_HOST: "mongo.internal",
        MONGO_PORT: "27018",
        MONGO_DB: "events",
        MONGO_USER: "reader",
        MONGO_PASSWORD: "s3cret",
      })
    );

    expect(config).toEqual({
      host: "mongo.internal",
      port: 27018,
      database: "events",
      username: "reader",
      password: "s3cret",
    });
  });

  /**
   * The development container runs without authentication, and an empty user is
   * how the connector is told to leave the credentials out of the URI
   * altogether — which an empty string would not do.
   */
  it("leaves the credentials undefined rather than empty", () => {
    const config = buildMongoConfig(envsFrom({}));

    expect(config.username).toBeUndefined();
    expect(config.password).toBeUndefined();
    expect(config.host).toBe("localhost");
    expect(config.port).toBe(27017);
  });
});

describe("createPersistenceLayer, on the in-memory driver", () => {
  const logger = silentLogger();

  it("builds one store per entity, indexed by its name", () => {
    const layer = createPersistenceLayer({
      dataSource: "memory",
      logger,
      entities: [
        { name: "WIDGETS", metadata: WIDGET_ENTITY },
        { name: "GADGETS", metadata: GADGET_ENTITY },
      ],
    });

    expect([...layer.stores.keys()]).toEqual(["WIDGETS", "GADGETS"]);
    expect(layer.driver).toBe("memory");
  });

  it("hands a registered store back with the type the caller asks for", async () => {
    const layer = createPersistenceLayer({
      dataSource: "memory",
      logger,
      entities: [{ name: "WIDGETS", metadata: WIDGET_ENTITY, seed: [{ name: "seeded" }] }],
    });

    const widgets = layer.store<IWidget>("WIDGETS");
    await expect(widgets.count()).resolves.toBe(1);
  });

  it("says which entities it does know when asked for one it does not", () => {
    const layer = createPersistenceLayer({
      dataSource: "memory",
      logger,
      entities: [{ name: "WIDGETS", metadata: WIDGET_ENTITY }],
    });

    expect(() => layer.store("SPROCKETS")).toThrow(/"SPROCKETS" has no store/);
    expect(() => layer.store("SPROCKETS")).toThrow(/Registered: WIDGETS/);
  });

  /** The seed is the in-memory driver's alone; a real engine gets its rows from a migration. */
  it("starts the in-memory store on the rows it was seeded with", async () => {
    const layer = createPersistenceLayer({
      dataSource: "memory",
      logger,
      entities: [
        { name: "WIDGETS", metadata: WIDGET_ENTITY, seed: [{ name: "one" }, { name: "two" }] },
      ],
    });

    await expect(layer.store<IWidget>("WIDGETS").count()).resolves.toBe(2);
  });

  it("has no connection, because there is nothing to open or close", () => {
    const layer = createPersistenceLayer({ dataSource: "memory", logger, entities: [] });

    expect(layer.connection).toBeUndefined();
  });

  it("keeps the registrations it was built from, in order", () => {
    const entities = [
      { name: "WIDGETS", metadata: WIDGET_ENTITY },
      { name: "GADGETS", metadata: GADGET_ENTITY },
    ];
    const layer = createPersistenceLayer({ dataSource: "memory", logger, entities });

    expect(layer.entities).toEqual(entities);
  });

  it("builds no change log unless it was given the table for one", () => {
    const layer = createPersistenceLayer({ dataSource: "memory", logger, entities: [] });

    expect(layer.auditTrail).toBeUndefined();
    expect(layer.auditLogStore).toBeUndefined();
  });

  it("builds the change log and its store when it was", () => {
    const layer = createPersistenceLayer({
      dataSource: "memory",
      logger,
      entities: [{ name: "WIDGETS", metadata: WIDGET_ENTITY }],
      auditLog: AUDIT_LOG_ENTITY,
    });

    expect(layer.auditTrail).toBeDefined();
    expect(layer.auditLogStore).toBeDefined();
    // The log is not one of the application's entities: it is written by the
    // repositories, not read through the registry.
    expect([...layer.stores.keys()]).toEqual(["WIDGETS"]);
  });

  it("always exposes a unit of work, even with nothing registered", () => {
    expect(createPersistenceLayer({ dataSource: "memory", logger, entities: [] }).unitOfWork)
      .toBeDefined();
  });
});

describe("createPersistenceLayer, on an engine that needs connecting to", () => {
  /**
   * Failing here, before the connector exists, is what turns a missing
   * configuration into one readable line instead of a connection error at the
   * first query.
   */
  it("refuses to build with neither explicit settings nor a way to read them", () => {
    expect(() =>
      createPersistenceLayer({ dataSource: "postgres", logger: silentLogger(), entities: [] })
    ).toThrow(/The "postgres" driver needs connection settings/);
  });

  it("prefers the explicit settings over the environment", () => {
    const layer = createPersistenceLayer({
      dataSource: "postgres",
      logger: silentLogger(),
      entities: [],
      envs: envsFrom({ POSTGRES_HOST: "from-the-environment" }),
      sequelize: {
        engine: "postgres",
        host: "explicit",
        port: 5432,
        username: "app",
        password: "",
        database: "shop",
      },
    });

    // Nothing is connected here: building the layer only builds the connector,
    // and what is being checked is that it got as far as building one.
    expect(layer.driver).toBe("postgres");
    expect(layer.connection).toBeDefined();
  });

  it("builds the connection out of the environment when nothing is passed explicitly", () => {
    const layer = createPersistenceLayer({
      logger: silentLogger(),
      entities: [],
      envs: envsFrom({
        DATA_SOURCE: "postgres",
        POSTGRES_HOST: "pg.internal",
        POSTGRES_DB: "shop",
        POSTGRES_USER: "app",
      }),
    });

    expect(layer.driver).toBe("postgres");
    expect(layer.connection).toBeDefined();
  });

  it("takes the engine from DATA_SOURCE when the option does not name one", () => {
    const layer = createPersistenceLayer({
      logger: silentLogger(),
      entities: [],
      envs: envsFrom({ DATA_SOURCE: "mongo", MONGO_DB: "events" }),
    });

    expect(layer.driver).toBe("mongodb");
  });
});

/**
 * The claim the whole package rests on: the same registration produces the same
 * shape on every engine, and only the classes underneath differ. Nothing here
 * connects — building the layer builds the connector and the repositories, and
 * a query is what would need a database.
 */
describe("createPersistenceLayer, across the engines", () => {
  const sequelize = {
    host: "localhost",
    port: 5432,
    username: "app",
    password: "",
    database: "shop",
  };

  const CONFIGS = [
    { driver: "oracle", options: { oracle: buildOracleConfig(envsFrom({})) } },
    { driver: "postgres", options: { sequelize: { ...sequelize, engine: "postgres" as const } } },
    { driver: "mysql", options: { sequelize: { ...sequelize, engine: "mysql" as const } } },
    { driver: "mssql", options: { sequelize: { ...sequelize, engine: "mssql" as const } } },
    { driver: "mongodb", options: { mongo: buildMongoConfig(envsFrom({})) } },
    { driver: "memory", options: {} },
  ];

  it.each(CONFIGS)("assembles the same layer on $driver", ({ driver, options }) => {
    const layer = createPersistenceLayer({
      dataSource: driver,
      logger: silentLogger(),
      entities: [{ name: "WIDGETS", metadata: WIDGET_ENTITY, seed: [{ name: "seeded" }] }],
      auditLog: AUDIT_LOG_ENTITY,
      ...options,
    });

    expect(layer.driver).toBe(driver);
    expect(layer.store<IWidget>("WIDGETS")).toBeDefined();
    expect(layer.unitOfWork).toBeDefined();
    expect(layer.auditTrail).toBeDefined();
    expect(layer.auditLogStore).toBeDefined();
    // Everything but memory owns a pool the process has to open and close.
    expect(layer.connection === undefined).toBe(driver === "memory");
  });
});
