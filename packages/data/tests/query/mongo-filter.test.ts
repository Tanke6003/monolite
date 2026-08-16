import { EntitySchema, toMongoFilter, type WhereFilter } from "@monolite/data";
import { ITestItem, TEST_ENTITY } from "../support/test-entity";

const schema = new EntitySchema<ITestItem>(TEST_ENTITY);
const compile = (filter?: WhereFilter<ITestItem>) => toMongoFilter(filter, schema);

describe("toMongoFilter", () => {
  it("generates no conditions when there is no filter", () => {
    expect(compile(undefined)).toEqual({});
    expect(compile({})).toEqual({});
  });

  it("a bare value is an equality on the mapped field", () => {
    // The document key is the column (NAME), not the property (name): that is
    // what makes the same filter work for Mongo and for the SQL engines.
    expect(compile({ name: "alpha" })).toEqual({ NAME: { $eq: "alpha" } });
  });

  it("a bare null means IS NULL", () => {
    // `$eq: null` also reaches the documents that do not carry the field, which
    // is what a column with no value would be in SQL.
    expect(compile({ tag: null })).toEqual({ TAG: { $eq: null } });
  });

  it.each([
    ["eq", "$eq"],
    ["ne", "$ne"],
    ["gt", "$gt"],
    ["gte", "$gte"],
    ["lt", "$lt"],
    ["lte", "$lte"],
  ])("translates the %s operator to %s", (operator, mongoOperator) => {
    expect(compile({ qty: { [operator]: 5 } } as never)).toEqual({ QTY: { [mongoOperator]: 5 } });
  });

  it("eq/ne against null compare against null, with no special operator", () => {
    expect(compile({ tag: { eq: null } })).toEqual({ TAG: { $eq: null } });
    expect(compile({ tag: { ne: null } })).toEqual({ TAG: { $ne: null } });
  });

  it("isNull resolves to the comparison against null", () => {
    expect(compile({ tag: { isNull: true } })).toEqual({ TAG: { $eq: null } });
    expect(compile({ tag: { isNull: false } })).toEqual({ TAG: { $ne: null } });
  });

  it("like translates the SQL pattern into an anchored regular expression", () => {
    // `%` is anything and `_` a single character; the rest of the pattern is
    // escaped, so a dot typed by the user does not become a regex wildcard.
    expect(compile({ name: { like: "a%" } })).toEqual({ NAME: { $regex: /^a.*$/ } });
    expect(compile({ name: { like: "a_c.d" } })).toEqual({ NAME: { $regex: /^a.c\.d$/ } });
  });

  it("ilike is the same pattern with the case-insensitivity flag", () => {
    expect(compile({ name: { ilike: "%north%" } })).toEqual({ NAME: { $regex: /^.*north.*$/i } });
  });

  describe("contains", () => {
    it("searches for the literal substring, unanchored and ignoring case", () => {
      expect(compile({ name: { contains: "north" } })).toEqual({ NAME: { $regex: /north/i } });
    });

    it("escapes the whole text before it reaches the engine", () => {
      // With `ilike`, this would translate to /^.*.*.*.*.*$/ and would be a
      // pathological regex running inside the MongoDB server. As a literal it is
      // harmless.
      expect(compile({ name: { contains: "%%%%%" } })).toEqual({ NAME: { $regex: /%%%%%/i } });
      expect(compile({ name: { contains: "a.b" } })).toEqual({ NAME: { $regex: /a\.b/i } });
      expect(compile({ name: { contains: "(a|b)+" } })).toEqual({
        NAME: { $regex: /\(a\|b\)\+/i },
      });
    });
  });

  it("notLike negates the regular expression", () => {
    expect(compile({ name: { notLike: "a%" } })).toEqual({ NAME: { $not: /^a.*$/ } });
  });

  it("in and notIn translate to $in and $nin", () => {
    expect(compile({ qty: { in: [1, 2, 3] } })).toEqual({ QTY: { $in: [1, 2, 3] } });
    expect(compile({ qty: { notIn: [1] } })).toEqual({ QTY: { $nin: [1] } });
  });

  it("an empty list in `in` matches nothing", () => {
    // `$in: []` already finds nothing on its own; the constant condition SQL
    // needs in order to avoid an invalid `IN ()` is not required here.
    expect(compile({ qty: { in: [] } })).toEqual({ QTY: { $in: [] } });
    expect(compile({ qty: { notIn: [] } })).toEqual({ QTY: { $nin: [] } });
  });

  it("between opens into its two ends, both inclusive", () => {
    expect(compile({ qty: { between: [1, 9] } })).toEqual({ QTY: { $gte: 1, $lte: 9 } });
  });

  it("several operators on the same field share a document", () => {
    expect(compile({ qty: { gte: 1, lte: 9 } })).toEqual({ QTY: { $gte: 1, $lte: 9 } });
  });

  it("two operators that would share a key are split into separate clauses", () => {
    // `gte` and `between` both produce a `$gte`: in a single object the second
    // would overwrite the first and the condition would be lost silently.
    expect(compile({ qty: { gte: 5, between: [1, 9] } })).toEqual({
      $and: [{ QTY: { $gte: 5, $lte: 9 } }, { QTY: { $gte: 1 } }],
    });
  });

  it("several fields are joined with an explicit $and", () => {
    // Merging them into a single object is avoided: two conditions on the same
    // field would share a key and one would erase the other.
    expect(compile({ name: "a", qty: 1 })).toEqual({
      $and: [{ NAME: { $eq: "a" } }, { QTY: { $eq: 1 } }],
    });
  });

  it("$and nests a group", () => {
    expect(compile({ $and: [{ name: "a" }, { qty: 1 }] })).toEqual({
      $and: [{ NAME: { $eq: "a" } }, { QTY: { $eq: 1 } }],
    });
  });

  it("an $and with a single member adds no wrapper", () => {
    expect(compile({ $and: [{ name: "a" }] })).toEqual({ NAME: { $eq: "a" } });
  });

  it("$or nests an alternative group", () => {
    expect(compile({ $or: [{ name: "a" }, { qty: 1 }] })).toEqual({
      $or: [{ NAME: { $eq: "a" } }, { QTY: { $eq: 1 } }],
    });
  });

  it("$not is expressed with $nor, which is what MongoDB has for negating a group", () => {
    // `$not` only exists inside a field; `$nor` with a single member is its
    // exact document-level equivalent.
    expect(compile({ $not: { name: "a" } })).toEqual({ $nor: [{ NAME: { $eq: "a" } }] });
  });

  it("nested groups keep their structure", () => {
    const filter: WhereFilter<ITestItem> = {
      $and: [{ flag: true }, { $or: [{ name: { ilike: "%a%" } }, { tag: null }] }],
    };

    expect(compile(filter)).toEqual({
      $and: [
        { FLAG: { $eq: 1 } },
        { $or: [{ NAME: { $regex: /^.*a.*$/i } }, { TAG: { $eq: null } }] },
      ],
    });
  });

  it("empty groups do not dirty the query", () => {
    // An `$or: []` would be an error for the server, and a `$nor: [{}]` would
    // negate absolutely everything: a group with no conditions simply adds
    // nothing.
    expect(compile({ $and: [] })).toEqual({});
    expect(compile({ $or: [{}] })).toEqual({});
    expect(compile({ $not: {} })).toEqual({});
  });

  it("ignores keys whose value is undefined", () => {
    expect(compile({ name: undefined, qty: 1 })).toEqual({ QTY: { $eq: 1 } });
  });

  it("converts booleans to the 1/0 they are stored as", () => {
    // The seed writes the flags as numbers so that the mapping is shared with
    // Oracle, where they are NUMBER(1); comparing against `true` would find
    // nothing.
    expect(compile({ flag: true })).toEqual({ FLAG: { $eq: 1 } });
    expect(compile({ flag: false })).toEqual({ FLAG: { $eq: 0 } });
  });

  it("converts dates to Date, which is what the driver compares against BSON", () => {
    const compiled = compile({ dueAt: { gte: "2026-01-10T10:00:00Z" } } as never) as {
      DUE_AT: { $gte: Date };
    };

    expect(compiled.DUE_AT.$gte).toBeInstanceOf(Date);
    expect(compiled.DUE_AT.$gte.toISOString()).toBe("2026-01-10T10:00:00.000Z");
  });

  it("rejects an unmapped property, which is the barrier against an arbitrary field", () => {
    expect(() => compile({ $where: "sleep(1000)" } as never)).toThrow(/is not mapped/);
  });
});
