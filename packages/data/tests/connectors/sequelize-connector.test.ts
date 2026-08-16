// The connector for SQL Server, PostgreSQL and MySQL: three of the six engines
// depend on it.
//
// Sequelize is doubled, so no database is needed. What is checked is exactly
// what this connector decides and cannot be seen from above: how it asks each
// engine for the affected rows and the generated id, which is where they differ.
import type { ILogger } from "@monolite/core";

/** Sequelize instance returned by the doubled constructor. */
const sequelize = {
  query: jest.fn(),
  authenticate: jest.fn(),
  close: jest.fn(),
  transaction: jest.fn(),
};

jest.mock("sequelize", () => ({
  Sequelize: jest.fn(() => sequelize),
  QueryTypes: { SELECT: "SELECT", INSERT: "INSERT", BULKUPDATE: "BULKUPDATE" },
}));

import { Sequelize } from "sequelize";
import { SequelizeConnector, type SequelizeEngine } from "@monolite/data";

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  log: jest.fn(),
} as unknown as ILogger;

const build = (engine: SequelizeEngine) =>
  new SequelizeConnector(
    {
      engine,
      host: "localhost",
      port: 1234,
      username: "user",
      password: "secret",
      database: "testdb",
    },
    logger
  );

/** Last set of options `query` was called with. */
const lastOptions = () => sequelize.query.mock.calls.at(-1)?.[1] as Record<string, unknown>;
const lastSql = () => sequelize.query.mock.calls.at(-1)?.[0] as string;

