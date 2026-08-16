import {
  mysqlDialect,
  oracleDialect,
  postgresDialect,
  sqlServerDialect,
  SqlGenericRepository,
} from "@monolite/data";
import { FakeSqlExecutor, silentLogger } from "../support/fake-sql-executor";
import { ITestItem, IPlainItem, PLAIN_ENTITY, TEST_ENTITY } from "../support/test-entity";

const ROW = { PK_ITEM: 1, NAME: "alpha", QTY: 10, ACTIVE: 1 };

/**
 * SQL Server shares the whole SQL generation with Oracle: only the retrieval of
 * the generated PK and the server-side date expression change. These tests cover
 * exactly those differences.
 */
describe("SqlGenericRepository on the SQL Server dialect", () => {
  let db: FakeSqlExecutor;
  let repository: SqlGenericRepository<ITestItem>;

  beforeEach(() => {
    db = new FakeSqlExecutor();
    repository = new SqlGenericRepository<ITestItem>(db, TEST_ENTITY, silentLogger, sqlServerDialect);
  });

  describe("INSERT", () => {
    it("recovers the PK with OUTPUT INSERTED instead of RETURNING", async () => {
      db.queue({ rows: [{ insertedId: 42 }] }).queue({ rows: [ROW] });

      await repository.insert({ name: "alpha", qty: 10 });

      expect(db.sqlAt(0)).toBe(
        "INSERT INTO ITEMS (NAME, QTY, CREATED_AT) OUTPUT INSERTED.PK_ITEM AS insertedId " +
          "VALUES (:b0, :b1, SYSDATETIME())"
      );
      // The statement gives back rows, so the executor has to read them.
      expect(db.calls[0].expects).toBe("rows");
      // And the read-back uses the PK returned by OUTPUT.
      expect(db.calls[1].binds).toMatchObject({ w0: 42 });
    });

    it("tolerates the driver returning the column in a different case", async () => {
      db.queue({ rows: [{ INSERTEDID: 7 }] }).queue({ rows: [ROW] });

      await repository.insert({ name: "alpha" });

      expect(db.calls[1].binds).toMatchObject({ w0: 7 });
    });

    it("without identity it adds no OUTPUT and only counts affected rows", async () => {
      const plain = new SqlGenericRepository<IPlainItem, string>(
        db,
        PLAIN_ENTITY,
        silentLogger,
        sqlServerDialect
      );
      db.queue({ rowsAffected: 1 }).queue({ rows: [{ CODE: "A", LABEL: "one" }] });

      await plain.insert({ code: "A", label: "one" });

      expect(db.sqlAt(0)).toBe("INSERT INTO PLAIN (CODE, LABEL) VALUES (:b0, :b1)");
      expect(db.calls[0].expects).toBe("affected");
    });

    it("insertMany uses SQL Server's server-side date", async () => {
      await repository.insertMany([{ name: "a" }]);

      expect(db.sqlAt(0)).toContain("SYSDATETIME()");
      expect(db.sqlAt(0)).not.toContain("SYSTIMESTAMP");
    });
  });

  describe("the rest of the SQL", () => {
    it("the UPDATE stamps the date with SYSDATETIME()", async () => {
      db.queue({ rowsAffected: 1 }).queue({ rows: [ROW] });
      await repository.update(1, { name: "new" });

      expect(db.sqlAt(0)).toBe(
        "UPDATE ITEMS SET NAME = :s0, UPDATED_AT = SYSDATETIME() " +
          "WHERE (PK_ITEM = :w0 AND ACTIVE = :w1)"
      );
      expect(db.calls[0].expects).toBe("affected");
    });

    it("pagination is identical to Oracle's", async () => {
      await repository.find({ skip: 10, take: 5 });

      expect(db.lastSql).toContain(
        "ORDER BY PK_ITEM OFFSET :pgskip ROWS FETCH NEXT :pgtake ROWS ONLY"
      );
    });

    it("the filter and the projection are generated the same way", async () => {
      await repository.find({ where: { qty: { gte: 5 } }, select: ["name"] });

      expect(db.lastSql).toBe("SELECT NAME FROM ITEMS WHERE (QTY >= :w0 AND ACTIVE = :w1)");
      expect(db.lastBinds).toEqual({ w0: 5, w1: 1 });
    });

    it("count reads the total even if the driver returns the column in lower case", async () => {
      db.queue({ rows: [{ total: 4 }] });
      expect(await repository.count()).toBe(4);
    });

    it("the soft delete is still idempotent", async () => {
      db.queue({ rowsAffected: 1 });
      expect(await repository.softDelete(1)).toBe(true);

      expect(db.lastSql).toBe(
        "UPDATE ITEMS SET ACTIVE = :flag, UPDATED_AT = SYSDATETIME() " +
          "WHERE PK_ITEM = :pk AND ACTIVE = :previous"
      );
      expect(db.lastBinds).toEqual({ flag: 0, pk: 1, previous: 1 });
    });

    it("the hard delete asks for affected rows", async () => {
      db.queue({ rowsAffected: 1 });
      await repository.hardDelete(1);

      expect(db.lastSql).toBe("DELETE FROM ITEMS WHERE PK_ITEM = :pk");
      expect(db.calls[0].expects).toBe("affected");
    });
  });

  it("withExecutor keeps the SQL Server dialect", async () => {
    const tx = new FakeSqlExecutor();
    tx.queue({ rows: [{ insertedId: 1 }] }).queue({ rows: [ROW] });

    const bound = repository.withExecutor(tx);
    await bound.insert({ name: "x" });

    expect(bound).toBeInstanceOf(SqlGenericRepository);
    expect(tx.sqlAt(0)).toContain("OUTPUT INSERTED");
  });
});

