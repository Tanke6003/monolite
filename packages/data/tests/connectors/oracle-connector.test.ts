import oracledb from "oracledb";
import { OracleConnector } from "monolite-data";

// The real driver would open an actual connection; here the only thing that
// matters is what the connector asks it for and how it translates its answers.
jest.mock("oracledb", () => ({
  createPool: jest.fn(),
  OUT_FORMAT_OBJECT: 4002,
  CLOB: 2006,
  BIND_OUT: 3003,
  NUMBER: 2010,
  CURSOR: 2021,
}));

const CONFIG = {
  user: "appuser",
  password: "secret",
  connectString: "localhost:1521/FREEPDB1",
};

const logger = {
  log: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
} as never;

describe("OracleConnector", () => {
  let connection: any;
  let pool: any;
  let connector: OracleConnector;

  beforeEach(() => {
    jest.clearAllMocks();

    connection = {
      execute: jest.fn().mockResolvedValue({ rows: [], rowsAffected: 0, outBinds: {} }),
      executeMany: jest.fn().mockResolvedValue({ rowsAffected: 0 }),
      commit: jest.fn(),
      rollback: jest.fn(),
      close: jest.fn(),
    };
    pool = { getConnection: jest.fn().mockResolvedValue(connection), close: jest.fn() };
    (oracledb.createPool as jest.Mock).mockResolvedValue(pool);

    connector = new OracleConnector(CONFIG, logger);
  });

  describe("pool", () => {
    it("is created lazily and only once", async () => {
      expect(oracledb.createPool).not.toHaveBeenCalled();

      await Promise.all([
        connector.execute("SELECT 1 FROM DUAL"),
        connector.execute("SELECT 2 FROM DUAL"),
      ]);

      expect(oracledb.createPool).toHaveBeenCalledTimes(1);
      expect(oracledb.createPool).toHaveBeenCalledWith(
        expect.objectContaining({ ...CONFIG, poolMin: 1, poolMax: 10, poolIncrement: 1 })
      );
    });

    it("honours the configured sizing", async () => {
      const tuned = new OracleConnector(
        { ...CONFIG, poolMin: 2, poolMax: 4, poolIncrement: 2 },
        logger
      );
      await tuned.execute("SELECT 1 FROM DUAL");

      expect(oracledb.createPool).toHaveBeenCalledWith(
        expect.objectContaining({ poolMin: 2, poolMax: 4, poolIncrement: 2 })
      );
    });

    it("a failure creating the pool is not cached: the next attempt retries", async () => {
      (oracledb.createPool as jest.Mock).mockRejectedValueOnce(new Error("ORA-12541"));

      await expect(connector.execute("SELECT 1 FROM DUAL")).rejects.toThrow(/createPool failed/);

      // The database answers now: without the retry, the rejected promise would
      // block the application forever.
      await expect(connector.execute("SELECT 1 FROM DUAL")).resolves.toBeDefined();
    });

    it("authenticate pings and gives the connection back to the pool", async () => {
      await connector.authenticate();

      expect(connection.execute).toHaveBeenCalledWith("SELECT 1 FROM DUAL");
      expect(connection.close).toHaveBeenCalled();
    });

    it("authenticate translates the ping failure", async () => {
      connection.execute.mockRejectedValue(new Error("ORA-01017"));

      await expect(connector.authenticate()).rejects.toThrow(/authenticate failed/);
      expect(connection.close).toHaveBeenCalled();
    });
  });

  describe("execute", () => {
    it("normalises the driver's answer", async () => {
      connection.execute.mockResolvedValue({
        rows: [{ A: 1 }],
        rowsAffected: 1,
        outBinds: { outpk: [7] },
      });

      const result = await connector.execute("SELECT :a FROM DUAL", { a: 1 });

      expect(result).toEqual({ rows: [{ A: 1 }], rowsAffected: 1, outBinds: { outpk: [7] } });
      expect(connection.execute).toHaveBeenCalledWith(
        "SELECT :a FROM DUAL",
        { a: 1 },
        { autoCommit: true }
      );
    });

    it("fills the gaps when the driver does not return everything", async () => {
      connection.execute.mockResolvedValue({});

      expect(await connector.execute("SELECT 1 FROM DUAL")).toEqual({
        rows: [],
        rowsAffected: 0,
        outBinds: {},
      });
    });

    it("wraps the error and gives the connection back all the same", async () => {
      connection.execute.mockRejectedValue(new Error("ORA-00942"));

      await expect(connector.execute("SELECT 1 FROM DUAL")).rejects.toThrow(/execute failed/);
      expect(connection.close).toHaveBeenCalled();
    });
  });

  describe("executeMany", () => {
    it("returns the affected rows", async () => {
      connection.executeMany.mockResolvedValue({ rowsAffected: 3 });

      expect(await connector.executeMany("INSERT ...", [{ a: 1 }, { a: 2 }])).toBe(3);
    });

    it("with an empty list it does not even open the pool", async () => {
      expect(await connector.executeMany("INSERT ...", [])).toBe(0);
      expect(oracledb.createPool).not.toHaveBeenCalled();
    });

    it("wraps the error", async () => {
      connection.executeMany.mockRejectedValue(new Error("ORA-00001"));

      await expect(connector.executeMany("INSERT ...", [{ a: 1 }])).rejects.toThrow(
        /executeMany failed/
      );
    });
  });

  describe("execStoredProcedure", () => {
    it("calls the anonymous block with the output cursor and closes it", async () => {
      const resultSet = { getRows: jest.fn().mockResolvedValue([{ A: 1 }]), close: jest.fn() };
      connection.execute.mockResolvedValue({ outBinds: { cursor: resultSet } });

      const rows = await connector.execStoredProcedure("SP_DEMO", [1, "x"]);

      expect(connection.execute).toHaveBeenCalledWith(
        "BEGIN SP_DEMO(:p0, :p1, :cursor); END;",
        expect.objectContaining({
          p0: 1,
          p1: "x",
          cursor: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR },
        })
      );
      expect(rows).toEqual([{ A: 1 }]);
      expect(resultSet.close).toHaveBeenCalled();
    });

    it("returns empty when the procedure exposes no cursor", async () => {
      connection.execute.mockResolvedValue({ outBinds: {} });

      expect(await connector.execStoredProcedure("SP_WITHOUT_CURSOR")).toEqual([]);
    });

    it("wraps the error naming the procedure", async () => {
      connection.execute.mockRejectedValue(new Error("ORA-06550"));

      await expect(connector.execStoredProcedure("SP_BAD")).rejects.toThrow(
        /execStoredProcedure SP_BAD failed/
      );
    });
  });

  describe("transaction", () => {
    it("commits when the block finishes cleanly", async () => {
      const result = await connector.transaction(async (tx) => {
        await tx.execute("UPDATE ...", { a: 1 });
        return "ok";
      });

      expect(result).toBe("ok");
      // Inside the transaction there can be no auto-commit.
      expect(connection.execute).toHaveBeenCalledWith("UPDATE ...", { a: 1 }, { autoCommit: false });
      expect(connection.commit).toHaveBeenCalled();
      expect(connection.rollback).not.toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalled();
    });

    it("rolls back and propagates the original error", async () => {
      await expect(
        connector.transaction(async () => {
          throw new Error("business failure");
        })
      ).rejects.toThrow("business failure");

      expect(connection.rollback).toHaveBeenCalled();
      expect(connection.commit).not.toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalled();
    });

    it("executeMany inside the transaction does not auto-commit either", async () => {
      connection.executeMany.mockResolvedValue({ rowsAffected: 2 });

      const affected = await connector.transaction((tx) => tx.executeMany("INSERT ...", [{ a: 1 }]));

      expect(affected).toBe(2);
      expect(connection.executeMany).toHaveBeenCalledWith("INSERT ...", [{ a: 1 }], {
        autoCommit: false,
      });
    });

    it("a transactional executeMany with an empty list does not call the driver", async () => {
      expect(await connector.transaction((tx) => tx.executeMany("INSERT ...", []))).toBe(0);
      expect(connection.executeMany).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("drains the pool and leaves the connector unusable", async () => {
      await connector.execute("SELECT 1 FROM DUAL");
      await connector.close();

      expect(pool.close).toHaveBeenCalledWith(10);
      await expect(connector.execute("SELECT 1 FROM DUAL")).rejects.toThrow(
        /has already been closed/
      );
    });

    it("closing without having opened does not fail", async () => {
      await expect(connector.close()).resolves.toBeUndefined();
    });
  });
});
