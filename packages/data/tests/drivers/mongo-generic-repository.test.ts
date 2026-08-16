import type { ClientSession } from "mongodb";
import { AsyncRequestContext } from "monolite-core";
import {
  defineEntity,
  MongoAuditTrail,
  MongoGenericRepository,
  QueryBuilder,
  type IAuditLog,
} from "monolite-data";
import { FakeMongoDataSource } from "../support/fake-mongo";
import { silentLogger } from "../support/fake-sql-executor";
import {
  AUDIT_LOG_ENTITY,
  AUDITED_SOFT_ENTITY,
  IAuditedItem,
  IPlainItem,
  ITestItem,
  PLAIN_ENTITY,
  TEST_ENTITY,
} from "../support/test-entity";

/** The test entity with the change log switched on. */
const TRACKED_ENTITY = defineEntity<ITestItem>({ ...TEST_ENTITY, auditTrail: true });

/**
 * Documents equivalent to the ones a MongoDB seed script leaves behind:
 * hand-written PKs, UPPER-CASE fields and flags as 1/0.
 */
const SEED_DOCUMENTS = [
  {
    PK_ITEM: 1,
    NAME: "alpha",
    QTY: 10,
    TAG: "x",
    FLAG: 1,
    ACTIVE: 1,
    CREATED_AT: new Date("2026-01-01T00:00:00Z"),
  },
  {
    PK_ITEM: 2,
    NAME: "beta",
    QTY: 20,
    TAG: null,
    FLAG: 0,
    ACTIVE: 1,
    CREATED_AT: new Date("2026-01-02T00:00:00Z"),
  },
  {
    PK_ITEM: 3,
    NAME: "gamma",
    QTY: 30,
    TAG: "y",
    FLAG: 1,
    ACTIVE: 0,
    CREATED_AT: new Date("2026-01-03T00:00:00Z"),
  },
];

