import { EntitySchema } from "../metadata/entity-metadata.js";
import type { ColumnMetadata, EntityMetadata } from "../metadata/entity-metadata.js";
import type { DdlDialect } from "./ddl-dialect.js";

/** An entity whatever its model type; the emitter never reads a value. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEntityMetadata = EntityMetadata<any>;

export interface EmitOptions {
  /** `CREATE TABLE IF NOT EXISTS` on the engines that have it. Default `false`. */
  ifNotExists?: boolean;
  /** Statement terminator. Default `";"`. */
  terminator?: string;
}

/**
 * The statements for one table, in three groups.
 *
 * Separated because they cannot all be run in the order they were written.
 * Foreign keys reference tables that may not exist yet, and there is no
 * ordering that fixes a cycle — two tables that point at each other are a
 * perfectly ordinary model. Emitting every table first and then every
 * constraint sidesteps the question entirely, which is why `emitSchema` groups
 * them that way and why they are returned apart rather than concatenated here.
 */
export interface TableDdl {
  table: string;
  create: string;
  foreignKeys: string[];
  indexes: string[];
}

const DEFAULT_TERMINATOR = ";";

/**
 * Trims a generated constraint name to what the strictest engine accepts.
 *
 * Oracle's limit was 30 characters before 12.2 and is 128 now; MySQL's is 64.
 * Sixty-three is PostgreSQL's, and it is the one that silently *truncates*
 * rather than refusing — which is worse, because two constraints whose names
 * differ only after the cut become one collision at run time. Cutting here, the
 * same way for every engine, keeps a generated schema portable and keeps the
 * failure visible in the file.
 */
function constraintName(...parts: string[]): string {
  const name = parts.join("_").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return name.length <= 63 ? name : name.slice(0, 63);
}

/** `NOT NULL` unless the column said otherwise; the primary key never is. */
function nullabilityOf(column: ColumnMetadata, isPrimaryKey: boolean): string {
  if (isPrimaryKey) return " NOT NULL";
  return column.nullable === false ? " NOT NULL" : "";
}

/**
 * The soft-delete flag is never nullable, and always starts alive.
 *
 * The mapping filters every read with `WHERE <flag> = <activeValue>`, so a
 * `NULL` in that column is neither active nor deleted: the row exists and no
 * query will ever return it. Emitting the column as the mapping actually treats
 * it — not null, defaulted to the active value — makes that state unreachable
 * even from a hand-written `INSERT`, which is the one path the repository
 * cannot cover.
 *
 * It overrides what the column said rather than asking, because `softDelete`
 * saying so is the stronger statement: an entity that declares one has decided
 * what an unset flag means.
 */
function softDeleteColumn<T>(schema: EntitySchema<T>, property: string): ColumnMetadata | null {
  if (schema.softDelete?.property !== property) return null;

  return {
    ...schema.columnMetadataOf(property),
    nullable: false,
    default: String(schema.softDeleteActiveValue),
  };
}

function columnLine<T>(schema: EntitySchema<T>, property: string, dialect: DdlDialect): string {
  const column = softDeleteColumn(schema, property) ?? schema.columnMetadataOf(property);
  const isPrimaryKey = property === schema.primaryKey;
  const name = dialect.quote(column.name);

  // The identity clause replaces the type on some engines and follows it on
  // others, so the dialect writes the whole declaration rather than a fragment
  // this function would have to place.
  const type =
    isPrimaryKey && schema.isIdentity ? dialect.identityColumn(column) : dialect.typeOf(column);

  const fallback = column.default === undefined ? "" : ` DEFAULT ${column.default}`;

  return `  ${name} ${type}${fallback}${nullabilityOf(column, isPrimaryKey)}`;
}

/**
 * `CREATE TABLE`, its foreign keys and its indexes, for one entity.
 *
 * Every fact comes from the mapping the repository already reads, which is the
 * point: the schema and the code that queries it stop being two descriptions
 * that have to be kept in agreement by hand. The disagreement this fixes is not
 * hypothetical — a demo declared a flag as `BOOLEAN` in PostgreSQL while the
 * mapping wrote it as `1` and `0`, and every insert was rejected until the
 * column was changed to `SMALLINT`, which is what this emits.
 */
