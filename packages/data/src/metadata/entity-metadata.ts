/**
 * Entity <-> table mapping, in the style of EF Core's `ModelBuilder` but
 * without decorators: domain models stay pure interfaces and here, in the
 * infrastructure layer, is where how they are persisted gets declared.
 *
 * With this description, `SqlGenericRepository`, `MongoGenericRepository` and
 * `MemoryGenericRepository` know how to generate the whole CRUD without a
 * single hand-written line of SQL.
 */

export type ColumnKind = "number" | "string" | "boolean" | "date";

export interface ColumnMetadata {
  /** Physical column name. */
  name: string;
  /** Logical type; it governs the JS <-> DB conversions. Defaults to "string". */
  kind?: ColumnKind;
  /** `false` for columns the database computes (e.g. IDENTITY). */
  insertable?: boolean;
  /** `false` for immutable columns (e.g. CREATED_AT). */
  updatable?: boolean;
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
