/**
 * Prints the `CREATE TABLE` script for this project's entities.
 *
 *     __pmRun__ db:sql                 # to stdout, for the engine in DATA_SOURCE
 *     __pmRun__ db:sql -- --dialect mysql
 *     __pmRun__ db:sql -- --out db/schema.sql
 *
 * It reads `MODULES` — the same list the application is built from — so the
 * schema and the code that queries it stop being two descriptions somebody has
 * to keep in agreement. That agreement is not a formality: the mapping writes a
 * boolean as `1` and `0`, so a column declared `BOOLEAN` rejects every insert
 * the repository makes, and finding that out costs an afternoon. Generated from
 * the mapping, it cannot happen.
 *
 * **It is a starting point, not a production schema.** Partitioning,
 * tablespaces, collations, and the indexes that exist for a query nobody has
 * written yet are all outside what the mapping knows. Read it before you run
 * it.
 *
 * This lives in the project rather than in the CLI because the CLI has no
 * runtime dependencies and cannot load your entities. Your project already has
 * them in memory.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ddlDialectFor, emitSchema } from "monolite-data";
import { entitiesOf } from "monolite-di";

import { MODULES } from "../composition/modules";

const { values } = parseArgs({
  options: {
    dialect: { type: "string" },
    out: { type: "string" },
    "if-not-exists": { type: "boolean" },
  },
});

const engine = values.dialect ?? process.env.DATA_SOURCE ?? "__dataSource__";
const dialect = ddlDialectFor(engine);

if (!dialect) {
  // Not an error worth a stack trace: the in-memory driver and MongoDB have no
  // schema to create, and saying so is the whole answer.
  console.error(`There is no DDL to generate for "${engine}": it has no schema to create.`);
  console.error("Pass --dialect with one of: oracle, mssql, postgres, mysql.");
  process.exit(1);
}

const entities = entitiesOf(MODULES).map((registration) => registration.metadata);

if (entities.length === 0) {
  console.error("No entities are registered. Add a module to src/composition/modules.ts first.");
  process.exit(1);
}

const script = emitSchema(entities, dialect, { ifNotExists: values["if-not-exists"] });

if (!values.out) {
  process.stdout.write(script);
} else {
  const target = path.resolve(values.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, script, "utf8");
  console.log(`${entities.length} table(s) for ${dialect.name} -> ${values.out}`);
}