// The original suite only exercised Oracle and SQL Server, which were the two
// engines that existed then. PostgreSQL and MySQL/MariaDB arrived with the port
// and differ from the other two in exactly the same three places, so they are
// covered the same way.
describe("SqlGenericRepository on the PostgreSQL dialect", () => {
  let db: FakeSqlExecutor;
  let repository: SqlGenericRepository<ITestItem>;

  beforeEach(() => {
    db = new FakeSqlExecutor();
    repository = new SqlGenericRepository<ITestItem>(db, TEST_ENTITY, silentLogger, postgresDialect);
  });

  it("recovers the PK with RETURNING, read as a result set", async () => {
    db.queue({ rows: [{ insertedid: 42 }] }).queue({ rows: [ROW] });

    await repository.insert({ name: "alpha", qty: 10 });

    expect(db.sqlAt(0)).toBe(
      "INSERT INTO ITEMS (NAME, QTY, CREATED_AT) VALUES (:b0, :b1, NOW()) " +
        "RETURNING PK_ITEM AS insertedId"
    );
    expect(db.calls[0].expects).toBe("rows");
    // Postgres folds unquoted identifiers to lower case, and the id is still found.
    expect(db.calls[1].binds).toMatchObject({ w0: 42 });
  });

  it("stamps the date with NOW() and paginates like the standard", async () => {
    await repository.find({ skip: 10, take: 5 });
    expect(db.lastSql).toContain("OFFSET :pgskip ROWS FETCH NEXT :pgtake ROWS ONLY");

    db.queue({ rowsAffected: 1 }).queue({ rows: [ROW] });
    await repository.update(1, { name: "new" });
    expect(db.sqlAt(1)).toContain("UPDATED_AT = NOW()");
  });

  it("locks a row with the standard FOR UPDATE", async () => {
    db.queue({ rows: [{ PK_ITEM: 1 }] });

    expect(await repository.lockById(1)).toBe(true);
    expect(db.lastSql).toBe("SELECT PK_ITEM FROM ITEMS WHERE PK_ITEM = :pk FOR UPDATE");
  });
});

