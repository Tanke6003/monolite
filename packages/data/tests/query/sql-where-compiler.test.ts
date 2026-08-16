import { EntitySchema, SqlWhereCompiler } from "@monolite/data";
import { ITestItem, TEST_ENTITY } from "../support/test-entity";

const schema = new EntitySchema<ITestItem>(TEST_ENTITY);
const compile = (filter: Parameters<SqlWhereCompiler<ITestItem>["compile"]>[0], prefix?: string) =>
  new SqlWhereCompiler<ITestItem>(schema, prefix).compile(filter);

describe("SqlWhereCompiler", () => {
  it("generates no clause when there is no filter", () => {
    expect(compile(undefined)).toEqual({ sql: "", binds: {} });
    expect(compile({}).sql).toBe("");
  });

  it("a bare value is an equality with a bind", () => {
    expect(compile({ name: "alpha" })).toEqual({ sql: "NAME = :w0", binds: { w0: "alpha" } });
  });

  it("a literal null is translated to IS NULL", () => {
    expect(compile({ tag: null })).toEqual({ sql: "TAG IS NULL", binds: {} });
  });

  it.each([
    ["eq", "QTY = :w0"],
    ["ne", "QTY <> :w0"],
    ["gt", "QTY > :w0"],
    ["gte", "QTY >= :w0"],
    ["lt", "QTY < :w0"],
    ["lte", "QTY <= :w0"],
  ])("translates the %s operator", (operator, expected) => {
    expect(compile({ qty: { [operator]: 5 } } as never).sql).toBe(expected);
  });

  it("eq/ne against null use IS NULL / IS NOT NULL", () => {
    expect(compile({ tag: { eq: null } }).sql).toBe("TAG IS NULL");
    expect(compile({ tag: { ne: null } }).sql).toBe("TAG IS NOT NULL");
  });

  it("like, notLike and ilike", () => {
    expect(compile({ name: { like: "a%" } }).sql).toBe("NAME LIKE :w0");
    expect(compile({ name: { notLike: "a%" } }).sql).toBe("NAME NOT LIKE :w0");
    // ilike normalises both sides so as not to depend on the collation.
    expect(compile({ name: { ilike: "a%" } }).sql).toBe("UPPER(NAME) LIKE UPPER(:w0)");
  });

  describe("contains", () => {
    it("wraps the text in wildcards and declares the escape character", () => {
      const result = compile({ name: { contains: "ana" } });

      expect(result.sql).toBe("UPPER(NAME) LIKE UPPER(:w0) ESCAPE '!'");
      expect(result.binds).toEqual({ w0: "%ana%" });
    });

    it("neutralises the wildcards that arrive inside the text", () => {
      // Without escaping, `100%` would search for "starts with 100" and `a_b`
      // would match `axb`: both are ordinary input from a form.
      expect(compile({ name: { contains: "100%" } }).binds).toEqual({ w0: "%100!%%" });
      expect(compile({ name: { contains: "a_b" } }).binds).toEqual({ w0: "%a!_b%" });
    });

    it("escapes the escape character itself as well", () => {
      expect(compile({ name: { contains: "!" } }).binds).toEqual({ w0: "%!!%" });
    });

    it("the value still travels as a bind, never inside the SQL", () => {
      const result = compile({ name: { contains: "'; DROP TABLE ITEMS; --" } });

      expect(result.sql).toBe("UPPER(NAME) LIKE UPPER(:w0) ESCAPE '!'");
      expect(result.sql).not.toContain("DROP");
    });
  });

  it("in and notIn generate one bind per element", () => {
    const result = compile({ qty: { in: [1, 2, 3] } });

    expect(result.sql).toBe("QTY IN (:w0, :w1, :w2)");
    expect(result.binds).toEqual({ w0: 1, w1: 2, w2: 3 });
    expect(compile({ qty: { notIn: [1] } }).sql).toBe("QTY NOT IN (:w0)");
  });

  it("an empty list becomes a constant condition instead of an invalid IN ()", () => {
    expect(compile({ qty: { in: [] } }).sql).toBe("1 = 0");
    expect(compile({ qty: { notIn: [] } }).sql).toBe("1 = 1");
  });

  it("between and isNull", () => {
    expect(compile({ qty: { between: [1, 9] } }).sql).toBe("QTY BETWEEN :w0 AND :w1");
    expect(compile({ tag: { isNull: true } }).sql).toBe("TAG IS NULL");
    expect(compile({ tag: { isNull: false } }).sql).toBe("TAG IS NOT NULL");
  });

  it("several operators on the same field are grouped with AND", () => {
    expect(compile({ qty: { gte: 1, lte: 9 } }).sql).toBe("(QTY >= :w0 AND QTY <= :w1)");
  });

  it("several fields are joined with AND", () => {
    expect(compile({ name: "a", qty: 1 }).sql).toBe("NAME = :w0 AND QTY = :w1");
  });

  it("$and, $or and $not nest groups", () => {
    expect(compile({ $and: [{ name: "a" }, { qty: 1 }] }).sql).toBe("(NAME = :w0 AND QTY = :w1)");
    expect(compile({ $or: [{ name: "a" }, { qty: 1 }] }).sql).toBe("(NAME = :w0 OR QTY = :w1)");
    expect(compile({ $not: { name: "a" } }).sql).toBe("NOT (NAME = :w0)");
  });

  it("empty groups do not dirty the SQL", () => {
    expect(compile({ $and: [] }).sql).toBe("");
    expect(compile({ $or: [{}] }).sql).toBe("");
    expect(compile({ $not: {} }).sql).toBe("");
  });

  it("ignores keys whose value is undefined", () => {
    expect(compile({ name: undefined, qty: 1 }).sql).toBe("QTY = :w0");
  });

  it("converts booleans to the column's 1/0", () => {
    expect(compile({ flag: true }).binds).toEqual({ w0: 1 });
    expect(compile({ flag: false }).binds).toEqual({ w0: 0 });
  });

  it("the prefix keeps the WHERE binds from colliding with the SET ones", () => {
    expect(compile({ name: "a" }, "z")).toEqual({ sql: "NAME = :z0", binds: { z0: "a" } });
  });

  it("rejects an unmapped property, which is what stops an identifier being injected", () => {
    expect(() => compile({ "NAME; DROP TABLE ITEMS": 1 } as never)).toThrow(/is not mapped/);
  });
});
