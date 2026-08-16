import { MemoryGenericRepository } from "monolite-data";
import { ITestItem, IPlainItem, PLAIN_ENTITY, SEED, TEST_ENTITY } from "../support/test-entity";

describe("MemoryGenericRepository", () => {
  let repository: MemoryGenericRepository<ITestItem>;

  beforeEach(() => {
    repository = new MemoryGenericRepository<ITestItem>(TEST_ENTITY, SEED);
  });

  // ==============================================================  reads  ===
  describe("reads", () => {
    it("returns the seed with an auto-incremented PK and a creation stamp", async () => {
      const items = await repository.getAll({ orderBy: { field: "pkItem" } });

      expect(items.map((i) => i.pkItem)).toEqual([1, 2, 3]);
      expect(items[0].active).toBe(true);
      expect(items[0].createdAt).toBeInstanceOf(Date);
    });

    it("returns copies, not the entities held in the store", async () => {
      const [item] = await repository.getAll({ take: 1 });
      item.name = "mutated";

      expect((await repository.getById(item.pkItem))?.name).not.toBe("mutated");
    });

    it("getById returns null when the row does not exist", async () => {
      expect(await repository.getById(999)).toBeNull();
    });

    it("projects only the requested columns", async () => {
      const [item] = await repository.find({ select: ["name"], take: 1 });
      expect(Object.keys(item)).toEqual(["name"]);
    });

    it("rejects an unmapped property in the select", async () => {
      await expect(
        repository.find({ select: ["nope" as keyof ITestItem & string] })
      ).rejects.toThrow(/is not mapped/);
    });

    it("sorts ascending and descending", async () => {
      const asc = await repository.find({ orderBy: { field: "qty", direction: "asc" } });
      const desc = await repository.find({ orderBy: { field: "qty", direction: "desc" } });

      expect(asc.map((i) => i.qty)).toEqual([10, 20, 30]);
      expect(desc.map((i) => i.qty)).toEqual([30, 20, 10]);
    });

    it("breaks a tie with the second sort criterion", async () => {
      const rows = await repository.find({
        orderBy: [{ field: "flag" }, { field: "qty", direction: "desc" }],
      });
      expect(rows.map((i) => i.name)).toEqual(["beta", "gamma", "alpha"]);
    });

    it("puts the nulls last, the way Oracle does in ASC", async () => {
      const rows = await repository.find({ orderBy: { field: "tag" } });
      expect(rows[rows.length - 1].tag).toBeNull();
    });

    it("applies skip and take", async () => {
      const rows = await repository.find({ orderBy: { field: "pkItem" }, skip: 1, take: 1 });
      expect(rows.map((i) => i.name)).toEqual(["beta"]);
    });

    it("paginates with totals and a page count", async () => {
      const page = await repository.getPaged(2, 2, { orderBy: { field: "pkItem" } });

      expect(page).toMatchObject({ total: 3, page: 2, limit: 2, pages: 2 });
      expect(page.items.map((i) => i.name)).toEqual(["gamma"]);
    });

    it("normalises an invalid page and limit instead of breaking", async () => {
      const page = await repository.getPaged(0, 0);
      expect(page).toMatchObject({ page: 1, limit: 1 });
    });

    it("count and exists honour the filter", async () => {
      expect(await repository.count({ qty: { gte: 20 } })).toBe(2);
      expect(await repository.exists({ name: "alpha" })).toBe(true);
      expect(await repository.exists({ name: "zzz" })).toBe(false);
    });

    it("firstOrDefault returns null when there are no matches", async () => {
      expect(await repository.firstOrDefault({ where: { name: "zzz" } })).toBeNull();
    });
  });

  // ============================================================  filters  ===
  describe("filters", () => {
    const names = async (where: Parameters<typeof repository.count>[0]) =>
      (await repository.find({ where, orderBy: { field: "pkItem" } })).map((i) => i.name);

    it("direct equality", async () => {
      expect(await names({ name: "beta" })).toEqual(["beta"]);
    });

    it("numeric comparators", async () => {
      expect(await names({ qty: { gt: 10, lte: 20 } })).toEqual(["beta"]);
      expect(await names({ qty: { lt: 20 } })).toEqual(["alpha"]);
      expect(await names({ qty: { ne: 20 } })).toEqual(["alpha", "gamma"]);
    });

    it("between and in / notIn", async () => {
      expect(await names({ qty: { between: [10, 20] } })).toEqual(["alpha", "beta"]);
      expect(await names({ qty: { in: [10, 30] } })).toEqual(["alpha", "gamma"]);
      expect(await names({ qty: { notIn: [10, 30] } })).toEqual(["beta"]);
      expect(await names({ qty: { in: [] } })).toEqual([]);
    });

    it("like is case-sensitive and ilike is not", async () => {
      expect(await names({ name: { like: "%LPH%" } })).toEqual([]);
      expect(await names({ name: { ilike: "%LPH%" } })).toEqual(["alpha"]);
      expect(await names({ name: { like: "b_ta" } })).toEqual(["beta"]);
      expect(await names({ name: { notLike: "alpha" } })).toEqual(["beta", "gamma"]);
    });

    it("nulls, with a literal null and with isNull", async () => {
      expect(await names({ tag: null })).toEqual(["beta"]);
      expect(await names({ tag: { isNull: true } })).toEqual(["beta"]);
      expect(await names({ tag: { isNull: false } })).toEqual(["alpha", "gamma"]);
      expect(await names({ tag: { eq: null } })).toEqual(["beta"]);
      expect(await names({ tag: { ne: null } })).toEqual(["alpha", "gamma"]);
    });

    it("booleans and dates", async () => {
      expect(await names({ flag: true })).toEqual(["alpha", "gamma"]);
      expect(await names({ dueAt: { gte: new Date("2026-02-01T00:00:00Z") } })).toEqual([
        "beta",
        "gamma",
      ]);
    });

    it("combines groups with $and, $or and $not", async () => {
      expect(await names({ $or: [{ name: "alpha" }, { qty: 30 }] })).toEqual(["alpha", "gamma"]);
      expect(await names({ $and: [{ flag: true }, { qty: { gt: 10 } }] })).toEqual(["gamma"]);
      expect(await names({ $not: { flag: true } })).toEqual(["beta"]);
      expect(await names({ $or: [] })).toEqual(["alpha", "beta", "gamma"]);
    });

    it("rejects filtering by an unmapped property", async () => {
      await expect(repository.find({ where: { nope: 1 } as never })).rejects.toThrow(
        /is not mapped/
      );
    });
  });

  // =============================================================  writes  ===
  describe("writes", () => {
    it("inserts assigning the PK, the active flag and createdAt", async () => {
      const created = await repository.insert({ name: "delta", qty: 40 });

      expect(created.pkItem).toBe(4);
      expect(created.active).toBe(true);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(await repository.count()).toBe(4);
    });

    it("rejects an insert with no data, just like the SQL repository", async () => {
      await expect(repository.insert({})).rejects.toThrow(/with no columns to write/);
    });

    it("inserts in bulk", async () => {
      expect(await repository.insertMany([{ name: "d" }, { name: "e" }])).toBe(2);
      expect(await repository.count()).toBe(5);
    });

    it("updates and stamps updatedAt", async () => {
      const updated = await repository.update(1, { name: "alpha2" });

      expect(updated?.name).toBe("alpha2");
      expect(updated?.updatedAt).toBeInstanceOf(Date);
    });

    it("ignores the PK and the non-updatable columns", async () => {
      const before = await repository.getById(1);
      const updated = await repository.update(1, { pkItem: 99, createdAt: new Date(0) });

      expect(updated?.pkItem).toBe(1);
      expect(updated?.createdAt).toEqual(before?.createdAt);
    });

    it("returns null when updating something that does not exist or is already deleted", async () => {
      expect(await repository.update(999, { name: "x" })).toBeNull();

      await repository.softDelete(1);
      expect(await repository.update(1, { name: "x" })).toBeNull();
    });

    it("updateWhere reaches everything that matches", async () => {
      expect(await repository.updateWhere({ flag: true }, { tag: "z" })).toBe(2);
      expect(await repository.count({ tag: "z" })).toBe(2);
    });
  });

  // ============================================================  deletes  ===
  describe("deletes", () => {
    it("the soft delete hides the row but keeps it", async () => {
      expect(await repository.softDelete(1)).toBe(true);

      expect(await repository.getById(1)).toBeNull();
      expect(await repository.getById(1, { withDeleted: true })).not.toBeNull();
      expect(await repository.count()).toBe(2);
      expect(await repository.count(undefined, true)).toBe(3);
    });

    it("is idempotent: deleting twice returns false the second time", async () => {
      await repository.softDelete(1);
      expect(await repository.softDelete(1)).toBe(false);
    });

    it("restore reverts the soft delete and does not repeat itself", async () => {
      await repository.softDelete(1);

      expect(await repository.restore(1)).toBe(true);
      expect(await repository.restore(1)).toBe(false);
      expect(await repository.getById(1)).not.toBeNull();
    });

    it("softDelete/restore return false when the row does not exist", async () => {
      expect(await repository.softDelete(999)).toBe(false);
      expect(await repository.restore(999)).toBe(false);
    });

    it("the hard delete removes the row", async () => {
      expect(await repository.hardDelete(1)).toBe(true);
      expect(await repository.hardDelete(1)).toBe(false);
      expect(await repository.count(undefined, true)).toBe(2);
    });

    it("hardDeleteWhere also reaches the soft-deleted rows", async () => {
      await repository.softDelete(1);

      expect(await repository.hardDeleteWhere({ qty: { lte: 20 } })).toBe(2);
      expect(await repository.count(undefined, true)).toBe(1);
      expect(await repository.hardDeleteWhere({ qty: { gt: 900 } })).toBe(0);
    });

    it("throws when the entity declares no soft delete", async () => {
      const plain = new MemoryGenericRepository<IPlainItem, string>(PLAIN_ENTITY, [
        { code: "A", label: "one" },
      ]);

      await expect(plain.softDelete("A")).rejects.toThrow(/does not declare softDelete/);
    });
  });

  // ====================================================  plain entities  ====
  it("requires the PK when the entity does not use identity", async () => {
    const plain = new MemoryGenericRepository<IPlainItem, string>(PLAIN_ENTITY, []);

    await expect(plain.insert({ label: "no code" })).rejects.toThrow(/the PK is mandatory/);

    const created = await plain.insert({ code: "A", label: "one" });
    expect(created.code).toBe("A");
  });

  // ==========================================================  unit of work ==
  it("snapshot and restoreSnapshot put the store back the way it was", async () => {
    const snapshot = repository.snapshot();

    await repository.insert({ name: "delta" });
    await repository.hardDelete(1);
    repository.restoreSnapshot(snapshot);

    expect((await repository.getAll({ orderBy: { field: "pkItem" } })).map((i) => i.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    // The sequence is restored too: the next insert reuses 4.
    expect((await repository.insert({ name: "new" })).pkItem).toBe(4);
  });
});
