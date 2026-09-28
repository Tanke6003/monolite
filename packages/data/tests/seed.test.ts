import { defineEntity, MemoryGenericRepository, seed } from "monolite-data";

/**
 * Reference data the way an application declares it: a code it refers to the
 * row by, a label, an order — and a primary key the identity column hands out,
 * which the seed must not depend on.
 */
interface ISection {
  pkSection: number;
  code: string;
  name: string;
  position?: number | null;
  publishedAt?: Date | null;
  active?: boolean;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

const SECTION_ENTITY = defineEntity<ISection>({
  table: "SECTIONS",
  primaryKey: "pkSection",
  identity: true,
  columns: {
    pkSection: { name: "PK_SECTION", kind: "number", insertable: false, updatable: false },
    code: { name: "CODE", kind: "string" },
    name: { name: "NAME", kind: "string" },
    position: { name: "POSITION", kind: "number" },
    publishedAt: { name: "PUBLISHED_AT", kind: "date" },
    active: { name: "ACTIVE", kind: "boolean" },
    createdAt: { name: "CREATED_AT", kind: "date", updatable: false },
    updatedAt: { name: "UPDATED_AT", kind: "date" },
  },
  softDelete: { property: "active", activeValue: 1, deletedValue: 0 },
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
});

const SECTIONS: Partial<ISection>[] = [
  { code: "payments", name: "Payments", position: 1 },
  { code: "reports", name: "Reports", position: 2 },
];

describe("seed", () => {
  let sections: MemoryGenericRepository<ISection>;

  beforeEach(() => {
    sections = new MemoryGenericRepository<ISection>(SECTION_ENTITY);
  });

  it("inserts every declared row into an empty table", async () => {
    const report = await seed(sections, { key: "code" }, SECTIONS);

    expect(report).toMatchObject({ inserted: 2, updated: 0, unchanged: 0, skipped: 0 });
    expect(report.summary).toBe("2 inserted, 0 updated, 0 unchanged");
    expect((await sections.getAll()).map((row) => row.code).sort()).toEqual([
      "payments",
      "reports",
    ]);
  });

  /**
   * The property the whole primitive exists for, stated as strictly as the
   * issue asks: not just the same rows, the same *bytes*. A second run that
   * issued an `UPDATE` setting every column to the value it already had would
   * still pass a row-count check and would still move `updatedAt` — which is
   * precisely what makes a hand-written seed noisy in the change log.
   */
  it("reports a second run over the same input as 0 inserted, 0 updated, and writes nothing", async () => {
    await seed(sections, { key: "code" }, SECTIONS);
    const before = JSON.stringify(sections.snapshot());

    const report = await seed(sections, { key: "code" }, SECTIONS);

    expect(report).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(report.summary).toBe("0 inserted, 0 updated, 2 unchanged");
    expect(report.changes).toEqual([]);
    expect(JSON.stringify(sections.snapshot())).toBe(before);
  });

  /**
   * The other half of "declared state": somebody edited a row in the database
   * by hand, and the next deploy puts the declared value back. It has to *say*
   * so, naming the row and the field — silently undoing somebody's edit is how
   * a seed earns a reputation for eating data.
   */
  it("restores a value changed by hand in the database, and says which row and field", async () => {
    await seed(sections, { key: "code" }, SECTIONS);
    await sections.updateWhere({ code: "payments" }, { name: "Pagos (edited)" });

    const report = await seed(sections, { key: "code" }, SECTIONS);

    expect(report).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
    expect(report.changes).toEqual([
      { action: "updated", key: { code: "payments" }, fields: ["name"] },
    ]);
    expect(report.summary).toBe("0 inserted, 1 updated (payments: name), 1 unchanged");

    const restored = await sections.firstOrDefault({ where: { code: "payments" } });
    expect(restored?.name).toBe("Payments");
  });

  it("inserts only what is missing when the list grows", async () => {
    await seed(sections, { key: "code" }, SECTIONS);

    const report = await seed(sections, { key: "code" }, [
      ...SECTIONS,
      { code: "audit", name: "Audit", position: 3 },
    ]);

    expect(report).toMatchObject({ inserted: 1, updated: 0, unchanged: 2 });
    expect(report.changes).toEqual([{ action: "inserted", key: { code: "audit" }, fields: [] }]);
  });

  /**
   * What was not declared is not the seed's business. A column the application
   * maintains —here `position`, reordered by an administrator— must survive a
   * deploy whose seed does not mention it; otherwise every deploy resets it.
   */
  it("leaves alone the properties a row does not declare", async () => {
    await seed(sections, { key: "code" }, SECTIONS);
    await sections.updateWhere({ code: "reports" }, { position: 9 });

    const report = await seed(sections, { key: "code" }, [
      { code: "payments", name: "Payments" },
      { code: "reports", name: "Reports" },
    ]);

    expect(report).toMatchObject({ updated: 0, unchanged: 2 });
    expect((await sections.firstOrDefault({ where: { code: "reports" } }))?.position).toBe(9);
  });

  /**
   * A shorter list is not an instruction to delete. Reference data is pointed
   * at by foreign keys, and removing it is a decision for a migration somebody
   * reads — not a side effect of an edit to an array.
   */
  it("never deletes a row that is no longer in the list", async () => {
    await seed(sections, { key: "code" }, SECTIONS);

    await seed(sections, { key: "code" }, [SECTIONS[0]]);

    expect(await sections.count()).toBe(2);
  });

  /**
   * A soft-deleted row is hidden from reads, so a naive "not found, insert"
   * would create a twin next to it (or break the unique index the key should
   * have). It is left alone and counted, because somebody retired it on
   * purpose and a deploy should not overrule them.
   */
  it("leaves a soft-deleted row deleted rather than inserting a twin beside it", async () => {
    await seed(sections, { key: "code" }, SECTIONS);
    const payments = await sections.firstOrDefault({ where: { code: "payments" } });
    await sections.softDelete(payments!.pkSection);

    const report = await seed(sections, { key: "code" }, SECTIONS);

    expect(report).toMatchObject({ inserted: 0, updated: 0, unchanged: 1, skipped: 1 });
    expect(report.summary).toBe("0 inserted, 0 updated, 1 unchanged, 1 skipped (soft-deleted)");
    expect(await sections.count(undefined, true)).toBe(2);
  });

  it("matches on a composite key", async () => {
    const rows: Partial<ISection>[] = [
      { code: "payments", position: 1, name: "Payments (1)" },
      { code: "payments", position: 2, name: "Payments (2)" },
    ];

    await seed(sections, { key: ["code", "position"] }, rows);
    const report = await seed(sections, { key: ["code", "position"] }, [
      rows[0],
      { ...rows[1], name: "Payments (two)" },
    ]);

    expect(report).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
    expect(report.changes[0]).toEqual({
      action: "updated",
      key: { code: "payments", position: 2 },
      fields: ["name"],
    });
  });

  /**
   * Dates come back from a store as new objects every time, and an optional
   * column comes back as `null` where the declaration left it out. Neither is a
   * change; reporting them as one would make every run "update" every row.
   */
  it("treats an equal date and a null-versus-undefined as unchanged", async () => {
    const stamped = {
      code: "x",
      name: "X",
      position: null,
      publishedAt: new Date("2026-01-01T00:00:00Z"),
    };
    await seed(sections, { key: "code" }, [stamped]);

    const report = await seed(sections, { key: "code" }, [
      { ...stamped, position: undefined, publishedAt: new Date("2026-01-01T00:00:00Z") },
    ]);

    expect(report).toMatchObject({ updated: 0, unchanged: 1 });
  });

  /**
   * Mistakes in the list are caught before a single statement runs: a row with
   * no key would match on `undefined`, and two rows with the same key would
   * overwrite each other on every run for as long as nobody noticed.
   */
  it("refuses a list with a row missing its key, or two rows sharing one", async () => {
    await expect(seed(sections, { key: "code" }, [{ name: "No code" }])).rejects.toThrow(
      "row 0 has no value for its key (code)"
    );

    await expect(
      seed(sections, { key: "code" }, [
        { code: "payments", name: "A" },
        { code: "payments", name: "B" },
      ])
    ).rejects.toThrow("row 1 repeats the key payments");

    expect(await sections.count(undefined, true)).toBe(0);
  });
});