export function emitTable<T>(
  metadata: EntityMetadata<T>,
  dialect: DdlDialect,
  options: EmitOptions = {}
): TableDdl {
  const schema = new EntitySchema(metadata);
  const terminator = options.terminator ?? DEFAULT_TERMINATOR;
  const table = dialect.quote(schema.table);

  const lines = schema.properties.map((property) => columnLine(schema, property, dialect));

  lines.push(
    `  CONSTRAINT ${constraintName("PK", schema.table)} PRIMARY KEY (${dialect.quote(
      schema.columnOf(schema.primaryKey)
    )})`
  );

  // Single-column uniqueness declared on the column itself. Composite goes
  // through `indexes`, because a two-column constraint has an order and the
  // column has no place to say it.
  for (const property of schema.properties) {
    if (!schema.columnMetadataOf(property).unique) continue;

    const column = schema.columnOf(property);
    lines.push(
      `  CONSTRAINT ${constraintName("UQ", schema.table, column)} UNIQUE (${dialect.quote(column)})`
    );
  }

  const exists = options.ifNotExists && dialect.supportsIfNotExists ? "IF NOT EXISTS " : "";
  const create = `CREATE TABLE ${exists}${table} (\n${lines.join(",\n")}\n)${terminator}`;

  const foreignKeys = Object.entries(metadata.relations ?? {}).map(([, relation]) => {
    const local = dialect.quote(schema.columnOf(relation.localKey));
    const name = constraintName("FK", schema.table, schema.columnOf(relation.localKey));
    const rule = dialect.onDelete(relation.onDelete ?? "restrict");

    // The related column is named as the property is, because the emitter has
    // one entity in hand and cannot resolve the other's mapping. `emitSchema`
    // has both and rewrites it; this is the honest answer for a single table.
    return (
      `ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (${local}) ` +
      `REFERENCES ${dialect.quote(relation.to)} (${dialect.quote(relation.foreignKey)})` +
      `${rule}${terminator}`
    );
  });

  const indexes = (metadata.indexes ?? []).map((index) => {
    const columns = index.columns.map((property) => dialect.quote(schema.columnOf(property)));
    const name =
      index.name ??
      constraintName(index.unique ? "UQ" : "IX", schema.table, ...index.columns.map(String));

    return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${name} ON ${table} (${columns.join(
      ", "
    )})${terminator}`;
  });

  return { table: schema.table, create, foreignKeys, indexes };
}

/**
 * The whole schema, as one script.
 *
 * Tables first, then foreign keys, then indexes. Not for tidiness: a foreign
 * key can reference a table declared later in the list, and two tables that
 * reference each other have no valid ordering at all. Creating everything and
 * then constraining it is the only arrangement that is correct for every model,
 * and it costs a second pass over a file nobody reads twice.
 *
 * Relations name the *entity* they point at, and an entity's table and its
 * registered name are the same string, so the reference resolves by lookup —
 * with the related column's physical name taken from that entity's own mapping
 * rather than assumed to match the property.
 */
export function emitSchema(
  entities: readonly AnyEntityMetadata[],
  dialect: DdlDialect,
  options: EmitOptions = {}
): string {
  const byTable = new Map(entities.map((entity) => [entity.table, new EntitySchema(entity)]));
  const emitted = entities.map((entity) => emitTable(entity, dialect, options));
  const terminator = options.terminator ?? DEFAULT_TERMINATOR;

  // The foreign keys are rebuilt here rather than reused from `emitTable`,
  // because only here is the referenced entity's mapping in scope.
  const foreignKeys: string[] = [];

  for (const entity of entities) {
    const schema = byTable.get(entity.table) as EntitySchema<never>;
    const table = dialect.quote(entity.table);

    for (const relation of Object.values(entity.relations ?? {})) {
      const target = byTable.get(relation.to);

      if (!target) {
        throw new Error(
          `[emitSchema] ${entity.table} declares a relation to "${relation.to}", which is not ` +
            `among the entities passed. Known: ${[...byTable.keys()].join(", ")}.`
        );
      }

      const local = schema.columnOf(relation.localKey);
      const remote = target.columnOf(relation.foreignKey);
      const rule = dialect.onDelete(relation.onDelete ?? "restrict");

      foreignKeys.push(
        `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName("FK", entity.table, local)} ` +
          `FOREIGN KEY (${dialect.quote(local)}) ` +
          `REFERENCES ${dialect.quote(relation.to)} (${dialect.quote(remote)})` +
          `${rule}${terminator}`
      );
    }
  }

  const indexes = emitted.flatMap((one) => one.indexes);

  const sections = [
    header(dialect, entities.length, options),
    emitted.map((one) => one.create).join("\n\n"),
    foreignKeys.length ? `-- Foreign keys\n${foreignKeys.join("\n")}` : "",
    indexes.length ? `-- Indexes\n${indexes.join("\n")}` : "",
  ];

  return sections.filter(Boolean).join("\n\n") + "\n";
}

function header(dialect: DdlDialect, tables: number, options: EmitOptions): string {
  const lines = [
    `-- Generated by monolite from the entity metadata, for ${dialect.name}.`,
    `-- ${tables} ${tables === 1 ? "table" : "tables"}. Do not edit: regenerate it.`,
    "--",
    "-- Review it before running it. It is derived from how your code reads and",
    "-- writes these tables, which is not the same as everything a production",
    "-- schema needs — partitioning, tablespaces, collations and the indexes that",
    "-- exist for a query nobody has written yet are all outside what the mapping",
    "-- knows.",
  ];

  if (options.ifNotExists && !dialect.supportsIfNotExists) {
    lines.push(
      "--",
      `-- \`ifNotExists\` was asked for and ${dialect.name} has no such clause. Emitting`,
      "-- the engine's conditional block would make this file readable only by that",
      "-- engine's own client, so the tables are declared plainly instead."
    );
  }

  return lines.join("\n");
}
