import { defineEntity, EntitySchema } from "monolite-data";

interface IInvoice {
  pkInvoice: number;
  amount: number;
  rate: number;
  qty: number;
}

const INVOICE = defineEntity<IInvoice>({
  table: "INVOICES",
  primaryKey: "pkInvoice",
  identity: true,
  columns: {
    pkInvoice: { name: "PK_INVOICE", kind: "number", insertable: false, updatable: false },
    amount: { name: "AMOUNT", kind: "decimal", precision: 12, scale: 2 },
    // Four decimals, to show the scale is read and not assumed.
    rate: { name: "RATE", kind: "decimal", precision: 9, scale: 4 },
    qty: { name: "QTY", kind: "number" },
  },
});

const schema = new EntitySchema<IInvoice>(INVOICE);

describe("a decimal column", () => {
  it("keeps two decimals unless the mapping says otherwise", () => {
    expect(schema.scaleOf("amount")).toBe(2);
    expect(schema.scaleOf("rate")).toBe(4);
  });

  describe("on the way to the database", () => {
    it("rounds to the declared scale", () => {
      expect(schema.toColumnValue("amount", 10.005)).toBe(10.01);
      expect(schema.toColumnValue("amount", 1.4999)).toBe(1.5);
      expect(schema.toColumnValue("rate", 0.123456)).toBe(0.1235);
    });

    it("clears the dust a float sum leaves behind", () => {
      expect(schema.toColumnValue("amount", 0.1 + 0.2)).toBe(0.3);
    });

    it("leaves a null a null", () => {
      expect(schema.toColumnValue("amount", null)).toBeNull();
      expect(schema.toColumnValue("amount", undefined)).toBeNull();
    });
  });

  describe("on the way back", () => {
    it("turns the string PostgreSQL and Oracle hand back into a number", () => {
      // A NUMERIC comes back as text from both, precisely because a double
      // cannot always hold it. The entity asked for a number.
      expect(schema.toEntityValue("amount", "19.99")).toBe(19.99);
      expect(typeof schema.toEntityValue("amount", "19.99")).toBe("number");
    });

    it("rounds what the double could not represent", () => {
      expect(schema.toEntityValue("amount", "19.989999999999998")).toBe(19.99);
      expect(schema.toEntityValue("rate", "0.12345")).toBe(0.1235);
    });

    it("leaves a null a null rather than a zero", () => {
      expect(schema.toEntityValue("amount", null)).toBeNull();
    });
  });

  describe("quantize", () => {
    it("rounds a decimal property and nothing else", () => {
      expect(schema.quantize("amount", 10.005)).toBe(10.01);
      expect(schema.quantize("qty", 10.005)).toBe(10.005);
      expect(schema.quantize("pkInvoice", 1.5)).toBe(1.5);
    });

    it("passes anything it cannot round through untouched", () => {
      // Not the mapping's business to decide what a bad value becomes: the
      // engine rejects it, with its own message, at the line that sent it.
      expect(schema.quantize("amount", "not a number")).toBe("not a number");
      expect(schema.quantize("amount", null)).toBeNull();
      expect(schema.quantize("amount", undefined)).toBeUndefined();
    });
  });

  it("does not touch a plain number", () => {
    // The kinds have to stay distinguishable: `number` is what an id, a count
    // and a foreign key are, and rounding those would be inventing a rule.
    expect(schema.toColumnValue("qty", 10.005)).toBe(10.005);
    expect(schema.toEntityValue("qty", "10.005")).toBe(10.005);
  });
});
