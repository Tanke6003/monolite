// Contract suite for `IGenericRepository<T>`.
//
// It is not a test in itself: it is the same set of assertions that **any**
// implementation must pass, whether it is backed by SQL, by documents or by an
// array. Each driver invokes it with a factory, and that way the central promise
// of this package —"every engine behaves the same"— is verified instead of just
// promised in a README.
//
// It is shipped as part of the public API so that a consumer writing their own
// driver can point this suite at it and know immediately whether it really
// honours the contract.
//
// It only covers behaviour observable through the contract. Whatever is specific
// to an engine (which SQL is generated, how a PK comes back) belongs in that
// engine's own test.
//
// It expects the Jest globals (`describe`, `it`, `expect`, `beforeEach`,
// `afterAll`) to be in scope, so it must be imported from a test file run by
// Jest — or by any runner that provides the same globals.
import type { IGenericRepository } from "../contracts/generic-repository.js";
import { defineEntity } from "../metadata/entity-metadata.js";

/** Minimal entity the suite needs in order to operate. */
export interface ContractItem {
  pkItem: number;
  name: string;
  qty: number;
  /** A `decimal`, which is the one kind the engines disagree about on their own. */
  price?: number | null;
  tag?: string | null;
  active?: boolean;
}

/**
 * Entity for the suite, following the package convention: auto-increment PK and
 * a soft-delete column. It lives here so that every driver can import it without
 * dragging in someone else's test.
 */
