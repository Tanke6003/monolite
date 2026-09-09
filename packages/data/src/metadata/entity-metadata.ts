/**
 * Entity <-> table mapping, in the style of EF Core's `ModelBuilder` but
 * without decorators: domain models stay pure interfaces and here, in the
 * infrastructure layer, is where how they are persisted gets declared.
 *
 * With this description, `SqlGenericRepository`, `MongoGenericRepository` and
 * `MemoryGenericRepository` know how to generate the whole CRUD without a
 * single hand-written line of SQL.
 */
import { roundTo } from "monolite-core";

/** Decimals a `decimal` column keeps when its mapping does not say. */
const DEFAULT_DECIMAL_SCALE = 2;

/**
 * The logical type of a column.
 *
 * `decimal` is a number the engine stores exactly and JavaScript does not: a
 * price, a balance, a percentage. It exists as its own kind because a `number`
 * arrives as whatever a double can hold, and money read back as
 * `19.989999999999998` is money that will eventually be shown to somebody. A
 * decimal column is rounded to its `scale` on the way in and on the way out, so
 * every driver agrees on the value and the in-memory one agrees with the engine
 * it stands in for — which is what makes a test written against memory mean
 * anything about production.
 */
export type ColumnKind = "number" | "decimal" | "string" | "boolean" | "date";

export interface ColumnMetadata {
  /** Physical column name. */
  name: string;
  /** Logical type; it governs the JS <-> DB conversions. Defaults to "string". */
  kind?: ColumnKind;
  /** `false` for columns the database computes (e.g. IDENTITY). */
  insertable?: boolean;
  /** `false` for immutable columns (e.g. CREATED_AT). */
  updatable?: boolean;

  // ---------------------------------------------------------------------------
  // Everything below is read by the DDL generator, and — for `scale` on a
  // `decimal` column — by the mapping too. The repository has never needed to
  // know how wide a column is, it binds values and the engine checks them,
  // which is why these arrived late and are all optional. An entity that does
  // not set them still maps, still queries and still writes exactly as before;
  // it only generates a schema with the defaults documented on each one.
  // ---------------------------------------------------------------------------

  /**
   * Width of a string column. Defaults to 255; `"max"` asks the engine for its
   * unbounded text type.
   */
  length?: number | "max";
  /**
   * Total digits of a numeric column. Without it a `number` is an integer and a
   * `decimal` takes the generator's default width.
   */
  precision?: number;
  /**
   * Digits after the point.
   *
   * On a `decimal` column the mapping reads this as well as the DDL generator:
   * it is the scale every value is rounded to, going in and coming back. That
   * is the one place a width stops being only a schema concern — a column
   * declared with two decimals and an entity holding three of them disagree
   * about what was stored, and the disagreement surfaces as a cent.
   *
   * Defaults to 2 for `decimal`. On a plain `number` it is DDL-only and has no
   * default: `precision` without `scale` is a decimal column of whole digits,
   * which is what the engines mean by it.
   */
  scale?: number;
  /**
   * Whether the column accepts `NULL`. Defaults to `true` for every column
   * except the primary key.
   *
   * The default is the permissive one on purpose: it is the only choice that
   * cannot break an existing table when the generated DDL is first compared
   * against one written by hand.
   */
  nullable?: boolean;
  /** A single-column `UNIQUE` constraint. For more than one, see `indexes`. */
  unique?: boolean;
  /**
   * Literal SQL for the column's default, emitted verbatim.
   *
   * SQL rather than a JavaScript value because a default is engine text —
   * `CURRENT_TIMESTAMP`, `0`, `'pending'` — and translating a value into it
   * would mean guessing at quoting for a string that might be a function call.
   * Quote your own strings.
   */
  default?: string;
}

/**
 * An index over one or more columns.
 *
 * Read by the DDL generator only. Single-column uniqueness is better said with
 * `unique` on the column itself; this is for the composite case and for plain
 * lookup indexes.
 */
export interface IndexMetadata<T> {
  /** Properties, in index order — which is the order that decides what it serves. */
  columns: Extract<keyof T, string>[];
  unique?: boolean;
  /** Overrides the generated `IX_<table>_<columns>` / `UQ_...` name. */
  name?: string;
}

/** Shorthand: if only the name is given, everything else takes its default. */
export type ColumnDefinition = string | ColumnMetadata;

export interface SoftDeleteMetadata<T> {
  property: Extract<keyof T, string>;
  /** Value that marks "alive". Defaults to `1`. */
  activeValue?: unknown;
  /** Value that marks "deleted". Defaults to `0`. */
  deletedValue?: unknown;
}

export interface TimestampMetadata<T> {
  createdAt?: Extract<keyof T, string>;
  updatedAt?: Extract<keyof T, string>;
}

/**
 * Columns that record *who* wrote, the counterpart of `timestamps`, which
 * records *when*. The value comes from the request context, so no service has
 * to drag the user all the way down to the CRUD.
 */
export interface AuditMetadata<T> {
  createdBy?: Extract<keyof T, string>;
  updatedBy?: Extract<keyof T, string>;
}

