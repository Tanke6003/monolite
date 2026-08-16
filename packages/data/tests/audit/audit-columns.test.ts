import { AsyncRequestContext, type IRequestContext } from "@monolite/core";
import { MemoryGenericRepository, oracleDialect, SqlGenericRepository } from "@monolite/data";
import { FakeSqlExecutor, silentLogger } from "../support/fake-sql-executor";
import { AUDITED_ENTITY, AUDITED_SOFT_ENTITY, IAuditedItem } from "../support/test-entity";

/** Runs `fn` as if the request came from that user. */
function asUser<T>(context: IRequestContext, name: string, fn: () => T): T {
  return context.run({ requestId: "req-1", user: { id: "7", name, email: null, roles: [] } }, fn);
}

describe("user audit columns in the generic repository", () => {
  let context: AsyncRequestContext;

  beforeEach(() => {
    context = new AsyncRequestContext();
  });

  // ==============================================================  memory  ==
  describe("MemoryGenericRepository", () => {
    let repository: MemoryGenericRepository<IAuditedItem>;

    beforeEach(() => {
      repository = new MemoryGenericRepository<IAuditedItem>(AUDITED_ENTITY, [], context);
    });

    it("stamps createdBy with the user of the request", async () => {
      const created = await asUser(context, "Ruben", () => repository.insert({ name: "one" }));

      expect(created.createdBy).toBe("Ruben");
      expect(created.updatedBy).toBeNull();
    });

    it("outside a request it writes System", async () => {
      expect((await repository.insert({ name: "seed" })).createdBy).toBe("System");
    });

    it("with no context injected it also writes System", async () => {
      const orphan = new MemoryGenericRepository<IAuditedItem>(AUDITED_ENTITY, []);
      expect((await orphan.insert({ name: "x" })).createdBy).toBe("System");
    });

    it("stamps updatedBy on an update without touching createdBy", async () => {
      const created = await asUser(context, "Ana", () => repository.insert({ name: "one" }));
      const updated = await asUser(context, "Beto", () =>
        repository.update(created.pkItem, { name: "two" })
      );

      expect(updated).toMatchObject({ createdBy: "Ana", updatedBy: "Beto" });
    });

    // The client must not be able to decide who is recorded as the author.
    it("ignores the audit fields that arrive in the request body", async () => {
      const created = await asUser(context, "Ana", () =>
        repository.insert({ name: "one", createdBy: "Impersonator" })
      );
      expect(created.createdBy).toBe("Ana");

      const updated = await asUser(context, "Ana", () =>
        repository.update(created.pkItem, { name: "two", updatedBy: "Impersonator" })
      );
      expect(updated?.updatedBy).toBe("Ana");
    });

    it("the soft delete also leaves a trace of who did it", async () => {
      const soft = new MemoryGenericRepository<IAuditedItem & { active?: boolean }>(
        AUDITED_SOFT_ENTITY,
        [],
        context
      );
      const created = await asUser(context, "Ana", () => soft.insert({ name: "one" }));

      await asUser(context, "Beto", () => soft.softDelete(created.pkItem));

      expect(await soft.getById(created.pkItem, { withDeleted: true })).toMatchObject({
        updatedBy: "Beto",
      });
    });

    it("keeps the user across chained asynchronous operations", async () => {
      const created = await asUser(context, "Ruben", async () => {
        await Promise.resolve();
        return repository.insert({ name: "after an await" });
      });

      expect(created.createdBy).toBe("Ruben");
    });
  });

  // ==================================================================  SQL  ==
  describe("SqlGenericRepository", () => {
    let db: FakeSqlExecutor;
    let repository: SqlGenericRepository<IAuditedItem>;

    beforeEach(() => {
      db = new FakeSqlExecutor();
      repository = new SqlGenericRepository<IAuditedItem>(
        db,
        AUDITED_ENTITY,
        silentLogger,
        oracleDialect,
        context
      );
    });

    it("adds CREATED_BY to the INSERT as a bind", async () => {
      db.queue({ outBinds: { insertedId: [1] } }).queue({ rows: [{ PK_ITEM: 1, NAME: "one" }] });

      await asUser(context, "Ruben", () => repository.insert({ name: "one" }));

      expect(db.sqlAt(0)).toBe(
        "INSERT INTO AUDITED (NAME, CREATED_BY) VALUES (:b0, :auditUser) RETURNING PK_ITEM INTO :insertedId"
      );
      expect(db.calls[0].binds).toMatchObject({ auditUser: "Ruben" });
    });

    it("adds UPDATED_BY to the UPDATE", async () => {
      db.queue({ rowsAffected: 1 }).queue({ rows: [{ PK_ITEM: 1 }] });

      await asUser(context, "Beto", () => repository.update(1, { name: "two" }));

      expect(db.sqlAt(0)).toContain("UPDATED_BY = :auditUser");
      expect(db.calls[0].binds).toMatchObject({ auditUser: "Beto" });
    });

    it("insertMany spreads the same user across every row", async () => {
      await asUser(context, "Ruben", () => repository.insertMany([{ name: "a" }, { name: "b" }]));

      expect(db.sqlAt(0)).toBe("INSERT INTO AUDITED (NAME, CREATED_BY) VALUES (:b0, :auditUser)");
      expect(db.calls[0].binds).toEqual([
        { b0: "a", auditUser: "Ruben" },
        { b0: "b", auditUser: "Ruben" },
      ]);
    });

    it("the soft delete records who did it", async () => {
      const soft = new SqlGenericRepository<IAuditedItem & { active?: boolean }>(
        db,
        AUDITED_SOFT_ENTITY,
        silentLogger,
        oracleDialect,
        context
      );
      db.queue({ rowsAffected: 1 });

      await asUser(context, "Beto", () => soft.softDelete(1));

      expect(db.lastSql).toContain("UPDATED_BY = :auditUser");
      expect(db.lastBinds).toMatchObject({ auditUser: "Beto" });
    });

    it("withExecutor keeps the context inside the transaction", async () => {
      const tx = new FakeSqlExecutor();
      tx.queue({ outBinds: { insertedId: [1] } }).queue({ rows: [{ PK_ITEM: 1 }] });

      await asUser(context, "Ruben", () => repository.withExecutor(tx).insert({ name: "one" }));

      expect(tx.calls[0].binds).toMatchObject({ auditUser: "Ruben" });
    });

    it("with no request in flight it writes System", async () => {
      db.queue({ outBinds: { insertedId: [1] } }).queue({ rows: [{ PK_ITEM: 1 }] });

      await repository.insert({ name: "seed" });

      expect(db.calls[0].binds).toMatchObject({ auditUser: "System" });
    });
  });
});
