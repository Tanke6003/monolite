export const AUDIT_ACTIONS = [
  "INSERT",
  "INSERT_MANY",
  "UPDATE",
  "UPDATE_MANY",
  "SOFT_DELETE",
  "RESTORE",
  "HARD_DELETE",
  "HARD_DELETE_MANY",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * One line of the change log: what was touched, by whom and when.
 *
 * It complements the `CREATED_BY` / `UPDATED_BY` columns, which only hold the
 * latest state. The log keeps the full history, including rows that have
 * already been hard deleted.
 */
export interface IAuditLog {
  pkAudit: number;
  /** Logical entity name (see the application's entity names). */
  entity: string;
  /** Affected PK; null for bulk operations, which do not point at a single one. */
  entityId?: string | null;
  action: AuditAction;
  changedBy: string;
  changedAt?: Date | null;
  /** Id of the request that caused it; makes it possible to rebuild a whole operation. */
  requestId?: string | null;
  /** JSON detail: the new values, or the before and after of an update. */
  changes?: string | null;
}

/**
 * Who made the change, captured when the operation **starts**.
 *
 * It is not read at the moment of recording: by then several round trips to the
 * database have already happened, and a pool may resolve its callbacks in the
 * context where it was created, not in the request's one. The identity is taken
 * before the first await and carried along.
 */
export interface AuditActor {
  changedBy: string;
  requestId: string | null;
}

export interface AuditEntry {
  entity: string;
  actor: AuditActor;
  entityId?: unknown;
  action: AuditAction;
  /**
   * Detail of the operation. On an update it carries `{ before, after }`; on an
   * insert, the written values; on a bulk operation, the filter and how many
   * rows it affected.
   */
  changes?: Record<string, unknown>;
}

/**
 * Change log.
 *
 * The generic repository writes it after every write operation, so no service
 * has to remember to record anything.
 *
 * It is written through the same *executor* as the audited operation: inside a
 * transaction it lands in the same commit, and if the transaction is rolled
 * back the log line disappears with it. A failure while recording fails the
 * operation —a log that silently loses entries is no use for auditing—.
 */
export interface IAuditTrail {
  record(entry: AuditEntry): Promise<void>;

  /**
   * A copy bound to the transaction in progress, so the log line lands in the
   * same commit as the audited operation.
   *
   * What the scope represents depends on the engine —an executor in SQL, a
   * session in MongoDB—, and that is why it arrives untyped: each
   * implementation knows what it expects and the rest ignore it.
   */
  bindTo(scope?: unknown): IAuditTrail;
}
