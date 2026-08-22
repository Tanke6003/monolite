import type { ILogger } from "monolite-core";
import {
  CONTRACT_ENTITY,
  ddlDialectFor,
  defineEntity,
  emitSchema,
  type AnyEntityMetadata,
} from "monolite-data";

/**
 * The engines this suite can be pointed at, and how to reach each one.
 *
 * Everything here matches `docker/integration/docker-compose.yml`. The ports are
 * deliberately unusual so a developer with PostgreSQL already listening on 5432
 * does not get a mystery failure, or worse, a passing run against the wrong
 * database.
 *
 * Override any of it with `MONOLITE_IT_<ENGINE>_<FIELD>` — the CI workflow uses
 * the compose defaults, but a developer pointing this at something else should
 * not have to edit a file that is under version control.
 */

export type EngineId = "postgres" | "mysql" | "mssql" | "oracle" | "mongodb";

export interface EngineSpec {
  id: EngineId;
  /** What `registerPersistence` is told; the aliases are resolved there. */
  dataSource: string;
  /** `false` for MongoDB, which has no SQL and therefore no procedures. */
  sql: boolean;
  /** Connection settings, in the shape the matching connector wants. */
  connection: Record<string, unknown>;
}

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
const port = (name: string, fallback: number): number => Number(env(name, String(fallback)));

/** A connection-string query, as the object the connector takes. */
const parseOptions = (raw: string): Record<string, string> =>
  Object.fromEntries(
    raw
      .split("&")
      .filter(Boolean)
      .map((pair) => {
        const [key, ...rest] = pair.split("=");
        return [key, rest.join("=")];
      })
  );

export const ENGINES: EngineSpec[] = [
  {
    id: "postgres",
    dataSource: "postgres",
    sql: true,
    connection: {
      engine: "postgres",
      host: env("MONOLITE_IT_POSTGRES_HOST", "localhost"),
      port: port("MONOLITE_IT_POSTGRES_PORT", 55432),
      username: env("MONOLITE_IT_POSTGRES_USER", "monolite"),
      password: env("MONOLITE_IT_POSTGRES_PASSWORD", "monolite"),
      database: env("MONOLITE_IT_POSTGRES_DB", "monolite"),
    },
  },
  {
    id: "mysql",
    dataSource: "mysql",
    sql: true,
    connection: {
      engine: "mysql",
      host: env("MONOLITE_IT_MYSQL_HOST", "localhost"),
      port: port("MONOLITE_IT_MYSQL_PORT", 55306),
      username: env("MONOLITE_IT_MYSQL_USER", "root"),
      password: env("MONOLITE_IT_MYSQL_PASSWORD", "monolite"),
      database: env("MONOLITE_IT_MYSQL_DB", "monolite"),
    },
  },
  {
    id: "mssql",
    dataSource: "mssql",
    sql: true,
    connection: {
      engine: "mssql",
      host: env("MONOLITE_IT_MSSQL_HOST", "localhost"),
      port: port("MONOLITE_IT_MSSQL_PORT", 51433),
      username: env("MONOLITE_IT_MSSQL_USER", "sa"),
      password: env("MONOLITE_IT_MSSQL_PASSWORD", "Monolite_2026!"),
      database: env("MONOLITE_IT_MSSQL_DB", "master"),
    },
  },
  {
    id: "oracle",
    dataSource: "oracle",
    sql: true,
    connection: {
      user: env("MONOLITE_IT_ORACLE_USER", "monolite"),
      password: env("MONOLITE_IT_ORACLE_PASSWORD", "monolite"),
      connectString: env(
        "MONOLITE_IT_ORACLE_CONNECT",
        `${env("MONOLITE_IT_ORACLE_HOST", "localhost")}:${port("MONOLITE_IT_ORACLE_PORT", 51521)}/FREEPDB1`
      ),
    },
  },
  {
    id: "mongodb",
    dataSource: "mongodb",
    sql: false,
    connection: {
      host: env("MONOLITE_IT_MONGO_HOST", "localhost"),
      port: port("MONOLITE_IT_MONGO_PORT", 57017),
      database: env("MONOLITE_IT_MONGO_DB", "monolite"),
      // A direct connection to the single member of the replica set. The set
      // exists because MongoDB refuses to open a transaction on a standalone,
      // and it advertises an address only reachable inside the container — so
      // topology discovery has to be skipped rather than followed.
      //
      // Overridable like everything else here: pointed at a set whose members
      // are routable, `replicaSet=rs0` is the better answer.
      options: parseOptions(env("MONOLITE_IT_MONGO_OPTIONS", "directConnection=true")),
    },
  },
];