/**
 * What a foreign key points at.
 *
 * Declarative and inert: **the repository does not read this**. It still knows
 * exactly one table, still fires no join, and a relation declared here changes
 * nothing about how a row is selected, inserted or filtered. Composing across
 * aggregates stays a decision of the layer above, which is where the rules are.
 *
 * What it adds is the ability to answer *what does this column point at*, and
 * three separate things need that answer and were each restating it:
 *
 *  - the include a service declares, which had to repeat both keys by hand;
 *  - generated DDL, which has no other source for a `FOREIGN KEY` constraint;
 *  - `monolite generate module`, which cannot scaffold a related module without
 *    knowing there is a relation.
 *
 * One statement of a fact that was being made three times is worth the type.
 */
export interface RelationMetadata<T> {
  /** The related entity's registered name — its `table`. */
  to: string;
  /** The property on *this* entity that holds the key. */
  localKey: Extract<keyof T, string>;
  /** The property on the related entity that it matches. */
  foreignKey: string;
  /**
   * What the generated DDL should say, and **only** that.
   *
   * The repository enforces none of it: there is no cascade to run and no
   * restriction to check, because nothing here reads relations at query time.
   * Saying so in the type is what stops somebody expecting a delete to cascade
   * through a layer that never looks.
   *
   * Defaults to `restrict`, which is the choice that fails loudly rather than
   * quietly removing rows nobody named.
   */
  onDelete?: "restrict" | "cascade" | "set null" | "no action";
  /** `false` for a key that may be empty. Defaults to `true`. */
  optional?: boolean;
}

export interface EntityMetadata<T> {
  table: string;
  primaryKey: Extract<keyof T, string>;
  /** `true` (the default) if the database generates the PK: IDENTITY or a sequence. */
  identity?: boolean;
  columns: Record<Extract<keyof T, string>, ColumnDefinition>;
  /** If omitted, the entity does not support soft deletes. */
  softDelete?: SoftDeleteMetadata<T>;
  timestamps?: TimestampMetadata<T>;
  /** If omitted, the entity does not record who created or modified it. */
  audit?: AuditMetadata<T>;
  /**
   * `true` so that every write leaves a line in the change log. It is opt-in:
   * the change-log table itself must not enable it, and not every entity is
   * worth the cost of an extra row per operation.
   */
  auditTrail?: boolean;
  /**
   * What this entity's foreign keys point at, by the name the reader will use
   * for them. Read by the layers above and by the DDL generator; never by the
   * repository. See `RelationMetadata`.
   */
  relations?: Record<string, RelationMetadata<T>>;
  /** Composite and lookup indexes. Read by the DDL generator only. */
  indexes?: IndexMetadata<T>[];
}

/**
 * Identity helper: it exists only so that TypeScript infers `T` and checks that
 * `columns` covers every property of the model.
 */
export function defineEntity<T>(metadata: EntityMetadata<T>): EntityMetadata<T> {
  return metadata;
}

/**
 * Normalized view of `EntityMetadata`: it resolves the shorthands, indexes by
 * column and centralizes the type conversions between the database row and the
 * entity.
 */
export class EntitySchema<T> {
  private readonly byProperty = new Map<string, ColumnMetadata>();
  private readonly propertyByColumn = new Map<string, string>();

  constructor(public readonly metadata: EntityMetadata<T>) {
    for (const [property, definition] of Object.entries(metadata.columns) as [
      string,
      ColumnDefinition,
    ][]) {
      const column: ColumnMetadata =
        typeof definition === "string" ? { name: definition } : { ...definition };

      column.kind = column.kind ?? "string";
      column.insertable = column.insertable ?? true;
      column.updatable = column.updatable ?? true;

      this.byProperty.set(property, column);
      // Oracle returns identifiers in upper case; indexing like this lets us
      // resolve the row without depending on how the SELECT spelled it.
      this.propertyByColumn.set(column.name.toUpperCase(), property);
    }
  }

  get table(): string {
    return this.metadata.table;
  }

  get primaryKey(): Extract<keyof T, string> {
    return this.metadata.primaryKey;
  }

  get isIdentity(): boolean {
    return this.metadata.identity !== false;
  }

  get softDelete(): SoftDeleteMetadata<T> | undefined {
    return this.metadata.softDelete;
  }

  get softDeleteActiveValue(): unknown {
    return this.metadata.softDelete?.activeValue ?? 1;
  }

  get softDeleteDeletedValue(): unknown {
    return this.metadata.softDelete?.deletedValue ?? 0;
  }

  get timestamps(): TimestampMetadata<T> | undefined {
    return this.metadata.timestamps;
  }

  get audit(): AuditMetadata<T> | undefined {
    return this.metadata.audit;
  }

  get auditTrail(): boolean {
    return this.metadata.auditTrail === true;
  }

  get properties(): Extract<keyof T, string>[] {
    return [...this.byProperty.keys()] as Extract<keyof T, string>[];
  }

  has(property: string): boolean {
    return this.byProperty.has(property);
  }