describe("SequelizeConnector", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("connection", () => {
    it("exposes the configured engine", () => {
      expect(build("postgres").engine).toBe("postgres");
      expect(build("mssql").engine).toBe("mssql");
    });

    it("authenticate confirms that the database answers", async () => {
      sequelize.authenticate.mockResolvedValue(undefined);

      await expect(build("mysql").authenticate()).resolves.toBeUndefined();
      expect(sequelize.authenticate).toHaveBeenCalled();
    });

    it("a connection failure is wrapped keeping the cause", async () => {
      const original = new Error("ECONNREFUSED");
      sequelize.authenticate.mockRejectedValue(original);

      // The cause has to survive: `normalizeError` walks it in order to tell
      // "the database is not there" from "the client sent something wrong".
      await expect(build("postgres").authenticate()).rejects.toMatchObject({
        message: expect.stringContaining("authenticate failed"),
        cause: original,
      });
    });

    it("close releases the pool", async () => {
      sequelize.close.mockResolvedValue(undefined);

      await build("mysql").close();
      expect(sequelize.close).toHaveBeenCalled();
    });
  });

  describe("reads", () => {
    it("asks for a result set and returns the rows", async () => {
      sequelize.query.mockResolvedValue([{ ID: 1 }, { ID: 2 }]);

      const result = await build("postgres").execute("SELECT * FROM T", { a: 1 });

      expect(lastOptions()).toMatchObject({ type: "SELECT", replacements: { a: 1 } });
      expect(result.rows).toHaveLength(2);
      // With no affected rows of its own, the count is that of what was read.
      expect(result.rowsAffected).toBe(2);
    });

    it("`rows` is the default mode", async () => {
      sequelize.query.mockResolvedValue([]);

      await build("mysql").execute("SELECT 1");

      expect(lastOptions()).toMatchObject({ type: "SELECT" });
    });
  });

  describe("affected rows", () => {
    it("SQL Server is asked with @@ROWCOUNT, because it does not report them", async () => {
      sequelize.query.mockResolvedValue([{ OTHER: 1 }, { AFFECTEDROWS: 3 }]);

      const result = await build("mssql").execute("UPDATE T SET A = 1", {}, {
        expects: "affected",
      });

      expect(lastSql()).toBe("UPDATE T SET A = 1; SELECT @@ROWCOUNT AS AFFECTEDROWS;");
      // The last row of the batch is read: @@ROWCOUNT reflects the last statement.
      expect(result.rowsAffected).toBe(3);
    });

    it("SQL Server with no answer counts zero instead of a NaN", async () => {
      sequelize.query.mockResolvedValue([]);

      const result = await build("mssql").execute("UPDATE T SET A = 1", {}, {
        expects: "affected",
      });

      expect(result.rowsAffected).toBe(0);
    });

    it("PostgreSQL and MySQL return them on their own", async () => {
      sequelize.query.mockResolvedValue(7);

      const result = await build("postgres").execute("DELETE FROM T", {}, {
        expects: "affected",
      });

      expect(lastOptions()).toMatchObject({ type: "BULKUPDATE" });
      expect(lastSql()).toBe("DELETE FROM T");
      expect(result.rowsAffected).toBe(7);
    });
  });

  describe("generated id", () => {
    it("collects it from the driver and publishes it where the dialect looks for it", async () => {
      sequelize.query.mockResolvedValue([42, 1]);

      const result = await build("mysql").execute("INSERT INTO T ...", {}, {
        expects: "identity",
      });

      expect(lastOptions()).toMatchObject({ type: "INSERT" });
      expect(result.rows).toEqual([{ insertedId: 42 }]);
      expect(result.rowsAffected).toBe(1);
    });
  });

  describe("statement errors", () => {
    it("are logged with the SQL and propagated with the cause", async () => {
      const original = new Error("nothing to do with ORA, this is Postgres");
      sequelize.query.mockRejectedValue(original);

      await expect(build("postgres").execute("SELECT boom")).rejects.toMatchObject({
        message: expect.stringContaining("execute failed"),
        cause: original,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("postgres"),
        expect.objectContaining({ sql: "SELECT boom" })
      );
    });
  });

  describe("executeMany", () => {
    it("an empty batch does not touch the database", async () => {
      await expect(build("mysql").executeMany("INSERT INTO T ...", [])).resolves.toBe(0);

      expect(sequelize.transaction).not.toHaveBeenCalled();
      expect(sequelize.query).not.toHaveBeenCalled();
    });

    it("repeats the statement inside a transaction and adds up what it affected", async () => {
      // Sequelize has no bulk like node-oracledb's: the "all of them or none"
      // guarantee comes from the transaction.
      const tx = { id: "tx" };
      sequelize.transaction.mockImplementation((work: (t: unknown) => Promise<unknown>) =>
        work(tx)
      );
      sequelize.query.mockResolvedValue(1);

      const affected = await build("postgres").executeMany("INSERT INTO T ...", [
        { a: 1 },
        { a: 2 },
      ]);

      expect(affected).toBe(2);
      expect(sequelize.query).toHaveBeenCalledTimes(2);
      // Every row travels with its own binds, and all of them through the same
      // transaction.
      expect(sequelize.query.mock.calls[0][1]).toMatchObject({
        replacements: { a: 1 },
        transaction: tx,
      });
      expect(sequelize.query.mock.calls[1][1]).toMatchObject({
        replacements: { a: 2 },
        transaction: tx,
      });
    });
  });

  describe("transaction", () => {
    it("hands over an executor bound to the transaction", async () => {
      const tx = { id: "tx" };
      sequelize.transaction.mockImplementation((work: (t: unknown) => Promise<unknown>) =>
        work(tx)
      );
      sequelize.query.mockResolvedValue([]);

      const result = await build("mysql").transaction(async (executor) => {
        await executor.execute("SELECT 1");
        return "done";
      });

      expect(result).toBe("done");
      // Without the transaction in the options, the statement would go through
      // the pool with auto-commit and would survive the rollback.
      expect(lastOptions()).toMatchObject({ transaction: tx });
    });

    it("the executor's executeMany also joins the same transaction", async () => {
      const tx = { id: "tx" };
      sequelize.transaction.mockImplementation((work: (t: unknown) => Promise<unknown>) =>
        work(tx)
      );
      sequelize.query.mockResolvedValue(1);

      const affected = await build("postgres").transaction((executor) =>
        executor.executeMany("INSERT INTO T ...", [{ a: 1 }])
      );

      expect(affected).toBe(1);
      // A single transaction: the block's, not another one for the batch.
      expect(sequelize.transaction).toHaveBeenCalledTimes(1);
      expect(lastOptions()).toMatchObject({ transaction: tx });
    });

    it("an empty batch inside the transaction does not query either", async () => {
      const tx = { id: "tx" };
      sequelize.transaction.mockImplementation((work: (t: unknown) => Promise<unknown>) =>
        work(tx)
      );

      const affected = await build("mysql").transaction((executor) =>
        executor.executeMany("INSERT INTO T ...", [])
      );

      expect(affected).toBe(0);
      expect(sequelize.query).not.toHaveBeenCalled();
    });
  });

  it("logs the SQL in development so it can be seen", () => {
    build("postgres");

    const options = (Sequelize as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      logging: unknown;
    };

    // In production it is switched off: SQL in the log is noise and can carry data.
    expect(typeof options.logging).toBe(
      process.env.NODE_ENV === "production" ? "boolean" : "function"
    );
  });
});
