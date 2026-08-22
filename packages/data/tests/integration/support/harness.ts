import type { ILogger } from "monolite-core";
import {
  AsyncTransactionContext,
  type IGenericRepository,
  type ISqlExecutor,
  type ITransactionContext,
  type IUnitOfWork,
} from "monolite-data";
import {
  createContainer,
  registerPersistence,
  storeToken,
  TOKENS,
  type DependencyContainer,
} from "monolite-di";

import {
  CATEGORY,
  connectionKey,
  ENTITY,
  integrationLogger,
  MODEL,
  ORDER,
  ORDER_LINE,
  PRODUCT,
  schemaFor,
  TABLES_CHILD_FIRST,
  type EngineSpec,
  type ICategory,
  type IOrder,
  type IOrderLine,
  type IProduct,
} from "./engines";
import { PROCEDURES, type ProcedureSet } from "./procedures";

/**
 * One engine, brought up the way an application does it.
 *
 * Everything goes through `registerPersistence`, not through hand-built
 * repositories, and that is the point: the stores under test are the ones a
 * generated project injects, wrapped in `transactionAware`, indexed by the same
 * unit of work. A harness that assembled its own would have missed the bug that
 * started all of this, because that bug lived in the assembly.
 */
export interface Harness {
  engine: EngineSpec;
  container: DependencyContainer;
  logger: ILogger;
  unitOfWork: IUnitOfWork;
  transactions: ITransactionContext;
  categories: IGenericRepository<ICategory>;
  products: IGenericRepository<IProduct>;
  orders: IGenericRepository<IOrder>;
  lines: IGenericRepository<IOrderLine>;
  /** `null` on MongoDB; see `procedures.ts`. */
  procedures: ProcedureSet | null;
  /** Raw access, for the DDL and for reading back what the framework wrote. */
  sql: ISqlExecutor | null;
  /** Empties every table, in an order the foreign keys accept. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A statement at a time, with the comments the emitter writes stripped out. */
function statementsOf(script: string): string[] {
  return script
    .split(";")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter(Boolean);
}

export async function bringUp(engine: EngineSpec): Promise<Harness> {
  const logger = integrationLogger();
  const container = createContainer();
  const transactions = new AsyncTransactionContext();

  const layer = registerPersistence({
    container,
    dataSource: engine.dataSource,
    logger,
    transactions,
    entities: MODEL.map((metadata) => ({ name: metadata.table, metadata })),
    [connectionKey(engine)]: engine.connection,
  } as never);

  // Opening it here rather than lazily gives a connection failure its own clear
  // error, instead of surfacing as a broken assertion three tests later.
  await layer.connection?.authenticate();

  const sql = engine.sql ? (layer.connection as unknown as ISqlExecutor) : null;
  const procedures = PROCEDURES[engine.id] ?? null;

  const harness: Harness = {
    engine,
    container,
    logger,
    transactions,
    unitOfWork: container.resolve<IUnitOfWork>(TOKENS.IUnitOfWork),
    categories: container.resolve(storeToken(ENTITY.categories)),
    products: container.resolve(storeToken(ENTITY.products)),
    orders: container.resolve(storeToken(ENTITY.orders)),
    lines: container.resolve(storeToken(ENTITY.orderLines)),
    procedures,
    sql,

    async reset() {
      if (!sql) {
        // MongoDB: no schema, so emptying is deleting the documents.
        for (const store of [harness.lines, harness.orders, harness.products, harness.categories]) {
          await store.hardDeleteWhere({} as never);
        }
        return;
      }

      // Children first: the foreign keys are real, which is the point.
      for (const table of TABLES_CHILD_FIRST) {
        await sql.execute(`DELETE FROM ${table}`, {}, { expects: "none" });
      }
    },

    async close() {
      await layer.connection?.close();
    },
  };

  if (sql) {
    await dropSchema(sql, engine);
    await applySchema(sql, engine);
    if (procedures) await applyProcedures(sql, procedures);
  } else {
    await harness.reset();
  }

  return harness;
}

/**
 * Removes whatever a previous run left behind.
 *
 * Every statement is allowed to fail: on a clean database none of these objects
 * exist, and a `DROP` of something absent is not an error worth stopping for.
 * What would be an error is a `CREATE` failing later, and that is not swallowed.
 */
async function dropSchema(sql: ISqlExecutor, engine: EngineSpec): Promise<void> {
  const procedures = PROCEDURES[engine.id];

  for (const statement of procedures?.drop ?? []) {
    await sql.execute(statement, {}, { expects: "none" }).catch(() => undefined);
  }

  const cascade = engine.id === "postgres" ? " CASCADE" : "";

  for (const table of TABLES_CHILD_FIRST) {
    await sql.execute(`DROP TABLE ${table}${cascade}`, {}, { expects: "none" }).catch(() => undefined);
  }
}

/**
 * The schema, from `emitSchema` — which is what makes this suite a check on the
 * DDL generator as well as on the drivers. If the generated schema disagreed
 * with the mapping, every test below would fail against a real server, which is
 * exactly the failure mode a hand-written schema would have hidden.
 */
async function applySchema(sql: ISqlExecutor, engine: EngineSpec): Promise<void> {
  for (const statement of statementsOf(schemaFor(engine))) {
    await sql.execute(statement, {}, { expects: "none" });
  }
}

async function applyProcedures(sql: ISqlExecutor, procedures: ProcedureSet): Promise<void> {
  for (const statement of procedures.create) {
    // Verbatim, terminator included. PL/SQL needs the `;` that closes `END` —
    // stripping it does not fail, which is the trap: Oracle creates the object
    // and marks it INVALID, and the error only surfaces when something calls it.
    await sql.execute(statement.trim(), {}, { expects: "none" });
  }
}

/** The three rows every test starts from. */
export interface Seeded {
  categoryId: number;
  widget: IProduct;
  gadget: IProduct;
}

export async function seed(harness: Harness): Promise<Seeded> {
  const category = await harness.categories.insert({ name: "tools" });

  const widget = await harness.products.insert({
    categoryId: category.pkCategory,
    sku: "WID-1",
    name: "Widget",
    stock: 10,
    priceCents: 500,
    available: true,
  });

  const gadget = await harness.products.insert({
    categoryId: category.pkCategory,
    sku: "GAD-1",
    name: "Gadget",
    stock: 4,
    priceCents: 1250,
    available: true,
  });

  return { categoryId: category.pkCategory, widget, gadget };
}

export { CATEGORY, ENTITY, MODEL, ORDER, ORDER_LINE, PRODUCT };
