import { defineEntity, EntitySchema, oracleDialect, SqlWhereCompiler } from "monolite-data";

interface IInvoice {
  pkInvoice: number;
  dueOn: string;
  createdAt: Date;
}

const INVOICE = defineEntity<IInvoice>({
  table: "INVOICES",
  primaryKey: "pkInvoice",
  identity: true,
  columns: {
    pkInvoice: { name: "PK_INVOICE", kind: "number", insertable: false, updatable: false },
    dueOn: { name: "DUE_ON", kind: "day" },
    createdAt: { name: "CREATED_AT", kind: "datetime" },
  },
});

const schema = new EntitySchema<IInvoice>(INVOICE);

// Each check below can only fail in some timezones, and which one is a property
// of the process: Jest hands a test a copy of `process.env`, so assigning `TZ`
// here would change nothing. CI runs this suite under three — see `ci.yml`.

describe("a day column", () => {
  describe("on the way to the database", () => {
    it("travels as its text", () => {
      expect(schema.toColumnValue("dueOn", "2026-04-30")).toBe("2026-04-30");
    });

    it("reads a Date by the UTC day it was parsed from", () => {
      expect(schema.toColumnValue("dueOn", new Date("2026-04-30"))).toBe("2026-04-30");
    });

    it("refuses what is not a day instead of binding a guess", () => {
      expect(() => schema.toColumnValue("dueOn", "2026-02-30")).toThrow(/2026-02-30/);
      expect(() => schema.toColumnValue("dueOn", "30/04/2026")).toThrow();
    });

    it("keeps null a null", () => {
      expect(schema.toColumnValue("dueOn", null)).toBeNull();
    });
  });

  describe("on the way back", () => {
    it("keeps the text PostgreSQL, MySQL and SQL Server hand over", () => {
      expect(schema.toEntityValue("dueOn", "2026-04-30")).toBe("2026-04-30");
    });

    it("reads Oracle's Date by the local fields the driver built it from", () => {
      // What node-oracledb returns for a DATE holding 2026-04-30.
      const fetched = new Date(2026, 3, 30);
      expect(schema.toEntityValue("dueOn", fetched)).toBe("2026-04-30");
    });
  });

  it("is normalised by quantize too, which is what the memory driver stores", () => {
    expect(schema.quantize("dueOn", new Date("2026-04-30"))).toBe("2026-04-30");
    expect(() => schema.quantize("dueOn", "tomorrow")).toThrow();
  });

  it("tells the dialect the bind is a day, so Oracle can bind it as one", () => {
    const { binds } = new SqlWhereCompiler<IInvoice>(schema, "w", oracleDialect.toBindValue).compile({
      dueOn: { lte: "2026-04-30" },
    });

    expect(binds.w0).toBeInstanceOf(Date);
  });
});

describe("a datetime column", () => {
  it("is the instant it always was", () => {
    const instant = new Date("2026-04-30T15:00:00.000Z");

    expect(schema.toColumnValue("createdAt", instant)).toBe(instant);
    expect(schema.toEntityValue("createdAt", "2026-04-30T15:00:00.000Z")).toEqual(instant);
  });
});
