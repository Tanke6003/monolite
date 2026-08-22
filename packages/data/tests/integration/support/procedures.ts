import type { EngineId } from "./engines";

/**
 * A stored procedure per engine, twice over: one that reads and one that
 * writes.
 *
 * They exist because `executeRaw` is documented as the way to call a procedure
 * and nothing verified that claim — the escape hatch was tested against a fake
 * `ISqlExecutor`, which will happily "run" a `CALL` that no engine would
 * accept. The two shapes are separated because they fail differently: a
 * procedure that returns rows has to come back through the driver's result set,
 * which each engine does its own way, and one that writes has to participate in
 * the caller's transaction, which is the part that would silently commit on its
 * own if the escape hatch used a different connection.
 *
 * MongoDB has none and gets none. Server-side JavaScript was removed years ago
 * and an aggregation pipeline is not a procedure; pretending otherwise would
 * mean inventing a shape nobody writes.
 */

export interface ProcedureSet {
  /** Statements that create them, run one at a time. */
  create: string[];
  /** Statements that drop them; failures are ignored on a clean database. */
  drop: string[];
  /** Reads: how many products a category has, and the total stock. */
  callSummary: (categoryId: number) => { sql: string; binds: Record<string, unknown> };
  /** Writes: takes `units` off a product's stock. */
  callTakeStock: (productId: number, units: number) => {
    sql: string;
    binds: Record<string, unknown>;
  };
  /** `rows` for a procedure that returns a result set, `none` when it does not. */
  summaryExpects: "rows";
}

const PRODUCTS = "IT_PRODUCTS";

export const PROCEDURES: Partial<Record<EngineId, ProcedureSet>> = {
  /**
   * PostgreSQL: a `FUNCTION` returning a table, because a `PROCEDURE` there
   * cannot return a result set — `CALL` gives you nothing to read. This is the
   * kind of difference the suite exists to pin down.
   */
  postgres: {
    create: [
      `CREATE OR REPLACE FUNCTION it_category_summary(p_category INTEGER)
       RETURNS TABLE (products BIGINT, units BIGINT) AS $$
         SELECT COUNT(*)::BIGINT, COALESCE(SUM(stock), 0)::BIGINT
           FROM ${PRODUCTS} WHERE fk_category = p_category
       $$ LANGUAGE SQL`,
      `CREATE OR REPLACE PROCEDURE it_take_stock(p_product INTEGER, p_units INTEGER)
       LANGUAGE SQL AS $$
         UPDATE ${PRODUCTS} SET stock = stock - p_units WHERE pk_product = p_product
       $$`,
    ],
    drop: [
      "DROP FUNCTION IF EXISTS it_category_summary(INTEGER)",
      "DROP PROCEDURE IF EXISTS it_take_stock(INTEGER, INTEGER)",
    ],
    callSummary: (categoryId) => ({
      sql: "SELECT products, units FROM it_category_summary(:category)",
      binds: { category: categoryId },
    }),
    callTakeStock: (productId, units) => ({
      sql: "CALL it_take_stock(:product, :units)",
      binds: { product: productId, units },
    }),
    summaryExpects: "rows",
  },

  /** MySQL: a procedure whose body is a `SELECT`, which is its result set. */
  mysql: {
    create: [
      `CREATE PROCEDURE it_category_summary(IN p_category INT)
       BEGIN
         SELECT COUNT(*) AS PRODUCTS, COALESCE(SUM(STOCK), 0) AS UNITS
           FROM ${PRODUCTS} WHERE FK_CATEGORY = p_category;
       END`,
      `CREATE PROCEDURE it_take_stock(IN p_product INT, IN p_units INT)
       BEGIN
         UPDATE ${PRODUCTS} SET STOCK = STOCK - p_units WHERE PK_PRODUCT = p_product;
       END`,
    ],
    drop: ["DROP PROCEDURE IF EXISTS it_category_summary", "DROP PROCEDURE IF EXISTS it_take_stock"],
    callSummary: (categoryId) => ({
      sql: "CALL it_category_summary(:category)",
      binds: { category: categoryId },
    }),
    callTakeStock: (productId, units) => ({
      sql: "CALL it_take_stock(:product, :units)",
      binds: { product: productId, units },
    }),
    summaryExpects: "rows",
  },

  /** SQL Server: the plainest of the four — a procedure that selects. */
  mssql: {
    create: [
      `CREATE OR ALTER PROCEDURE it_category_summary @p_category INT AS
       BEGIN
         SET NOCOUNT ON;
         SELECT COUNT(*) AS PRODUCTS, ISNULL(SUM(STOCK), 0) AS UNITS
           FROM ${PRODUCTS} WHERE FK_CATEGORY = @p_category;
       END`,
      `CREATE OR ALTER PROCEDURE it_take_stock @p_product INT, @p_units INT AS
       BEGIN
         SET NOCOUNT ON;
         UPDATE ${PRODUCTS} SET STOCK = STOCK - @p_units WHERE PK_PRODUCT = @p_product;
       END`,
    ],
    drop: [
      "DROP PROCEDURE IF EXISTS it_category_summary",
      "DROP PROCEDURE IF EXISTS it_take_stock",
    ],
    callSummary: (categoryId) => ({
      sql: "EXEC it_category_summary @p_category = :category",
      binds: { category: categoryId },
    }),
    callTakeStock: (productId, units) => ({
      sql: "EXEC it_take_stock @p_product = :product, @p_units = :units",
      binds: { product: productId, units },
    }),
    summaryExpects: "rows",
  },

  /**
   * Oracle: a function returning two numbers is not a result set, so the read
   * goes through `SELECT ... FROM DUAL` over two scalar functions. A `SYS_REFCURSOR`
   * out-parameter would be the other way and needs an output bind the escape
   * hatch does not model — which is worth knowing and is why this one is a
   * function call rather than a `CALL`.
   */
  oracle: {
    create: [
      `CREATE OR REPLACE FUNCTION it_category_products(p_category IN NUMBER) RETURN NUMBER IS
         v_total NUMBER;
       BEGIN
         SELECT COUNT(*) INTO v_total FROM ${PRODUCTS} WHERE FK_CATEGORY = p_category;
         RETURN v_total;
       END;`,
      `CREATE OR REPLACE FUNCTION it_category_units(p_category IN NUMBER) RETURN NUMBER IS
         v_total NUMBER;
       BEGIN
         SELECT NVL(SUM(STOCK), 0) INTO v_total FROM ${PRODUCTS} WHERE FK_CATEGORY = p_category;
         RETURN v_total;
       END;`,
      `CREATE OR REPLACE PROCEDURE it_take_stock(p_product IN NUMBER, p_units IN NUMBER) IS
       BEGIN
         UPDATE ${PRODUCTS} SET STOCK = STOCK - p_units WHERE PK_PRODUCT = p_product;
       END;`,
    ],
    drop: [
      "DROP FUNCTION it_category_products",
      "DROP FUNCTION it_category_units",
      "DROP PROCEDURE it_take_stock",
    ],
    callSummary: (categoryId) => ({
      sql:
        "SELECT it_category_products(:category) AS PRODUCTS, " +
        "it_category_units(:category) AS UNITS FROM DUAL",
      binds: { category: categoryId },
    }),
    callTakeStock: (productId, units) => ({
      sql: "BEGIN it_take_stock(:product, :units); END;",
      binds: { product: productId, units },
    }),
    summaryExpects: "rows",
  },
};
