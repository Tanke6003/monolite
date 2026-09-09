import { EntitySchema, type ColumnKind } from "../metadata/entity-metadata.js";
import type { DdlDialect, OnDeleteRule } from "./ddl-dialect.js";
import { emitTable, type AnyEntityMetadata, type EmitOptions } from "./emit-schema.js";

/**
 * The schema as the metadata described it at one point in time.
 *
 * Stored next to the migrations and committed, because a diff needs something
 * to diff *against* and the database is the wrong answer: reading the live
 * schema would mean a migration that cannot be generated without a connection
 * to an environment, and would produce a different migration depending on which
 * environment you were pointed at. The snapshot is what the code said, which is
 * the same for everybody who has the code.
 */
export interface SchemaSnapshot {
  /** Bumped when the shape below changes, so an old file fails loudly. */
  version: 1;
  tables: Record<string, TableSnapshot>;
}

export interface TableSnapshot {
  primaryKey: string;
  identity: boolean;
  columns: Record<string, ColumnSnapshot>;
  foreignKeys: Record<string, ForeignKeySnapshot>;
  indexes: IndexSnapshot[];
}

export interface ColumnSnapshot {
  kind: string;
  length?: number | "max";
  precision?: number;
  scale?: number;
  nullable: boolean;
  unique: boolean;
  default?: string;
}

export interface ForeignKeySnapshot {
  column: string;
  references: { table: string; column: string };
  onDelete: string;
}

export interface IndexSnapshot {
  name?: string;
  columns: string[];
  unique: boolean;
}

/**
 * Keyed by physical name throughout — column, not property.
 *
 * The property is what the code calls it and the column is what the database
 * does, and only one of the two is a fact about the schema. Renaming a property
 * while the column stays put is a refactor that must produce no migration at
 * all, and keying by property would emit a drop and an add for it.
 */
export function snapshotOf(entities: readonly AnyEntityMetadata[]): SchemaSnapshot {
  const tables: Record<string, TableSnapshot> = {};

  for (const entity of entities) {
    const schema = new EntitySchema(entity);
    const columns: Record<string, ColumnSnapshot> = {};

    for (const property of schema.properties) {
      const column = schema.columnMetadataOf(property);

      columns[column.name] = {
        kind: column.kind ?? "string",
        ...(column.length === undefined ? {} : { length: column.length }),
        ...(column.precision === undefined ? {} : { precision: column.precision }),
        ...(column.scale === undefined ? {} : { scale: column.scale }),
        // The soft-delete flag as the emitter writes it: never nullable, always
        // defaulted to the active value. If the snapshot disagreed with the DDL,
        // the very first migration would ask to change a column nothing changed.
        nullable:
          property === schema.primaryKey || property === schema.softDelete?.property
            ? false
            : column.nullable !== false,
        unique: column.unique === true,
        ...(property === schema.softDelete?.property
          ? { default: String(schema.softDeleteActiveValue) }
          : column.default === undefined
            ? {}
            : { default: column.default }),
      };
    }

    const foreignKeys: Record<string, ForeignKeySnapshot> = {};

    for (const [name, relation] of Object.entries(entity.relations ?? {})) {
      foreignKeys[name] = {
        column: schema.columnOf(relation.localKey),
        // The referenced column is stored as the property names it: resolving
        // it needs the other entity's mapping, which a snapshot of one table
        // does not have. The diff resolves it when it emits.
        references: { table: relation.to, column: relation.foreignKey },
        onDelete: relation.onDelete ?? "restrict",
      };
    }

    tables[entity.table] = {
      primaryKey: schema.columnOf(schema.primaryKey),
      identity: schema.isIdentity,
      columns,
      foreignKeys,
      indexes: (entity.indexes ?? []).map((index) => ({
        ...(index.name === undefined ? {} : { name: index.name }),
        columns: index.columns.map((property) => schema.columnOf(property)),
        unique: index.unique === true,
      })),
    };
  }

  return { version: 1, tables };
}

