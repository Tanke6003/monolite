import { defineEntity, type IAuditLog } from "monolite-data";

/** Toy entity: it covers every column type the mapping supports. */
export interface ITestItem {
  pkItem: number;
  name: string;
  qty: number;
  tag?: string | null;
  flag?: boolean;
  dueAt?: Date | null;
  active?: boolean;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export const TEST_ENTITY = defineEntity<ITestItem>({
  table: "ITEMS",
  primaryKey: "pkItem",
  identity: true,
  columns: {
    pkItem: { name: "PK_ITEM", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string" },
    qty: { name: "QTY", kind: "number" },
    tag: { name: "TAG", kind: "string" },
    flag: { name: "FLAG", kind: "boolean" },
    dueAt: { name: "DUE_AT", kind: "date" },
    active: { name: "ACTIVE", kind: "boolean" },
    createdAt: { name: "CREATED_AT", kind: "date", updatable: false },
    updatedAt: { name: "UPDATED_AT", kind: "date" },
  },
  softDelete: { property: "active", activeValue: 1, deletedValue: 0 },
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
});

/** Variant with neither soft delete nor timestamps, for the alternative paths. */
export interface IPlainItem {
  code: string;
  label: string;
}

export const PLAIN_ENTITY = defineEntity<IPlainItem>({
  table: "PLAIN",
  primaryKey: "code",
  identity: false,
  columns: {
    code: { name: "CODE", kind: "string" },
    label: { name: "LABEL", kind: "string" },
  },
});

export const SEED: Partial<ITestItem>[] = [
  { name: "alpha", qty: 10, tag: "x", flag: true, dueAt: new Date("2026-01-10T10:00:00Z") },
  { name: "beta", qty: 20, tag: null, flag: false, dueAt: new Date("2026-02-10T10:00:00Z") },
  { name: "gamma", qty: 30, tag: "y", flag: true, dueAt: new Date("2026-03-10T10:00:00Z") },
];

/** Variant with the user-audit columns. */
export interface IAuditedItem {
  pkItem: number;
  name: string;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export const AUDITED_ENTITY = defineEntity<IAuditedItem>({
  table: "AUDITED",
  primaryKey: "pkItem",
  identity: true,
  columns: {
    pkItem: { name: "PK_ITEM", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string" },
    createdBy: { name: "CREATED_BY", kind: "string", updatable: false },
    updatedBy: { name: "UPDATED_BY", kind: "string" },
  },
  audit: { createdBy: "createdBy", updatedBy: "updatedBy" },
});

/** Same as the previous one, and with soft delete on top. */
export const AUDITED_SOFT_ENTITY = defineEntity<IAuditedItem & { active?: boolean }>({
  table: "AUDITED_SOFT",
  primaryKey: "pkItem",
  identity: true,
  columns: {
    pkItem: { name: "PK_ITEM", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string" },
    active: { name: "ACTIVE", kind: "boolean" },
    createdBy: { name: "CREATED_BY", kind: "string", updatable: false },
    updatedBy: { name: "UPDATED_BY", kind: "string" },
  },
  softDelete: { property: "active", activeValue: 1, deletedValue: 0 },
  audit: { createdBy: "createdBy", updatedBy: "updatedBy" },
});

/**
 * Change-log table.
 *
 * The original project shipped this mapping alongside its own entities; the
 * package only ships the `IAuditLog` contract, so the tests declare the table
 * the audit trail writes into. Note that it deliberately does **not** set
 * `auditTrail: true`: a change log that audits itself would recurse.
 */
export const AUDIT_LOG_ENTITY = defineEntity<IAuditLog>({
  table: "AUDIT_LOG",
  primaryKey: "pkAudit",
  identity: true,
  columns: {
    pkAudit: { name: "PK_AUDIT", kind: "number", insertable: false, updatable: false },
    entity: { name: "ENTITY", kind: "string" },
    entityId: { name: "ENTITY_ID", kind: "string" },
    action: { name: "ACTION", kind: "string" },
    changedBy: { name: "CHANGED_BY", kind: "string" },
    changedAt: { name: "CHANGED_AT", kind: "date", updatable: false },
    requestId: { name: "REQUEST_ID", kind: "string" },
    changes: { name: "CHANGES", kind: "string" },
  },
  timestamps: { createdAt: "changedAt" },
});