export const CONTRACT_ENTITY = defineEntity<ContractItem>({
  table: "CONTRACT_ITEMS",
  primaryKey: "pkItem",
  identity: true,
  columns: {
    pkItem: { name: "PK_ITEM", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string" },
    qty: { name: "QTY", kind: "number" },
    price: { name: "PRICE", kind: "decimal", precision: 12, scale: 2 },
    tag: { name: "TAG", kind: "string" },
    active: { name: "ACTIVE", kind: "boolean" },
  },
  softDelete: { property: "active", activeValue: 1, deletedValue: 0 },
});

export interface ContractSetup {
  /** An empty, isolated repository for each test. */
  create(): Promise<IGenericRepository<ContractItem>> | IGenericRepository<ContractItem>;
  /** Runs at the end, in case the driver has something to close. */
  teardown?(): Promise<void> | void;
}

export function runGenericRepositoryContract(driver: string, setup: ContractSetup): void {
  describe(`IGenericRepository contract — ${driver}`, () => {
    let repository: IGenericRepository<ContractItem>;

    const seed = async () => {
      await repository.insert({ name: "alpha", qty: 10, tag: "x" });
      await repository.insert({ name: "beta", qty: 20, tag: null });
      await repository.insert({ name: "gamma", qty: 30, tag: "y" });
    };

    const names = async (where?: Parameters<typeof repository.count>[0]) =>
      (await repository.find({ where, orderBy: { field: "pkItem" } })).map((i) => i.name);

    beforeEach(async () => {
      repository = await setup.create();
    });

    afterAll(async () => {
      await setup.teardown?.();
    });

    // ==============================================================  writes  ==
    describe("insert", () => {
      it("returns the entity with the PK already assigned", async () => {
        const created = await repository.insert({ name: "alpha", qty: 1 });

        expect(created.pkItem).toEqual(expect.any(Number));
        expect(created.name).toBe("alpha");
      });

      it("assigns a different PK to each insert", async () => {
        const one = await repository.insert({ name: "one", qty: 1 });
        const two = await repository.insert({ name: "two", qty: 2 });

        expect(one.pkItem).not.toBe(two.pkItem);
      });

      it("an insert with no data is an error, not an empty row", async () => {
        await expect(repository.insert({})).rejects.toThrow();
      });

      it("the bulk insert returns how many rows went in", async () => {
        expect(await repository.insertMany([{ name: "a" }, { name: "b" }])).toBe(2);
        expect(await repository.count()).toBe(2);
      });
    });

    // A `decimal` is the one kind where the engines answer differently left to
    // themselves: PostgreSQL and Oracle hand a NUMERIC back as a string because
    // a double cannot always hold it, the in-memory driver hands back whatever
    // double it was given, and a column with two decimals quietly drops the
    // third on one engine and refuses it on another. The mapping is supposed to
    // settle all of that, and this is where it is held to it.
    describe("decimal columns", () => {
      it("comes back a number, whatever the engine hands over", async () => {
        const { pkItem } = await repository.insert({ name: "a", price: 19.99 });
        const read = await repository.getById(pkItem);

        expect(typeof read?.price).toBe("number");
        expect(read?.price).toBe(19.99);
      });

      it("rounds to the declared scale on the way in", async () => {
        const { pkItem } = await repository.insert({ name: "a", price: 10.005 });

        expect((await repository.getById(pkItem))?.price).toBe(10.01);
      });

      it("does not store the dust a float sum leaves behind", async () => {
        const { pkItem } = await repository.insert({ name: "a", price: 0.1 + 0.2 });

        expect((await repository.getById(pkItem))?.price).toBe(0.3);
      });

      it("rounds an update the same way it rounds an insert", async () => {
        const { pkItem } = await repository.insert({ name: "a", price: 1 });
        await repository.update(pkItem, { price: 2.345 });

        expect((await repository.getById(pkItem))?.price).toBe(2.35);
      });

      it("keeps null a null rather than a zero", async () => {
        const { pkItem } = await repository.insert({ name: "a", price: null });

        expect((await repository.getById(pkItem))?.price ?? null).toBeNull();
      });

      it("filters and sorts on it like any other number", async () => {
        await repository.insert({ name: "cheap", price: 5.5 });
        await repository.insert({ name: "dear", price: 100.25 });

        const found = await repository.find({
          where: { price: { gte: 10 } },
          orderBy: { field: "price", direction: "desc" },
        });

        expect(found.map((item) => item.name)).toEqual(["dear"]);
        expect(await repository.count({ price: { lt: 10 } })).toBe(1);
      });
    });

    describe("reads", () => {
      beforeEach(seed);

      it("getById returns the row, or null if it does not exist", async () => {
        const [first] = await repository.find({ orderBy: { field: "pkItem" }, take: 1 });

        expect(await repository.getById(first.pkItem)).toMatchObject({ name: "alpha" });
        expect(await repository.getById(999999)).toBeNull();
      });

      it("counts and checks existence with a filter", async () => {
        expect(await repository.count()).toBe(3);
        expect(await repository.count({ qty: { gte: 20 } })).toBe(2);
        expect(await repository.exists({ name: "alpha" })).toBe(true);
        expect(await repository.exists({ name: "zzz" })).toBe(false);
      });

      it("firstOrDefault returns null when there are no matches", async () => {
        expect(await repository.firstOrDefault({ where: { name: "zzz" } })).toBeNull();
      });

      it("sorts in both directions", async () => {
        const asc = await repository.find({ orderBy: { field: "qty", direction: "asc" } });
        const desc = await repository.find({ orderBy: { field: "qty", direction: "desc" } });

        expect(asc.map((i) => i.qty)).toEqual([10, 20, 30]);
        expect(desc.map((i) => i.qty)).toEqual([30, 20, 10]);
      });

      it("applies skip and take", async () => {
        const rows = await repository.find({ orderBy: { field: "qty" }, skip: 1, take: 1 });

        expect(rows.map((i) => i.name)).toEqual(["beta"]);
      });

      it("paginates with coherent totals", async () => {
        const page = await repository.getPaged(2, 2, { orderBy: { field: "qty" } });

        expect(page).toMatchObject({ total: 3, page: 2, limit: 2, pages: 2 });
        expect(page.items.map((i) => i.name)).toEqual(["gamma"]);
      });

      it("projects only the requested properties", async () => {
        const [item] = await repository.find({ select: ["name"], take: 1 });

        expect(item.name).toEqual(expect.any(String));
        expect(item.qty).toBeUndefined();
      });

      it("rejects a property that is not mapped", async () => {
        await expect(repository.find({ where: { nope: 1 } as never })).rejects.toThrow();
      });
    });

    // =============================================================  filters  ==
    describe("filter language", () => {
      beforeEach(seed);

      it("direct equality", async () => {
        expect(await names({ name: "beta" })).toEqual(["beta"]);
      });

      it("comparators", async () => {
        expect(await names({ qty: { gt: 10, lte: 20 } })).toEqual(["beta"]);
        expect(await names({ qty: { lt: 20 } })).toEqual(["alpha"]);
        expect(await names({ qty: { ne: 20 } })).toEqual(["alpha", "gamma"]);
        expect(await names({ qty: { gte: 30 } })).toEqual(["gamma"]);
      });

      it("between, in and notIn", async () => {
        expect(await names({ qty: { between: [10, 20] } })).toEqual(["alpha", "beta"]);
        expect(await names({ qty: { in: [10, 30] } })).toEqual(["alpha", "gamma"]);
        expect(await names({ qty: { notIn: [10, 30] } })).toEqual(["beta"]);
      });

      // An empty list cannot match anything; the case slips in easily when
      // building filters dynamically.
      it("an empty list returns nothing", async () => {
        expect(await names({ qty: { in: [] } })).toEqual([]);
      });

      it("nulls, with a literal null and with isNull", async () => {
        expect(await names({ tag: null })).toEqual(["beta"]);
        expect(await names({ tag: { isNull: true } })).toEqual(["beta"]);
        expect(await names({ tag: { isNull: false } })).toEqual(["alpha", "gamma"]);
      });

      it("like is case-sensitive and ilike is not", async () => {
        expect(await names({ name: { like: "%LPH%" } })).toEqual([]);
        expect(await names({ name: { ilike: "%LPH%" } })).toEqual(["alpha"]);
      });

      describe("contains", () => {
        it("searches for a substring ignoring case", async () => {
          expect(await names({ name: { contains: "LPH" } })).toEqual(["alpha"]);
          expect(await names({ name: { contains: "a" } })).toEqual(["alpha", "beta", "gamma"]);
        });

        // The reason this operator exists: with `ilike` the text is a pattern,
        // so these three cases would return results nobody asked for.
        it("treats wildcards as text, not as a pattern", async () => {
          await repository.insert({ name: "100% wool", qty: 1 });
          await repository.insert({ name: "a_b", qty: 2 });

          // With ilike, "%" would match everything.
          expect(await names({ name: { contains: "%" } })).toEqual(["100% wool"]);
          expect(await names({ name: { contains: "100%" } })).toEqual(["100% wool"]);
          // With ilike, "_" is any character and this would match "alpha".
          expect(await names({ name: { contains: "a_b" } })).toEqual(["a_b"]);
        });

        it("treats the escape character as text", async () => {
          await repository.insert({ name: "sign !", qty: 3 });

          expect(await names({ name: { contains: "!" } })).toEqual(["sign !"]);
        });

        it("does not match a null value", async () => {
          expect(await names({ tag: { contains: "x" } })).toEqual(["alpha"]);
        });
      });

      it("combines groups with $and, $or and $not", async () => {
        expect(await names({ $or: [{ name: "alpha" }, { qty: 30 }] })).toEqual(["alpha", "gamma"]);
        expect(await names({ $and: [{ qty: { gte: 20 } }, { tag: { isNull: false } }] })).toEqual([
          "gamma",
        ]);
        expect(await names({ $not: { qty: 20 } })).toEqual(["alpha", "gamma"]);
      });
    });

    // ==============================================================  update  ==
    describe("update", () => {
      beforeEach(seed);

      it("updates only what was sent and returns the result", async () => {
        const [item] = await repository.find({ orderBy: { field: "pkItem" }, take: 1 });
        const updated = await repository.update(item.pkItem, { name: "alpha2" });

        expect(updated).toMatchObject({ name: "alpha2", qty: 10 });
      });

      it("returns null when updating something that does not exist", async () => {
        expect(await repository.update(999999, { name: "x" })).toBeNull();
      });

      it("ignores the PK that comes in the body", async () => {
        const [item] = await repository.find({ orderBy: { field: "pkItem" }, take: 1 });
        const updated = await repository.update(item.pkItem, { pkItem: 987654, name: "x" });

        expect(updated?.pkItem).toBe(item.pkItem);
      });

      it("updateWhere reaches every matching row", async () => {
        expect(await repository.updateWhere({ qty: { gte: 20 } }, { tag: "z" })).toBe(2);
        expect(await repository.count({ tag: "z" })).toBe(2);
      });
    });

    // =============================================================  deletes  ==
    describe("soft delete", () => {
      beforeEach(seed);

      it("hides the row but keeps it", async () => {
        const [item] = await repository.find({ orderBy: { field: "pkItem" }, take: 1 });

        expect(await repository.softDelete(item.pkItem)).toBe(true);
        expect(await repository.getById(item.pkItem)).toBeNull();
        expect(await repository.getById(item.pkItem, { withDeleted: true })).not.toBeNull();
        expect(await repository.count()).toBe(2);
        expect(await repository.count(undefined, true)).toBe(3);
      });

      // Deleting twice must not pretend it did something the second time.
      it("is idempotent", async () => {
        const [item] = await repository.find({ orderBy: { field: "pkItem" }, take: 1 });

        expect(await repository.softDelete(item.pkItem)).toBe(true);
        expect(await repository.softDelete(item.pkItem)).toBe(false);
      });

      it("restore reverts it, and does not repeat either", async () => {
        const [item] = await repository.find({ orderBy: { field: "pkItem" }, take: 1 });
        await repository.softDelete(item.pkItem);

        expect(await repository.restore(item.pkItem)).toBe(true);
        expect(await repository.restore(item.pkItem)).toBe(false);
        expect(await repository.getById(item.pkItem)).not.toBeNull();
      });

      it("returns false if the row does not exist", async () => {
        expect(await repository.softDelete(999999)).toBe(false);
        expect(await repository.restore(999999)).toBe(false);
      });

      it("a soft-deleted row cannot be updated", async () => {
        const [item] = await repository.find({ orderBy: { field: "pkItem" }, take: 1 });
        await repository.softDelete(item.pkItem);

        expect(await repository.update(item.pkItem, { name: "x" })).toBeNull();
      });
    });

    describe("hard delete", () => {
      beforeEach(seed);

      it("removes the row for real", async () => {
        const [item] = await repository.find({ orderBy: { field: "pkItem" }, take: 1 });

        expect(await repository.hardDelete(item.pkItem)).toBe(true);
        expect(await repository.hardDelete(item.pkItem)).toBe(false);
        expect(await repository.count(undefined, true)).toBe(2);
      });

      // If it did not reach the soft-deleted ones it would leave orphan rows
      // pointing by foreign key at something that is no longer there.
      it("hardDeleteWhere also reaches the soft-deleted rows", async () => {
        const [item] = await repository.find({ orderBy: { field: "pkItem" }, take: 1 });
        await repository.softDelete(item.pkItem);

        expect(await repository.hardDeleteWhere({ qty: { lte: 20 } })).toBe(2);
        expect(await repository.count(undefined, true)).toBe(1);
      });
    });

    // ======================================================  chainable API  ==
    describe("chainable query()", () => {
      beforeEach(seed);

      it("accumulates filters with AND and sorts", async () => {
        const rows = await repository
          .query()
          .where({ qty: { gte: 10 } })
          .where({ tag: { isNull: false } })
          .orderByDescending("qty")
          .toList();

        expect(rows.map((i) => i.name)).toEqual(["gamma", "alpha"]);
      });

      it("count, any and firstOrDefault", async () => {
        expect(await repository.query().where({ qty: { gte: 20 } }).count()).toBe(2);
        expect(await repository.query().where({ name: "zzz" }).any()).toBe(false);
        expect(
          await repository.query().where({ name: "beta" }).firstOrDefault()
        ).toMatchObject({ name: "beta" });
      });

      it("toPagedList returns the page with its totals", async () => {
        const page = await repository.query().orderBy("qty").toPagedList(1, 2);

        expect(page).toMatchObject({ total: 3, page: 1, limit: 2, pages: 2 });
        expect(page.items).toHaveLength(2);
      });
    });
  });
}