/** An empty snapshot: what the first migration is generated against. */
export function emptySnapshot(): SchemaSnapshot {
  return { version: 1, tables: {} };
}

export interface DiffOptions extends EmitOptions {
  /** The entities the *new* snapshot came from; needed to emit a new table. */
  entities: readonly AnyEntityMetadata[];
}

/**
 * The statements that take a database from `previous` to `next`.
 *
 * Empty when nothing changed, and that is a feature rather than an edge case: a
 * migration tool that writes an empty file every time it is run teaches people
 * to stop reading its output, and the next one that matters goes out unread.
 *
 * ---
 *
 * **What it cannot see: a rename.**
 *
 * A column renamed in the metadata is, to a diff, one column that disappeared
 * and another that appeared. Nothing distinguishes it from an actual drop and
 * add, because the only thing that could — a stable identity per column,
 * carried across the rename — does not exist in the mapping and would have to
 * be invented and maintained by hand for the sake of this one inference.
 *
 * So it emits both, and says so in the file. Turning the pair back into a
 * `RENAME COLUMN` is a two-line edit by the one person who knows it was a
 * rename; guessing would silently drop a populated column the day two unrelated
 * changes landed in the same migration.
 */
export function diffSnapshots(
  previous: SchemaSnapshot,
  next: SchemaSnapshot,
  dialect: DdlDialect,
  options: DiffOptions
): string[] {
  const statements: string[] = [];
  const terminator = options.terminator ?? ";";
  const byTable = new Map(options.entities.map((entity) => [entity.table, entity]));

  // ── tables that are new ────────────────────────────────────────────────────
  for (const table of Object.keys(next.tables)) {
    if (previous.tables[table]) continue;

    const entity = byTable.get(table);
    if (!entity) {
      throw new Error(
        `[diffSnapshots] the snapshot has a table "${table}" that is not among the entities ` +
          "passed, so its DDL cannot be emitted. Pass every entity the snapshot was taken from."
      );
    }

    const ddl = emitTable(entity, dialect, options);
    statements.push(ddl.create, ...ddl.foreignKeys, ...ddl.indexes);
  }

  // ── tables that are gone ───────────────────────────────────────────────────
  for (const table of Object.keys(previous.tables)) {
    if (next.tables[table]) continue;

    // Commented out rather than emitted. Everything else here is additive or
    // reversible; this one destroys data, and a generated file that drops a
    // table is a generated file somebody runs in production by accident.
    statements.push(
      `-- ${table} is no longer in the model. Dropping it destroys its rows;`,
      `-- uncomment only when you are sure.`,
      `-- DROP TABLE ${dialect.quote(table)}${terminator}`
    );
  }

  // ── tables that changed ────────────────────────────────────────────────────
  for (const [table, after] of Object.entries(next.tables)) {
    const before = previous.tables[table];
    if (!before) continue;

    statements.push(...diffColumns(table, before, after, dialect, terminator));
    statements.push(...diffForeignKeys(table, before, after, next, dialect, terminator));
  }

  return statements;
}