/**
 * The engines this run is allowed to touch.
 *
 * `MONOLITE_IT_ENGINES=postgres,mysql` narrows it; unset means all of them.
 * Nothing here probes for reachability — an engine that was asked for and is
 * not there must fail the run, not skip it. A suite that silently verifies
 * nothing is worse than one that is not run at all, and "integration tests
 * passed" would be a lie CI repeats on every push.
 */
export function selectedEngines(): EngineSpec[] {
  const asked = process.env.MONOLITE_IT_ENGINES?.trim();
  if (!asked) return ENGINES;

  const wanted = new Set(asked.split(",").map((one) => one.trim().toLowerCase()));
  const chosen = ENGINES.filter((engine) => wanted.has(engine.id));

  const unknown = [...wanted].filter((one) => !ENGINES.some((engine) => engine.id === one));
  if (unknown.length) {
    throw new Error(
      `MONOLITE_IT_ENGINES names an engine this suite does not know: ${unknown.join(", ")}. ` +
        `Known: ${ENGINES.map((engine) => engine.id).join(", ")}.`
    );
  }

  return chosen;
}

/** Which key of `PersistenceOptions` this engine's settings go under. */
export function connectionKey(engine: EngineSpec): "oracle" | "sequelize" | "mongo" {
  if (engine.id === "oracle") return "oracle";
  if (engine.id === "mongodb") return "mongo";
  return "sequelize";
}

/** Quiet by default: a hundred SQL statements per test is not a test report. */
export function integrationLogger(): ILogger {
  const noop = () => undefined;
  const loud = process.env.MONOLITE_IT_VERBOSE === "true";

  return {
    info: loud ? console.log : noop,
    warn: loud ? console.warn : noop,
    error: loud ? console.error : noop,
    debug: loud ? console.log : noop,
  } as unknown as ILogger;
}

// ─────────────────────────────────────────────────────────────── the model ───

/**
 * Four tables with three foreign keys between them, which is the smallest model
 * that can show a transaction doing something worth rolling back: an order
 * writes a header, its lines, and the stock it consumed, and any one of the
 * three failing has to undo the other two.
 */

export interface ICategory {
  pkCategory: number;
  name: string;
}

export interface IProduct {
  pkProduct: number;
  categoryId: number;
  sku: string;
  name: string;
  stock: number;
  priceCents: number;
  available: boolean;
}

export interface IOrder {
  pkOrder: number;
  reference: string;
  status: string;
  totalCents: number;
}

export interface IOrderLine {
  pkOrderLine: number;
  orderId: number;
  productId: number;
  quantity: number;
  unitPriceCents: number;
}

