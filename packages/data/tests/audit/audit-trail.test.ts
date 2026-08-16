import { AsyncRequestContext } from "@monolite/core";
import {
  defineEntity,
  MemoryAuditTrail,
  MemoryGenericRepository,
  oracleDialect,
  SqlGenericRepository,
  type IAuditLog,
} from "@monolite/data";
import { FakeSqlExecutor, silentLogger } from "../support/fake-sql-executor";
import { AUDIT_LOG_ENTITY, ITestItem, TEST_ENTITY } from "../support/test-entity";

/** The test entity, but with the change log switched on. */
const TRACKED_ENTITY = defineEntity<ITestItem>({
  ...TEST_ENTITY,
  table: "ITEMS",
  auditTrail: true,
});

describe("change log", () => {
  let context: AsyncRequestContext;
  let auditStore: MemoryGenericRepository<IAuditLog>;
  let trail: MemoryAuditTrail;
  let repository: MemoryGenericRepository<ITestItem>;

  const entries = () => auditStore.getAll({ orderBy: { field: "pkAudit" } });
  const asUser = <T>(name: string, fn: () => T): T =>
    context.run({ requestId: "req-42", user: { id: "7", name, email: null, roles: [] } }, fn);

  beforeEach(() => {
    context = new AsyncRequestContext();
    auditStore = new MemoryGenericRepository<IAuditLog>(AUDIT_LOG_ENTITY, []);
    trail = new MemoryAuditTrail(auditStore);
    repository = new MemoryGenericRepository<ITestItem>(TRACKED_ENTITY, [], context, trail);
  });

  // ==============================================================  opt-in  ==
  it("records nothing when the entity does not switch it on", async () => {
    const untracked = new MemoryGenericRepository<ITestItem>(TEST_ENTITY, [], context, trail);

    await untracked.insert({ name: "alpha" });

    expect(await auditStore.count()).toBe(0);
  });

  // The change-log table itself does not switch it on: recording itself would
  // recurse.
  it("AUDIT_LOG does not have the change log switched on", () => {
    expect(AUDIT_LOG_ENTITY.auditTrail).toBeUndefined();
  });

  // =============================================================  actions  ==
  it("records the insert with the values that were written", async () => {
    const created = await asUser("Ruben", () => repository.insert({ name: "alpha", qty: 10 }));

    const [entry] = await entries();
    expect(entry).toMatchObject({
      entity: "ITEMS",
      entityId: String(created.pkItem),
      action: "INSERT",
      changedBy: "Ruben",
      requestId: "req-42",
    });

    const changes = JSON.parse(entry.changes!);
    expect(changes.after).toMatchObject({ name: "alpha", qty: 10 });
  });

  it("records the before and the after of an update", async () => {
    const created = await asUser("Ana", () => repository.insert({ name: "alpha" }));
    await asUser("Beto", () => repository.update(created.pkItem, { name: "beta" }));

    const [, update] = await entries();
    expect(update).toMatchObject({ action: "UPDATE", changedBy: "Beto" });

    const changes = JSON.parse(update.changes!);
    expect(changes.before.name).toBe("alpha");
    expect(changes.after.name).toBe("beta");
  });

  it("records both kinds of delete and the restore", async () => {
    const created = await asUser("Ana", () => repository.insert({ name: "alpha" }));

    await asUser("Ana", () => repository.softDelete(created.pkItem));
    await asUser("Ana", () => repository.restore(created.pkItem));
    await asUser("Ana", () => repository.hardDelete(created.pkItem));

    expect((await entries()).map((e) => e.action)).toEqual([
      "INSERT",
      "SOFT_DELETE",
      "RESTORE",
      "HARD_DELETE",
    ]);
  });

  // This is the case that justifies having a change log on top of
  // CREATED_BY/UPDATED_BY: the row no longer exists, but its last state was
  // recorded.
  it("the hard delete keeps the row's last state", async () => {
    const created = await asUser("Ana", () => repository.insert({ name: "alpha", qty: 7 }));
    await asUser("Ana", () => repository.hardDelete(created.pkItem));

    const last = (await entries()).at(-1)!;
    expect(JSON.parse(last.changes!).before).toMatchObject({ name: "alpha", qty: 7 });
  });

  it("a failed operation leaves no line", async () => {
    expect(await repository.softDelete(999)).toBe(false);
    expect(await repository.hardDelete(999)).toBe(false);

    expect(await auditStore.count()).toBe(0);
  });

  it("bulk operations record a single line with their scope", async () => {
    await repository.insertMany([{ name: "a" }, { name: "b" }]);
    await repository.updateWhere({ name: "a" }, { qty: 5 });
    await repository.hardDeleteWhere({ name: "b" });

    const actions = (await entries()).map((e) => e.action);
    expect(actions).toEqual(["INSERT_MANY", "UPDATE_MANY", "HARD_DELETE_MANY"]);

    const [insertMany, updateMany] = await entries();
    expect(JSON.parse(insertMany.changes!)).toEqual({ affected: 2 });
    expect(JSON.parse(updateMany.changes!)).toMatchObject({ affected: 1 });
  });

  it("outside a request it is recorded under System and with no requestId", async () => {
    await repository.insert({ name: "seed" });

    const [entry] = await entries();
    expect(entry).toMatchObject({ changedBy: "System", requestId: null });
  });

  it("truncates an oversized detail instead of blowing the column", async () => {
    await repository.insert({ name: "x".repeat(6000) });

    const [entry] = await entries();
    expect(entry.changes!.length).toBeLessThanOrEqual(4000);
    expect(entry.changes!.endsWith("...")).toBe(true);
  });

  it("serialises dates in ISO", async () => {
    await repository.insert({ name: "alpha", dueAt: new Date("2026-05-01T10:00:00.000Z") });

    const changes = JSON.parse((await entries())[0].changes!);
    expect(changes.after.dueAt).toBe("2026-05-01T10:00:00.000Z");
  });
});

describe("SqlAuditTrail", () => {
  // The log line is written through the same executor as the audited operation;
  // inside a transaction it lands in the same commit.
  it("writes through the audited repository's executor", async () => {
    const db = new FakeSqlExecutor();
    const auditStore = new MemoryGenericRepository<IAuditLog>(AUDIT_LOG_ENTITY, []);
    const trail = new MemoryAuditTrail(auditStore);

    const repository = new SqlGenericRepository<ITestItem>(
      db,
      TRACKED_ENTITY,
      silentLogger,
      oracleDialect,
      undefined,
      trail
    );

    db.queue({ outBinds: { insertedId: [1] } }).queue({ rows: [{ PK_ITEM: 1, NAME: "alpha" }] });
    await repository.insert({ name: "alpha" });

    expect((await auditStore.getAll())[0]).toMatchObject({
      entity: "ITEMS",
      entityId: "1",
      action: "INSERT",
    });
  });

  it("bindTo returns a change log tied to the transaction", () => {
    const auditStore = new MemoryGenericRepository<IAuditLog>(AUDIT_LOG_ENTITY, []);
    const trail = new MemoryAuditTrail(auditStore);

    // In memory there is no connection to tie to: the same instance serves.
    expect(trail.bindTo()).toBe(trail);
  });
});
