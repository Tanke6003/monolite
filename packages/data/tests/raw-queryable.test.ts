import { asRawQueryable, defineEntity, EntitySchema, SqlGenericRepository } from "monolite-data";
import type { IGenericRepository, IRawQueryable, ISqlExecutor } from "monolite-data";

interface IWidget {
  pkWidget: number;
  name: string;
}

const WIDGETS = defineEntity<IWidget>({
  table: "WIDGETS",
  primaryKey: "pkWidget",
  identity: true,
  columns: {
    pkWidget: { name: "PK_WIDGET", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string" },
  },
});

/**
 * The check that keeps the interface honest.
 *
 * `IRawQueryable` is only worth having if the SQL store really satisfies it, and
 * a type-level assertion is the form of that which cannot rot: change either
 * side and this file stops compiling, which is earlier than any test can fail.
 */
type SqlStoreIsRawQueryable = SqlGenericRepository<IWidget> extends IRawQueryable<IWidget>
  ? true
  : never;
const SQL_STORE_IS_RAW_QUERYABLE: SqlStoreIsRawQueryable = true;

describe("asRawQueryable", () => {
  it("is satisfied by the SQL store, checked by the compiler", () => {
    expect(SQL_STORE_IS_RAW_QUERYABLE).toBe(true);
  });

  it("hands back the store on a driver that has SQL to run", () => {
    const executed: string[] = [];
    const db = {
      execute: async (sql: string) => {
        executed.push(sql);
        return { rows: [{ TOTAL: 3 }] };
      },
    } as unknown as ISqlExecutor;

    const store = new SqlGenericRepository<IWidget>(db, WIDGETS, console as never, {
      buildRowLock: () => "",
    } as never);

    const raw = asRawQueryable<IWidget>(store);

    expect(raw).not.toBeNull();
    // And it is the store itself, not a copy: the connection it runs on has to
    // be the same one — the transaction's, when one is open.
    expect(raw).toBe(store);
  });

  it("gives the mapping, so raw SQL names columns instead of guessing them", () => {
    const store = new SqlGenericRepository<IWidget>({} as ISqlExecutor, WIDGETS, console as never, {
      buildRowLock: () => "",
    } as never);

    const raw = asRawQueryable<IWidget>(store);

    expect(raw?.schema).toBeInstanceOf(EntitySchema);
    expect(raw?.schema.columnOf("name")).toBe("NAME");
  });

  /**
   * The case that matters, and the reason this is a runtime question rather
   * than a configuration one: the in-memory driver is what the generated test
   * suite runs on, so `null` here is what tells a report it needs its
   * in-process fallback.
   */
  it("answers null where there is no SQL to run", () => {
    const memoryish = {
      getAll: async () => [],
      insert: async (widget: Partial<IWidget>) => widget as IWidget,
    } as unknown as IGenericRepository<IWidget>;

    expect(asRawQueryable(memoryish)).toBeNull();
  });

  it("is not fooled by half of the shape", () => {
    const noSchema = { executeRaw: async () => [] } as unknown as IGenericRepository<IWidget>;
    const noExecute = { schema: {} } as unknown as IGenericRepository<IWidget>;

    expect(asRawQueryable(noSchema)).toBeNull();
    expect(asRawQueryable(noExecute)).toBeNull();
  });

  it("runs the caller's SQL with its binds", async () => {
    const calls: { sql: string; binds: unknown }[] = [];
    const db = {
      execute: async (sql: string, binds: unknown) => {
        calls.push({ sql, binds });
        return { rows: [{ UNITS: 12 }] };
      },
    } as unknown as ISqlExecutor;

    const store = new SqlGenericRepository<IWidget>(db, WIDGETS, console as never, {
      buildRowLock: () => "",
    } as never);

    const raw = asRawQueryable<IWidget>(store);
    const rows = await raw?.executeRaw<{ UNITS: number }>(
      "SELECT SUM(UNITS) AS UNITS FROM SALES WHERE PK_WIDGET = :pk",
      { pk: 7 }
    );

    expect(rows).toEqual([{ UNITS: 12 }]);
    expect(calls[0]?.binds).toEqual({ pk: 7 });
  });
});
