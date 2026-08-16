import { defineEntity, type IAuditLog } from "@monolite/data";
import type { ILogger } from "@monolite/core";
import type { IEnvs } from "@monolite/di";

/** Toy entity. The wiring never looks inside one, so two columns are plenty. */
export interface IWidget {
  pkWidget: number;
  name: string;
  active?: boolean;
}

export const WIDGET_ENTITY = defineEntity<IWidget>({
  table: "WIDGETS",
  primaryKey: "pkWidget",
  identity: true,
  columns: {
    pkWidget: { name: "PK_WIDGET", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string" },
    active: { name: "ACTIVE", kind: "boolean" },
  },
  softDelete: { property: "active", activeValue: 1, deletedValue: 0 },
});

export interface IGadget {
  code: string;
  label: string;
}

export const GADGET_ENTITY = defineEntity<IGadget>({
  table: "GADGETS",
  primaryKey: "code",
  identity: false,
  columns: {
    code: { name: "CODE", kind: "string" },
    label: { name: "LABEL", kind: "string" },
  },
});

/** The change log the audit trail writes into; it deliberately audits nothing. */
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

/**
 * Configuration as a plain object.
 *
 * `IEnvs` is one method precisely so a test does not have to touch
 * `process.env`, which is global state two tests running in the same worker
 * would then be sharing.
 */
export function envsFrom(values: Record<string, string>): IEnvs {
  return { getEnv: (key: string) => values[key] ?? "" };
}

/** Silent logger. What is under test is the wiring, not what it says about it. */
export function silentLogger(): ILogger {
  return {
    log: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
}
