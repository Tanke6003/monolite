import { defineEntity } from "monolite-data";
import type { I__entityName__ } from "../../../domain/models/__entityKebab__.model";

/**
 * How `I__entityName__` is stored.
 *
 * This is the only file in the module that names a column. From this
 * description the generic repository generates the whole CRUD —select, insert,
 * update, soft delete, paging, filtering— for whichever engine is configured,
 * so renaming a physical column is a one-line change here and nothing else.
 *
 * The application does not create the table, and it never will: a process that
 * alters a schema on boot is a process that alters production on a bad deploy.
 * What it will do is write the DDL for you — `db:sql` emits it from exactly
 * this description, and `db:migration` writes what changed since the last one.
 * Apply either with whatever this project already uses.
 *
 * The widths and the nullability below exist for that generator and for nothing
 * else. The repository has never needed to know how long a column is; it binds
 * values and lets the engine check them. Leaving them off still maps, still
 * queries and still writes — it only generates a schema with the defaults
 * (`VARCHAR(255)`, nullable).
 */
export const __entityConst__ = defineEntity<I__entityName__>({
  table: "__entityPluralUpper__",
  primaryKey: "__pkProperty__",
  /** The database generates the key: IDENTITY, SERIAL or a sequence. */
  identity: true,
  columns: {
    __pkProperty__: { name: "__pkColumn__", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string", length: 150, nullable: false },
    description: { name: "DESCRIPTION", kind: "string", length: 500 },
    // Not a `BOOLEAN` column, whatever your engine calls one: the mapping
    // writes `1` and `0` (see `activeValue` below), and PostgreSQL's BOOLEAN
    // refuses an integer. The generated DDL emits the integer type that matches,
    // which is the sort of agreement generating it is for.
    available: { name: "AVAILABLE", kind: "boolean", nullable: false, default: "1" },
    createdAt: { name: "CREATED_AT", kind: "date", updatable: false },
    updatedAt: { name: "UPDATED_AT", kind: "date" },
    createdBy: { name: "CREATED_BY", kind: "string", length: 100, updatable: false },
    updatedBy: { name: "UPDATED_BY", kind: "string", length: 100 },
  },
  /** Rows are deactivated, not removed, so anything referencing them survives. */
  softDelete: { property: "available", activeValue: 1, deletedValue: 0 },
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  audit: { createdBy: "createdBy", updatedBy: "updatedBy" },
  // `auditTrail: true` would make every write leave a row in a change-log
  // table. It is off here because that table —and the IAuditTrail wired to it—
  // is not part of the scaffold; turn it on once you have both.
});