export const CATEGORY = defineEntity<ICategory>({
  table: "IT_CATEGORIES",
  primaryKey: "pkCategory",
  identity: true,
  columns: {
    pkCategory: { name: "PK_CATEGORY", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string", length: 80, nullable: false },
  },
});

export const PRODUCT = defineEntity<IProduct>({
  table: "IT_PRODUCTS",
  primaryKey: "pkProduct",
  identity: true,
  columns: {
    pkProduct: { name: "PK_PRODUCT", kind: "number", insertable: false, updatable: false },
    categoryId: { name: "FK_CATEGORY", kind: "number", nullable: false },
    sku: { name: "SKU", kind: "string", length: 32, nullable: false },
    name: { name: "NAME", kind: "string", length: 120, nullable: false },
    stock: { name: "STOCK", kind: "number", nullable: false, default: "0" },
    priceCents: { name: "PRICE_CENTS", kind: "number", nullable: false, default: "0" },
    // Not a BOOLEAN column on any engine: the mapping writes 1 and 0. The DDL
    // generator knows that because it reads this same metadata, which is the
    // agreement this suite is here to prove holds on a real server.
    available: { name: "AVAILABLE", kind: "boolean", nullable: false, default: "1" },
  },
  softDelete: { property: "available", activeValue: 1, deletedValue: 0 },
  relations: {
    category: { to: "IT_CATEGORIES", localKey: "categoryId", foreignKey: "pkCategory" },
  },
});

export const ORDER = defineEntity<IOrder>({
  table: "IT_ORDERS",
  primaryKey: "pkOrder",
  identity: true,
  columns: {
    pkOrder: { name: "PK_ORDER", kind: "number", insertable: false, updatable: false },
    reference: { name: "REFERENCE", kind: "string", length: 40, nullable: false, unique: true },
    status: { name: "STATUS", kind: "string", length: 20, nullable: false },
    totalCents: { name: "TOTAL_CENTS", kind: "number", nullable: false, default: "0" },
  },
});

export const ORDER_LINE = defineEntity<IOrderLine>({
  table: "IT_ORDER_LINES",
  primaryKey: "pkOrderLine",
  identity: true,
  columns: {
    pkOrderLine: { name: "PK_ORDER_LINE", kind: "number", insertable: false, updatable: false },
    orderId: { name: "FK_ORDER", kind: "number", nullable: false },
    productId: { name: "FK_PRODUCT", kind: "number", nullable: false },
    quantity: { name: "QUANTITY", kind: "number", nullable: false },
    unitPriceCents: { name: "UNIT_PRICE_CENTS", kind: "number", nullable: false },
  },
  relations: {
    order: { to: "IT_ORDERS", localKey: "orderId", foreignKey: "pkOrder", onDelete: "cascade" },
    product: { to: "IT_PRODUCTS", localKey: "productId", foreignKey: "pkProduct" },
  },
});

/**
 * The contract kit's own entity travels with the model.
 *
 * It has to exist as a real table for the suite to run the shared contract
 * against a real engine, which is the whole reason that kit was written: it is
 * the same set of assertions every implementation must pass, and until now no
 * implementation had ever been asked to pass them anywhere but in memory.
 */
export const MODEL: AnyEntityMetadata[] = [CATEGORY, PRODUCT, ORDER, ORDER_LINE, CONTRACT_ENTITY];

/**
 * Every table, children first.
 *
 * Not derived from `MODEL`: the order that satisfies the foreign keys is the
 * reverse of the order they are created in, and getting it from the relations
 * would mean a topological sort in a test helper to save writing four names.
 */
export const TABLES_CHILD_FIRST = [
  ORDER_LINE.table,
  ORDER.table,
  PRODUCT.table,
  CATEGORY.table,
  CONTRACT_ENTITY.table,
] as const;

/** The registered names, in the order the tables have to be created. */
export const ENTITY = {
  categories: CATEGORY.table,
  products: PRODUCT.table,
  orders: ORDER.table,
  orderLines: ORDER_LINE.table,
  contractItems: CONTRACT_ENTITY.table,
} as const;

/**
 * The schema, from the metadata above — not from a hand-written file.
 *
 * That is deliberate and it is half the point of this suite: if the generated
 * DDL is wrong, the repository that reads the same metadata cannot work against
 * it, and every test below fails. A schema written by hand would hide exactly
 * the disagreement the generator exists to prevent.
 */
export function schemaFor(engine: EngineSpec): string {
  const dialect = ddlDialectFor(engine.dataSource);
  if (!dialect) throw new Error(`no DDL dialect for ${engine.id}`);

  return emitSchema(MODEL, dialect);
}