  /**
   * Column name of a property. Throws if the property is not mapped: it is the
   * barrier that keeps an arbitrary name from reaching the generated SQL.
   */
  columnOf(property: string): string {
    const column = this.byProperty.get(property);
    if (!column) {
      throw new Error(
        `[EntitySchema] The property "${property}" is not mapped in ${this.table}. ` +
          `Valid properties: ${this.properties.join(", ")}.`
      );
    }
    return column.name;
  }

  kindOf(property: string): ColumnKind {
    return this.byProperty.get(property)?.kind ?? "string";
  }

  /**
   * Decimals a `decimal` property is rounded to. Two by default, which is what
   * a currency is; on any other kind the question does not arise and the answer
   * is not used.
   */
  scaleOf(property: string): number {
    return this.byProperty.get(property)?.scale ?? DEFAULT_DECIMAL_SCALE;
  }

  /**
   * Rounds a `decimal` property to its scale, and returns anything else exactly
   * as it came.
   *
   * It is public because the in-memory driver needs it and cannot get it any
   * other way. The SQL and document drivers pass every value through
   * `toColumnValue` on the way in and `toEntity` on the way out, so they are
   * quantized already; the memory driver stores the object it was handed, which
   * is the whole reason it is fast — and the reason it was the one driver where
   * `0.1 + 0.2` stayed `0.30000000000000004` while every real engine wrote
   * `0.30`. A suite that runs on memory and a deployment that runs on
   * PostgreSQL have to agree about that, or the suite is not evidence.
   */
  quantize(property: string, value: unknown): unknown {
    if (this.kindOf(property) !== "decimal") return value;
    if (value === undefined || value === null) return value;

    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? roundTo(numeric, this.scaleOf(property)) : value;
  }

  /**
   * The column as declared, with the shorthands already resolved.
   *
   * The DDL generator wants the whole thing — width, nullability, default — and
   * without this every caller would re-normalize `ColumnDefinition` for itself,
   * which is how two readers of one mapping start disagreeing about it.
   */
  columnMetadataOf(property: string): ColumnMetadata {
    const column = this.byProperty.get(property);
    if (!column) {
      throw new Error(
        `[EntitySchema] The property "${property}" is not mapped in ${this.table}. ` +
          `Valid properties: ${this.properties.join(", ")}.`
      );
    }
    return column;
  }

  isInsertable(property: string): boolean {
    return this.byProperty.get(property)?.insertable ?? false;
  }

  isUpdatable(property: string): boolean {
    return this.byProperty.get(property)?.updatable ?? false;
  }

  /** Properties that can be written in an INSERT (an IDENTITY PK is left out). */
  insertableProperties(): Extract<keyof T, string>[] {
    return this.properties.filter(
      (p) => this.isInsertable(p) && !(this.isIdentity && p === this.primaryKey)
    );
  }

  updatableProperties(): Extract<keyof T, string>[] {
    return this.properties.filter((p) => this.isUpdatable(p) && p !== this.primaryKey);
  }

  /** Converts a value from the entity into the format the database expects. */
  toColumnValue(property: string, value: unknown): unknown {
    if (value === undefined || value === null) return null;

    switch (this.kindOf(property)) {
      case "boolean":
        return value ? 1 : 0;
      case "number":
        return typeof value === "number" ? value : Number(value);
      // Rounded on the way in as well as on the way out, so that what the
      // column holds is what the entity said. Left to the engine, a third
      // decimal is silently dropped by one and rejected by another.
      case "decimal":
        return this.quantize(property, typeof value === "number" ? value : Number(value));
      case "date":
        return value instanceof Date ? value : new Date(String(value));
      default:
        return value;
    }
  }

  /** Converts a value from the database into the model's type. */
  toEntityValue(property: string, value: unknown): unknown {
    if (value === undefined || value === null) return null;

    switch (this.kindOf(property)) {
      case "boolean":
        return value === 1 || value === "1" || value === true;
      case "number":
        return typeof value === "number" ? value : Number(value);
      // PostgreSQL and Oracle hand a NUMERIC back as a string precisely because
      // a double cannot always hold it. Turning it into one is what the entity
      // asked for; rounding it to the declared scale is what keeps the double's
      // approximation from being read as a value somebody can be charged.
      case "decimal":
        return this.quantize(property, typeof value === "number" ? value : Number(value));
      case "date":
        return value instanceof Date ? value : new Date(String(value));
      case "string":
        return typeof value === "string" ? value : String(value);
      default:
        return value;
    }
  }

  /**
   * Maps a raw row (keys = column names) to the domain entity. Missing columns
   * —with a projection, for instance— are simply left out instead of showing up
   * as `undefined`.
   */
  toEntity(row: Record<string, unknown>): T {
    const entity: Record<string, unknown> = {};

    for (const [rawColumn, rawValue] of Object.entries(row)) {
      const property = this.propertyByColumn.get(rawColumn.toUpperCase());
      if (!property) continue;
      entity[property] = this.toEntityValue(property, rawValue);
    }

    return entity as T;
  }
}