function diffColumns(
  table: string,
  before: TableSnapshot,
  after: TableSnapshot,
  dialect: DdlDialect,
  terminator: string
): string[] {
  const statements: string[] = [];
  const quoted = dialect.quote(table);

  const added = Object.keys(after.columns).filter((column) => !before.columns[column]);
  const dropped = Object.keys(before.columns).filter((column) => !after.columns[column]);

  if (added.length && dropped.length) {
    statements.push(
      `-- ${table}: ${added.length} column(s) added and ${dropped.length} dropped in the same`,
      `-- change. If any of these is a rename, replace the pair with your engine's`,
      `-- RENAME COLUMN — a diff cannot tell a rename from a drop and an add.`
    );
  }

  for (const column of added) {
    const snapshot = after.columns[column] as ColumnSnapshot;
    const type = dialect.typeOf(asColumnMetadata(column, snapshot));
    const fallback = snapshot.default === undefined ? "" : ` DEFAULT ${snapshot.default}`;

    // A new column is added nullable even when the model says otherwise, unless
    // it has a default: `NOT NULL` against a table with rows in it fails, and a
    // migration that cannot run on a populated database is not a migration.
    const notNull = snapshot.nullable || snapshot.default === undefined ? "" : " NOT NULL";

    statements.push(
      `ALTER TABLE ${quoted} ADD ${dialect.quote(column)} ${type}${fallback}${notNull}${terminator}`
    );

    if (!snapshot.nullable && snapshot.default === undefined) {
      statements.push(
        `-- ${table}.${column} is NOT NULL in the model. Backfill it, then:`,
        `-- ALTER TABLE ${quoted} ALTER COLUMN ${dialect.quote(column)} SET NOT NULL${terminator}`
      );
    }
  }

  for (const column of dropped) {
    statements.push(
      `-- ${table}.${column} is no longer in the model. Dropping it destroys its values;`,
      `-- uncomment only when you are sure.`,
      `-- ALTER TABLE ${quoted} DROP COLUMN ${dialect.quote(column)}${terminator}`
    );
  }

  for (const [column, snapshot] of Object.entries(after.columns)) {
    const was = before.columns[column];
    if (!was || sameColumn(was, snapshot)) continue;

    const type = dialect.typeOf(asColumnMetadata(column, snapshot));

    // Every engine spells an alteration differently and several will not narrow
    // a type at all with rows present, so this is emitted as the statement the
    // change *means* with a note, rather than four dialect-specific attempts at
    // a migration nobody can review.
    statements.push(
      `-- ${table}.${column}: ${describe(was)} -> ${describe(snapshot)}`,
      `-- Check that the existing values fit before running this.`,
      `ALTER TABLE ${quoted} ALTER COLUMN ${dialect.quote(column)} TYPE ${type}${terminator}`
    );
  }

  return statements;
}

function diffForeignKeys(
  table: string,
  before: TableSnapshot,
  after: TableSnapshot,
  next: SchemaSnapshot,
  dialect: DdlDialect,
  terminator: string
): string[] {
  const statements: string[] = [];
  const quoted = dialect.quote(table);

  for (const [name, relation] of Object.entries(after.foreignKeys)) {
    const was = before.foreignKeys[name];
    if (was && was.column === relation.column && was.onDelete === relation.onDelete) continue;

    const target = next.tables[relation.references.table];
    const remote = target?.columns[relation.references.column]
      ? relation.references.column
      : (target?.primaryKey ?? relation.references.column);

    const constraint = `FK_${table}_${relation.column}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

    if (was) {
      statements.push(
        `ALTER TABLE ${quoted} DROP CONSTRAINT ${constraint}${terminator}`
      );
    }

    statements.push(
      `ALTER TABLE ${quoted} ADD CONSTRAINT ${constraint} ` +
        `FOREIGN KEY (${dialect.quote(relation.column)}) ` +
        `REFERENCES ${dialect.quote(relation.references.table)} (${dialect.quote(remote)})` +
        `${dialect.onDelete(relation.onDelete as OnDeleteRule)}${terminator}`
    );
  }

  return statements;
}

/** A snapshot column back into the shape the dialect's type map reads. */
function asColumnMetadata(name: string, snapshot: ColumnSnapshot) {
  return {
    name,
    kind: snapshot.kind as ColumnKind,
    length: snapshot.length,
    precision: snapshot.precision,
    scale: snapshot.scale,
  };
}

function sameColumn(left: ColumnSnapshot, right: ColumnSnapshot): boolean {
  return (
    left.kind === right.kind &&
    left.length === right.length &&
    left.precision === right.precision &&
    left.scale === right.scale &&
    left.nullable === right.nullable &&
    left.default === right.default
  );
}

/** A column in one line, for the comment above an alteration. */
function describe(column: ColumnSnapshot): string {
  const width =
    column.precision !== undefined
      ? `(${column.precision}${column.scale === undefined ? "" : `,${column.scale}`})`
      : column.length !== undefined
        ? `(${column.length})`
        : "";

  return `${column.kind}${width}${column.nullable ? " null" : " not null"}`;
}
