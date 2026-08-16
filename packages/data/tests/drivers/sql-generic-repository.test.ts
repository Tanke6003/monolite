import { oracleDialect, SqlGenericRepository } from "monolite-data";
import { FakeSqlExecutor, silentLogger } from "../support/fake-sql-executor";
import { ITestItem, IPlainItem, PLAIN_ENTITY, TEST_ENTITY } from "../support/test-entity";

const ROW = {
  PK_ITEM: 1,
  NAME: "alpha",
  QTY: 10,
  TAG: null,
  FLAG: 1,
  DUE_AT: new Date("2026-01-10T10:00:00Z"),
  ACTIVE: 1,
  CREATED_AT: new Date("2026-01-01T00:00:00Z"),
  UPDATED_AT: null,
};

describe("SqlGenericRepository on the Oracle dialect", () => {
  let db: FakeSqlExecutor;
  let repository: SqlGenericRepository<ITestItem>;

  beforeEach(() => {
    db = new FakeSqlExecutor();
    repository = new SqlGenericRepository<ITestItem>(db, TEST_ENTITY, silentLogger, oracleDialect);
  });

  // ==============================================================  reads  ===
  describe("SELECT", () => {
    it("lists every mapped column and leaves out the soft-deleted rows", async () => {
      await repository.getAll();

      expect(db.lastSql).toContain("SELECT PK_ITEM, NAME, QTY, TAG, FLAG, DUE_AT, ACTIVE");
      expect(db.lastSql).toContain("FROM ITEMS");
      expect(db.lastSql).toContain("WHERE ACTIVE = :w0");
      expect(db.lastBinds).toEqual({ w0: 1 });
    });

    it("withDeleted removes the soft-delete filter", async () => {
      await repository.getAll({ withDeleted: true });
      expect(db.lastSql).not.toContain("WHERE");
    });

    it("projects only what was asked for", async () => {
      await repository.find({ select: ["name", "qty"] });
      expect(db.lastSql).toContain("SELECT NAME, QTY FROM ITEMS");
    });

    it("translates the sort order", async () => {
      await repository.find({
        orderBy: [{ field: "qty", direction: "desc" }, { field: "name" }],
      });
      expect(db.lastSql).toContain("ORDER BY QTY DESC, NAME ASC");
    });

    it("paginates with OFFSET/FETCH and sorts by PK when no order was asked for", async () => {
      await repository.find({ skip: 20, take: 10 });

      expect(db.lastSql).toContain(
        "ORDER BY PK_ITEM OFFSET :pgskip ROWS FETCH NEXT :pgtake ROWS ONLY"
      );
      expect(db.lastBinds).toMatchObject({ pgskip: 20, pgtake: 10 });
    });

    it("maps the raw row to the entity, converting types", async () => {
      db.queue({ rows: [ROW] });
      const item = await repository.getById(1);

      expect(item).toMatchObject({ pkItem: 1, name: "alpha", qty: 10, tag: null, flag: true });
      expect(item?.createdAt).toBeInstanceOf(Date);
    });

    it("getById filters by PK and limits to a single row", async () => {
      await repository.getById(7);

      expect(db.lastSql).toContain("PK_ITEM = :w0");
      expect(db.lastBinds).toMatchObject({ w0: 7, pgtake: 1 });
    });

    it("count uses COUNT(*) and returns 0 when there are no rows", async () => {
      db.queue({ rows: [{ TOTAL: 5 }] });
      expect(await repository.count()).toBe(5);
      expect(db.lastSql).toContain("SELECT COUNT(*) AS TOTAL FROM ITEMS");

      expect(await repository.count()).toBe(0);
    });

    it("exists leans on count", async () => {
      db.queue({ rows: [{ TOTAL: 1 }] });
      expect(await repository.exists({ name: "alpha" })).toBe(true);
    });

    it("getPaged combines the count and the page", async () => {
      db.queue({ rows: [{ TOTAL: 3 }] }).queue({ rows: [ROW] });
      const page = await repository.getPaged(2, 2);

      expect(page).toMatchObject({ total: 3, page: 2, limit: 2, pages: 2 });
      expect(page.items).toHaveLength(1);
      expect(db.lastBinds).toMatchObject({ pgskip: 2, pgtake: 2 });
    });
  });

  // =============================================================  writes  ===
  describe("INSERT", () => {
    it("writes the columns, leaves the date to the database and recovers the PK", async () => {
      db.queue({ rowsAffected: 1, outBinds: { insertedId: [42] } }).queue({ rows: [ROW] });

      const created = await repository.insert({ name: "alpha", qty: 10 });

      expect(db.sqlAt(0)).toBe(
        "INSERT INTO ITEMS (NAME, QTY, CREATED_AT) VALUES (:b0, :b1, SYSTIMESTAMP) " +
          "RETURNING PK_ITEM INTO :insertedId"
      );
      expect(db.calls[0].binds).toMatchObject({ b0: "alpha", b1: 10 });
      // The read-back uses the PK returned by RETURNING.
      expect(db.calls[1].binds).toMatchObject({ w0: 42 });
      expect(created.name).toBe("alpha");
    });

    it("converts booleans to 1/0", async () => {
      db.queue({ outBinds: { insertedId: [1] } }).queue({ rows: [ROW] });
      await repository.insert({ name: "x", flag: false });

      expect(db.calls[0].binds).toMatchObject({ b1: 0 });
    });

    it("throws when there is no column at all to write", async () => {
      await expect(repository.insert({})).rejects.toThrow(/with no columns to write/);
    });

    it("throws when the inserted row cannot be read back", async () => {
      db.queue({ outBinds: { insertedId: [42] } }).queue({ rows: [] });
      await expect(repository.insert({ name: "x" })).rejects.toThrow(/could not be read back/);
    });

    it("without identity it uses the supplied PK and generates no RETURNING", async () => {
      const plain = new SqlGenericRepository<IPlainItem, string>(
        db,
        PLAIN_ENTITY,
        silentLogger,
        oracleDialect
      );
      db.queue({ rowsAffected: 1 }).queue({ rows: [{ CODE: "A", LABEL: "one" }] });

      const created = await plain.insert({ code: "A", label: "one" });

      expect(db.sqlAt(0)).toBe("INSERT INTO PLAIN (CODE, LABEL) VALUES (:b0, :b1)");
      expect(created.code).toBe("A");
    });

    it("insertMany uses a single statement with one set of binds per row", async () => {
      const affected = await repository.insertMany([{ name: "a", qty: 1 }, { name: "b" }]);

      expect(affected).toBe(2);
      expect(db.sqlAt(0)).toBe(
        "INSERT INTO ITEMS (NAME, QTY, CREATED_AT) VALUES (:b0, :b1, SYSTIMESTAMP)"
      );
      expect(db.calls[0].binds).toEqual([
        { b0: "a", b1: 1 },
        // The row that does not carry the column travels as NULL.
        { b0: "b", b1: null },
      ]);
    });

    it("insertMany with an empty list does not touch the database", async () => {
      expect(await repository.insertMany([])).toBe(0);
      expect(db.calls).toHaveLength(0);
    });

    it("insertMany throws when no row contributes a single column", async () => {
      await expect(repository.insertMany([{}])).rejects.toThrow(/with no columns to write/);
    });
  });

  describe("UPDATE", () => {
    it("updates only what it received and stamps updatedAt", async () => {
      db.queue({ rowsAffected: 1 }).queue({ rows: [ROW] });
      await repository.update(1, { name: "new" });

      expect(db.sqlAt(0)).toBe(
        "UPDATE ITEMS SET NAME = :s0, UPDATED_AT = SYSTIMESTAMP WHERE (PK_ITEM = :w0 AND ACTIVE = :w1)"
      );
      expect(db.calls[0].binds).toMatchObject({ s0: "new", w0: 1, w1: 1 });
    });

    it("an update with no effective changes returns the current state without writing", async () => {
      db.queue({ rows: [ROW] });
      const result = await repository.update(1, { pkItem: 9 });

      expect(result?.pkItem).toBe(1);
      expect(db.lastSql.startsWith("SELECT")).toBe(true);
    });

    it("returns null when the UPDATE affected nobody", async () => {
      db.queue({ rowsAffected: 0 });
      expect(await repository.update(1, { name: "x" })).toBeNull();
    });

    it("updateWhere returns the affected rows", async () => {
      db.queue({ rowsAffected: 3 });
      expect(await repository.updateWhere({ qty: { gt: 5 } }, { tag: "z" })).toBe(3);
      expect(await repository.updateWhere({ qty: { gt: 5 } }, {})).toBe(0);
    });
  });

  // ============================================================  deletes  ===
  describe("DELETE", () => {
    it("the soft delete demands the previous state, which is what makes it idempotent", async () => {
      db.queue({ rowsAffected: 1 });
      expect(await repository.softDelete(1)).toBe(true);

      expect(db.lastSql).toBe(
        "UPDATE ITEMS SET ACTIVE = :flag, UPDATED_AT = SYSTIMESTAMP " +
          "WHERE PK_ITEM = :pk AND ACTIVE = :previous"
      );
      expect(db.lastBinds).toEqual({ flag: 0, pk: 1, previous: 1 });
    });

    it("restore flips the soft-delete values around", async () => {
      db.queue({ rowsAffected: 1 });
      expect(await repository.restore(1)).toBe(true);
      expect(db.lastBinds).toEqual({ flag: 1, pk: 1, previous: 0 });
    });

    it("the hard delete emits a DELETE", async () => {
      db.queue({ rowsAffected: 1 });
      expect(await repository.hardDelete(1)).toBe(true);
      expect(db.lastSql).toBe("DELETE FROM ITEMS WHERE PK_ITEM = :pk");

      expect(await repository.hardDelete(1)).toBe(false);
    });

    it("hardDeleteWhere does not apply the soft-delete filter", async () => {
      db.queue({ rowsAffected: 2 });
      expect(await repository.hardDeleteWhere({ qty: { lt: 5 } })).toBe(2);

      expect(db.lastSql).toBe("DELETE FROM ITEMS WHERE QTY < :w0");
      expect(db.lastSql).not.toContain("ACTIVE");
    });

    it("throws when the entity declares no soft delete", async () => {
      const plain = new SqlGenericRepository<IPlainItem, string>(
        db,
        PLAIN_ENTITY,
        silentLogger,
        oracleDialect
      );
      await expect(plain.softDelete("A")).rejects.toThrow(/does not declare softDelete/);
    });
  });

  // ==============================================================  extras  ==
  it("executeRaw passes the SQL through untouched with its binds", async () => {
    db.queue({ rows: [{ TOTAL: 2 }] });
    const rows = await repository.executeRaw("SELECT COUNT(*) AS TOTAL FROM ITEMS", { a: 1 });

    expect(rows).toEqual([{ TOTAL: 2 }]);
    expect(db.lastBinds).toEqual({ a: 1 });
  });

  it("withExecutor clones the repository against another connection", async () => {
    const other = new FakeSqlExecutor();
    await repository.withExecutor(other).getAll();

    expect(other.calls).toHaveLength(1);
    expect(db.calls).toHaveLength(0);
  });

  it("query() chains filters, ordering and pagination", async () => {
    db.queue({ rows: [ROW] });

    await repository
      .query()
      .where({ qty: { gte: 10 } })
      .where({ flag: true })
      .orderByDescending("qty")
      .skip(5)
      .take(5)
      .toList();

    expect(db.lastSql).toContain("QTY >= :w0");
    expect(db.lastSql).toContain("FLAG = :w1");
    expect(db.lastSql).toContain("ORDER BY QTY DESC");
    expect(db.lastBinds).toMatchObject({ pgskip: 5, pgtake: 5 });
  });
});
