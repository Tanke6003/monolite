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
 * The application does not create the table. Add it to your migrations or to
 * the init scripts under `docker/`.
 */
export const __entityConst__ = defineEntity<I__entityName__>({
  table: "__entityPluralUpper__",
  primaryKey: "__pkProperty__",
  /** The database generates the key: IDENTITY, SERIAL or a sequence. */
  identity: true,
  columns: {
    __pkProperty__: { name: "__pkColumn__", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string" },
    description: { name: "DESCRIPTION", kind: "string" },
    available: { name: "AVAILABLE", kind: "boolean" },
    createdAt: { name: "CREATED_AT", kind: "date", updatable: false },
    updatedAt: { name: "UPDATED_AT", kind: "date" },
    createdBy: { name: "CREATED_BY", kind: "string", updatable: false },
    updatedBy: { name: "UPDATED_BY", kind: "string" },
  },
  /** Rows are deactivated, not removed, so anything referencing them survives. */
  softDelete: { property: "available", activeValue: 1, deletedValue: 0 },
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  audit: { createdBy: "createdBy", updatedBy: "updatedBy" },
  // `auditTrail: true` would make every write leave a row in a change-log
  // table. It is off here because that table —and the IAuditTrail wired to it—
  // is not part of the scaffold; turn it on once you have both.
});