describe("MongoGenericRepository", () => {
  let db: FakeMongoDataSource;
  let repository: MongoGenericRepository<ITestItem>;

  const counters = () => db.documentsOf("_counters");

  beforeEach(() => {
    db = new FakeMongoDataSource();
    db.collectionOf("ITEMS").seed(SEED_DOCUMENTS.map((document) => ({ ...document })));
    repository = new MongoGenericRepository<ITestItem>(db, TEST_ENTITY, silentLogger);
  });

  // ================================================================  reads  ==
  describe("reads", () => {
    it("excludes the soft-deleted documents by default and includes them with withDeleted", async () => {
      expect((await repository.getAll()).map((item) => item.name)).toEqual(["alpha", "beta"]);
      expect(await repository.getAll({ withDeleted: true })).toHaveLength(3);
    });

    it("never returns the _id: it is Mongo's technical PK, not the model's", async () => {
      const [item] = await repository.getAll();

      expect(item).not.toHaveProperty("_id");
      // The stored document does have one: the projection removes it, not the seed.
      expect(db.documentsOf("ITEMS")[0]).toHaveProperty("_id");
    });

    it("select projects only the requested properties", async () => {
      const [item] = await repository.find({ select: ["name", "qty"], take: 1 });

      expect(item).toEqual({ name: "alpha", qty: 10 });
    });

    it("select rejects an unmapped property", async () => {
      await expect(repository.find({ select: ["madeUp"] as never })).rejects.toThrow(
        /is not mapped/
      );
    });

    it("sorts by the given property, in both directions", async () => {
      const asc = await repository.getAll({ orderBy: { field: "qty", direction: "asc" } });
      const desc = await repository.getAll({ orderBy: { field: "qty", direction: "desc" } });

      expect(asc.map((item) => item.qty)).toEqual([10, 20]);
      expect(desc.map((item) => item.qty)).toEqual([20, 10]);
    });

    it("paginating without an order falls back to the PK, so two pages do not overlap", async () => {
      // Mongo guarantees no natural order: without this fallback, page 2 could
      // repeat a document already returned on page 1.
      const page = await repository.find({ skip: 1, take: 1, withDeleted: true });

      expect(page.map((item) => item.pkItem)).toEqual([2]);
    });

    it("converts the values to the model's types", async () => {
      const item = await repository.getById(1);

      expect(item).toMatchObject({ pkItem: 1, name: "alpha", qty: 10, flag: true, active: true });
      expect(item?.createdAt).toBeInstanceOf(Date);
    });

    it("getById returns null when the record is soft-deleted, unless withDeleted", async () => {
      expect(await repository.getById(3)).toBeNull();
      expect(await repository.getById(3, { withDeleted: true })).toMatchObject({ name: "gamma" });
    });

    it("firstOrDefault returns null when there is nothing to match", async () => {
      expect(await repository.firstOrDefault({ where: { name: "does not exist" } })).toBeNull();
    });

    it("count and exists honour the soft-delete filter", async () => {
      expect(await repository.count()).toBe(2);
      expect(await repository.count(undefined, true)).toBe(3);
      expect(await repository.exists({ name: "gamma" })).toBe(false);
      expect(await repository.exists({ name: "gamma" }, true)).toBe(true);
    });

    it("getPaged returns the unpaginated total and the number of pages", async () => {
      const paged = await repository.getPaged(2, 1, { orderBy: { field: "qty" } });

      expect(paged).toMatchObject({ total: 2, page: 2, limit: 1, pages: 2 });
      expect(paged.items.map((item) => item.name)).toEqual(["beta"]);
    });

    it("getPaged normalises an impossible page or page size", async () => {
      const paged = await repository.getPaged(0, -5);

      expect(paged).toMatchObject({ page: 1, limit: 1 });
    });

    it("query() hands back the same query builder as every other driver", async () => {
      const query = repository.query();

      expect(query).toBeInstanceOf(QueryBuilder);
      expect(await query.where({ qty: { gte: 20 } }).count()).toBe(1);
    });
  });

  // =============================================================  sequence  ==
  describe("auto-numbered PK", () => {
    it("starts the counter above the highest PK the seed left behind", async () => {
      // The seed inserts 1..3 without going through the counter; if it started at
      // 1, the first insert would collide with a key already in use.
      const created = await repository.insert({ name: "delta", qty: 40 });

      expect(created.pkItem).toBe(4);
      expect(counters()).toEqual([expect.objectContaining({ _id: "ITEMS", seq: 4 })]);
    });

    it("from then on it keeps incrementing without looking at the collection again", async () => {
      await repository.insert({ name: "delta" });
      const second = await repository.insert({ name: "epsilon" });

      expect(second.pkItem).toBe(5);
    });

    it("on an empty collection it starts at 1", async () => {
      const empty = new MongoGenericRepository<IAuditedItem>(db, AUDITED_SOFT_ENTITY, silentLogger);

      expect((await empty.insert({ name: "first" })).pkItem).toBe(1);
    });

    it("insertMany reserves a block of consecutive keys", async () => {
      const affected = await repository.insertMany([{ name: "d" }, { name: "e" }, { name: "f" }]);

      expect(affected).toBe(3);
      expect(
        (await repository.getAll({ orderBy: { field: "pkItem" } })).map((i) => i.pkItem)
      ).toEqual([1, 2, 4, 5, 6]);
    });

    it("insertMany with nothing to insert does not touch the counter", async () => {
      expect(await repository.insertMany([])).toBe(0);
      expect(counters()).toHaveLength(0);
    });
  });

  // ===============================================================  writes  ==
  describe("writes", () => {
    it("fills in the creation stamp, the initial state and the modification slot", async () => {
      const created = await repository.insert({ name: "delta" });
      const [document] = db.documentsOf("ITEMS").filter((row) => row.PK_ITEM === created.pkItem);

      // The collection validator rejects documents but does not complete them:
      // these automatic values have to come from the repository.
      expect(document.CREATED_AT).toBeInstanceOf(Date);
      expect(document.UPDATED_AT).toBeNull();
      expect(document.ACTIVE).toBe(1);
    });

    it("converts booleans and dates to the collection's format", async () => {
      const created = await repository.insert({
        name: "delta",
        flag: false,
        dueAt: new Date("2026-05-01T10:00:00Z"),
      });
      const [document] = db.documentsOf("ITEMS").filter((row) => row.PK_ITEM === created.pkItem);

      expect(document.FLAG).toBe(0);
      expect(document.DUE_AT).toBeInstanceOf(Date);
    });

    it("an insert with no field to write is an error, not an empty document", async () => {
      await expect(repository.insert({})).rejects.toThrow(/with no fields to write/);
    });

    it("an entity without identity demands that the PK arrives in the body", async () => {
      const plain = new MongoGenericRepository<IPlainItem, string>(db, PLAIN_ENTITY, silentLogger);

      await expect(plain.insert({ label: "no key" })).rejects.toThrow(/the PK is mandatory/);
      expect(await plain.insert({ code: "A1", label: "with a key" })).toMatchObject({ code: "A1" });
    });

    it("update applies the changes and stamps the modification date", async () => {
      const updated = await repository.update(1, { name: "alpha v2" });
      const [document] = db.documentsOf("ITEMS").filter((row) => row.PK_ITEM === 1);

      expect(updated).toMatchObject({ name: "alpha v2" });
      expect(document.UPDATED_AT).toBeInstanceOf(Date);
      // The creation date is immutable: the metadata marks it as non-updatable.
      expect(document.CREATED_AT).toEqual(new Date("2026-01-01T00:00:00Z"));
    });

    it("an update with no updatable field returns the current state, not null", async () => {
      // The caller would read `null` as "does not exist", which is a different thing.
      expect(await repository.update(1, {})).toMatchObject({ name: "alpha" });
    });

    it("update returns null when the record does not exist or is soft-deleted", async () => {
      expect(await repository.update(99, { name: "x" })).toBeNull();
      expect(await repository.update(3, { name: "x" })).toBeNull();
    });

    it("updateWhere returns how many it reached and leaves the soft-deleted alone", async () => {
      const affected = await repository.updateWhere({ qty: { gte: 10 } }, { tag: "z" });

      expect(affected).toBe(2);
      expect(await repository.getById(3, { withDeleted: true })).toMatchObject({ tag: "y" });
    });

    it("updateWhere with no updatable field writes nothing", async () => {
      expect(await repository.updateWhere({ qty: { gte: 10 } }, {})).toBe(0);
    });
  });

  // ==============================================================  deletes  ==
  describe("deletes", () => {
    it("the soft delete and the restore are idempotent", async () => {
      expect(await repository.softDelete(1)).toBe(true);
      expect(await repository.softDelete(1)).toBe(false);
      expect(await repository.restore(1)).toBe(true);
      expect(await repository.restore(1)).toBe(false);
    });

    it("the soft delete leaves the record out of the ordinary reads", async () => {
      await repository.softDelete(1);

      expect(await repository.getById(1)).toBeNull();
      expect(await repository.getById(1, { withDeleted: true })).not.toBeNull();
    });

    it("an entity without softDelete complains instead of pretending it deleted", async () => {
      const plain = new MongoGenericRepository<IPlainItem, string>(db, PLAIN_ENTITY, silentLogger);

      await expect(plain.softDelete("A1")).rejects.toThrow(/does not declare softDelete/);
    });

    it("hardDelete really deletes and returns false when there was nothing", async () => {
      expect(await repository.hardDelete(1)).toBe(true);
      expect(await repository.hardDelete(1)).toBe(false);
      expect(db.documentsOf("ITEMS")).toHaveLength(2);
    });

    it("hardDeleteWhere also reaches the soft-deleted documents", async () => {
      // If it did not, it would leave orphan documents pointing at something that
      // has just disappeared.
      expect(await repository.hardDeleteWhere({ qty: { gte: 20 } })).toBe(2);
      expect(db.documentsOf("ITEMS")).toHaveLength(1);
    });

    it("hardDeleteWhere returns 0 when the filter matches nothing", async () => {
      expect(await repository.hardDeleteWhere({ name: "does not exist" })).toBe(0);
    });
  });

  // ==============================================================  session  ==
  describe("withSession", () => {
    it("propagates the session to every operation of the copy", async () => {
      const session = { id: "session-1" } as unknown as ClientSession;
      const bound = repository.withSession(session);

      await bound.getAll();
      await bound.update(1, { name: "x" });

      const sessions = db.calls
        .filter((call) => call.operation.endsWith(":ITEMS"))
        .map((call) => call.session);
      expect(sessions.every((used) => used === session)).toBe(true);
    });

    it("the original repository keeps working outside the transaction", async () => {
      repository.withSession({ id: "session-1" } as unknown as ClientSession);
      await repository.getAll();

      expect(db.calls.at(-1)?.session).toBeUndefined();
    });
  });

  // ===========================================================  change log  ==
  describe("change log", () => {
    let context: AsyncRequestContext;
    let tracked: MongoGenericRepository<ITestItem>;

    const entries = async () =>
      new MongoGenericRepository<IAuditLog>(db, AUDIT_LOG_ENTITY, silentLogger).getAll({
        orderBy: { field: "pkAudit" },
      });

    const asUser = <T>(name: string, fn: () => T): T =>
      context.run({ requestId: "req-42", user: { id: "7", name, email: null, roles: [] } }, fn);

    beforeEach(() => {
      context = new AsyncRequestContext();
      const trail = new MongoAuditTrail(
        new MongoGenericRepository<IAuditLog>(db, AUDIT_LOG_ENTITY, silentLogger, context)
      );
      tracked = new MongoGenericRepository<ITestItem>(
        db,
        TRACKED_ENTITY,
        silentLogger,
        context,
        trail
      );
    });

    it("records every write together with who made it and their request", async () => {
      const created = await asUser("Ruben", () => tracked.insert({ name: "delta" }));
      await asUser("Ruben", () => tracked.update(created.pkItem, { name: "delta v2" }));
      await asUser("Ruben", () => tracked.softDelete(created.pkItem));
      await asUser("Ruben", () => tracked.restore(created.pkItem));
      await asUser("Ruben", () => tracked.hardDelete(created.pkItem));

      const lines = await entries();
      expect(lines.map((line) => line.action)).toEqual([
        "INSERT",
        "UPDATE",
        "SOFT_DELETE",
        "RESTORE",
        "HARD_DELETE",
      ]);
      expect(lines.every((line) => line.changedBy === "Ruben")).toBe(true);
      expect(lines.every((line) => line.requestId === "req-42")).toBe(true);
      expect(lines.every((line) => line.entity === "ITEMS")).toBe(true);
    });

    it("with no request context everything is recorded under the system's name", async () => {
      await tracked.insert({ name: "delta" });

      expect((await entries())[0]).toMatchObject({ changedBy: "System", requestId: null });
    });

    it("keeps the state before and after a modification", async () => {
      const created = await asUser("Ana", () => tracked.insert({ name: "delta" }));
      await asUser("Ana", () => tracked.update(created.pkItem, { name: "delta v2" }));

      const changes = JSON.parse(String((await entries())[1].changes));
      expect(changes.before.name).toBe("delta");
      expect(changes.after.name).toBe("delta v2");
    });

    it("bulk operations are recorded once, with their scope", async () => {
      await asUser("Ana", () => tracked.insertMany([{ name: "d" }, { name: "e" }]));
      await asUser("Ana", () => tracked.updateWhere({ qty: { gte: 0 } }, { tag: "z" }));
      await asUser("Ana", () => tracked.hardDeleteWhere({ name: "d" }));

      expect((await entries()).map((line) => line.action)).toEqual([
        "INSERT_MANY",
        "UPDATE_MANY",
        "HARD_DELETE_MANY",
      ]);
    });

    it("an entity without the change log switched on leaves no trace", async () => {
      const trail = new MongoAuditTrail(
        new MongoGenericRepository<IAuditLog>(db, AUDIT_LOG_ENTITY, silentLogger)
      );
      const untracked = new MongoGenericRepository<ITestItem>(
        db,
        TEST_ENTITY,
        silentLogger,
        context,
        trail
      );

      await untracked.insert({ name: "delta" });

      expect(await entries()).toHaveLength(0);
    });

    it("bindTo ties the change log to the transaction's session too", async () => {
      const session = { id: "session-1" } as unknown as ClientSession;

      await tracked.withSession(session).insert({ name: "delta" });

      // The log line is written through the same session: if the transaction
      // rolls back, it disappears with it.
      const writes = db.calls.filter((call) => call.operation === "insertOne:AUDIT_LOG");
      expect(writes).toHaveLength(1);
      expect(writes[0].session).toBe(session);
    });

    it("the PK reservation stays outside the session, so transactions do not collide", async () => {
      // Two transactions incrementing the same counter document would block each
      // other; and an Oracle sequence does not give the number back on a rollback
      // either, so leaving a gap is the expected behaviour.
      const session = { id: "session-1" } as unknown as ClientSession;

      await tracked.withSession(session).insert({ name: "delta" });

      const counterCalls = db.calls.filter((call) => call.operation.endsWith(":_counters"));
      expect(counterCalls.length).toBeGreaterThan(0);
      expect(counterCalls.every((call) => call.session === undefined)).toBe(true);
    });
  });
});