describe("SqlGenericRepository on the MySQL dialect", () => {
  let db: FakeSqlExecutor;
  let repository: SqlGenericRepository<ITestItem>;

  beforeEach(() => {
    db = new FakeSqlExecutor();
    repository = new SqlGenericRepository<ITestItem>(db, TEST_ENTITY, silentLogger, mysqlDialect);
  });

  it("has neither RETURNING nor OUTPUT: it asks the driver for the generated id", async () => {
    db.queue({ rows: [{ insertedId: 42 }] }).queue({ rows: [ROW] });

    await repository.insert({ name: "alpha", qty: 10 });

    expect(db.sqlAt(0)).toBe(
      "INSERT INTO ITEMS (NAME, QTY, CREATED_AT) VALUES (:b0, :b1, CURRENT_TIMESTAMP(3))"
    );
    // `identity` is what tells the connector to go through LAST_INSERT_ID().
    expect(db.calls[0].expects).toBe("identity");
    expect(db.calls[1].binds).toMatchObject({ w0: 42 });
  });

  it("paginates with LIMIT, which is the only thing it understands", async () => {
    await repository.find({ skip: 10, take: 5 });
    expect(db.lastSql).toContain("LIMIT :pgtake OFFSET :pgskip");
  });

  // MySQL requires a LIMIT in order to accept an OFFSET, so "from row N to the
  // end" is written with the maximum the manual documents.
  it("an offset with no take still carries the maximum LIMIT", async () => {
    await repository.find({ skip: 10 });
    expect(db.lastSql).toContain("LIMIT 18446744073709551615 OFFSET :pgskip");
  });

  it("sends dates already in UTC, because DATETIME does not store the offset", () => {
    expect(mysqlDialect.toBindValue(new Date("2026-05-01T10:00:00.000Z"))).toBe(
      "2026-05-01 10:00:00.000"
    );
    expect(sqlServerDialect.toBindValue(new Date("2026-05-01T10:00:00.000Z"))).toBe(
      "2026-05-01 10:00:00.000"
    );
    // Oracle and PostgreSQL keep the instant, so their values travel untouched.
    const instant = new Date("2026-05-01T10:00:00.000Z");
    expect(oracleDialect.toBindValue(instant)).toBe(instant);
    expect(postgresDialect.toBindValue(instant)).toBe(instant);
  });
});

describe("row locking across the four dialects", () => {
  // T-SQL has no `FOR UPDATE`: the equivalent are the hints, and this is exactly
  // the kind of difference the dialect exists to absorb.
  it("SQL Server takes the lock with hints instead of FOR UPDATE", async () => {
    const db = new FakeSqlExecutor().queue({ rows: [{ PK_ITEM: 1 }] });
    const repository = new SqlGenericRepository<ITestItem>(
      db,
      TEST_ENTITY,
      silentLogger,
      sqlServerDialect
    );

    await repository.lockById(1);

    expect(db.lastSql).toBe(
      "SELECT PK_ITEM FROM ITEMS WITH (UPDLOCK, HOLDLOCK) WHERE PK_ITEM = :pk"
    );
  });

  it("the other three speak the standard", () => {
    for (const dialect of [oracleDialect, postgresDialect, mysqlDialect]) {
      expect(dialect.buildRowLock("ITEMS", "PK_ITEM")).toBe(
        "SELECT PK_ITEM FROM ITEMS WHERE PK_ITEM = :pk FOR UPDATE"
      );
    }
  });
});

describe("all four dialects over the same entity", () => {
  it("generate the same SELECT and differ only where they must", async () => {
    const executors = [oracleDialect, sqlServerDialect, postgresDialect, mysqlDialect].map(
      (dialect) => {
        const db = new FakeSqlExecutor();
        return { db, dialect };
      }
    );

    for (const { db, dialect } of executors) {
      await new SqlGenericRepository<ITestItem>(db, TEST_ENTITY, silentLogger, dialect).find({
        where: { name: "x" },
      });
    }

    const [oracle, ...rest] = executors;
    for (const other of rest) expect(other.db.lastSql).toBe(oracle.db.lastSql);
  });
});
