/**
 * The optional peer dependencies, and whether they are actually optional.
 *
 * They are declared optional so that a project on PostgreSQL installs `pg` and
 * `sequelize` and nothing else. For a long time that was only a declaration:
 * every connector imported its driver at the top of the file, so importing
 * `@monolite/data` at all pulled in Oracle's driver, MongoDB's and Sequelize's,
 * and a generated project refused to start with `Cannot find module 'oracledb'`
 * before a single line of its own code ran — on the in-memory driver.
 *
 * Each driver here is doubled by a module that throws the way Node does when a
 * package is not installed. So if anything reintroduces a static import, these
 * fail immediately rather than at somebody's `npm start`.
 */

function notInstalled(name: string): never {
  const error: NodeJS.ErrnoException = new Error(`Cannot find module '${name}'`);
  error.code = "MODULE_NOT_FOUND";
  throw error;
}

jest.mock("oracledb", () => notInstalled("oracledb"));
jest.mock("mongodb", () => notInstalled("mongodb"));
jest.mock("sequelize", () => notInstalled("sequelize"));

const logger = {
  log: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
} as never;

describe("importing the package", () => {
  it("loads none of the drivers", () => {
    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@monolite/data");
      });
    }).not.toThrow();
  });

  it("still exposes every connector, driver or no driver", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const data = require("@monolite/data") as typeof import("@monolite/data");

    expect(typeof data.OracleConnector).toBe("function");
    expect(typeof data.MongoConnector).toBe("function");
    expect(typeof data.SequelizeConnector).toBe("function");
  });
});

describe("using an engine whose driver is missing", () => {
  /**
   * `Cannot find module 'oracledb'`, thrown from inside a package the
   * application never mentioned, tells the reader nothing. The replacement has
   * to name the engine that asked, the package to install and the way out.
   */
  it("says what to install, for Oracle", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OracleConnector } = require("@monolite/data") as typeof import("@monolite/data");

    // Constructing is fine: nothing is needed until the pool is opened.
    const connector = new OracleConnector(
      { user: "app", password: "", connectString: "localhost:1521/FREEPDB1" },
      logger
    );

    await expect(connector.authenticate()).rejects.toThrow(
      /The Oracle connector needs "oracledb".*npm install oracledb/s
    );
  });

  it("says what to install, for MongoDB", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MongoConnector } = require("@monolite/data") as typeof import("@monolite/data");

    const connector = new MongoConnector(
      { host: "localhost", port: 27017, database: "testdb" },
      logger
    );

    await expect(connector.authenticate()).rejects.toThrow(
      /The MongoDB connector needs "mongodb".*npm install mongodb/s
    );
  });

  /**
   * Sequelize is the exception: its connector builds the instance in its own
   * constructor, so this is where the driver is first needed.
   */
  it("says what to install, for the engines Sequelize speaks", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SequelizeConnector } = require("@monolite/data") as typeof import("@monolite/data");

    expect(
      () =>
        new SequelizeConnector(
          {
            engine: "postgres",
            host: "localhost",
            port: 5432,
            username: "app",
            password: "",
            database: "shop",
          },
          logger
        )
    ).toThrow(/needs "sequelize".*npm install sequelize/s);
  });
});

describe("a driver that is installed but broken", () => {
  /**
   * A native build that failed, or a driver whose own dependency is missing,
   * also reports `MODULE_NOT_FOUND`. Answering that with "install mongodb"
   * would send somebody to reinstall a package that is already there, so the
   * original error has to come through untouched.
   */
  it("reports its own failure rather than a missing package", () => {
    jest.isolateModules(() => {
      jest.doMock("mongodb", () => {
        throw new Error("libcrypto.so.1.1: cannot open shared object file");
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MongoConnector } = require("@monolite/data") as typeof import("@monolite/data");
      const connector = new MongoConnector(
        { host: "localhost", port: 27017, database: "testdb" },
        logger
      );

      void expect(connector.authenticate()).rejects.toThrow(/libcrypto/);
    });
  });
});
