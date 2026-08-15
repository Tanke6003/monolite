// NOTE ON THE OPTIONAL DRIVER: only the `ClientSession` type is taken from
// `mongodb`, and `import type` is erased at compile time, so nothing is required
// at runtime. If a value from the driver were ever needed here, the import would
// have to become a lazy `await import("mongodb")`, otherwise a consumer that
// only uses PostgreSQL would be forced to install the optional peer dependency.
import type { ClientSession } from "mongodb";
import type { AuditEntry, IAuditLog, IAuditTrail } from "../contracts/audit-trail";
import type { IGenericRepository } from "../contracts/generic-repository";
import type { ISqlExecutor } from "../contracts/sql-executor";
import { SqlGenericRepository } from "../drivers/sql-generic-repository";
import { MongoGenericRepository } from "../drivers/mongo-generic-repository";

/** Cap on the serialized detail, so the table does not fill up with huge payloads. */
const MAX_CHANGES_LENGTH = 4000;

function serialize(changes?: Record<string, unknown>): string | null {
  if (!changes) return null;

  const json = JSON.stringify(changes, (_key, value) =>
    value instanceof Date ? value.toISOString() : value
  );

  if (!json) return null;
  return json.length > MAX_CHANGES_LENGTH ? `${json.slice(0, MAX_CHANGES_LENGTH - 3)}...` : json;
}

/**
 * Builds the change-log row. It is shared between implementations so that
 * memory, SQL and MongoDB record exactly the same thing.
 */
function toRow(entry: AuditEntry): Partial<IAuditLog> {
  return {
    entity: entry.entity,
    entityId: entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
    action: entry.action,
    changedBy: entry.actor.changedBy,
    requestId: entry.actor.requestId,
    changes: serialize(entry.changes),
  };
}

/**
 * Change log over a SQL database.
 *
 * It writes through the same executor as the audited operation, so inside a
 * transaction it lands in the same commit and disappears with the rollback.
 */
export class SqlAuditTrail implements IAuditTrail {
  constructor(private readonly repository: SqlGenericRepository<IAuditLog>) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.repository.insert(toRow(entry));
  }

  bindTo(scope?: unknown): IAuditTrail {
    return new SqlAuditTrail(
      this.repository.withExecutor(scope as ISqlExecutor) as SqlGenericRepository<IAuditLog>
    );
  }
}

/**
 * Change log over MongoDB.
 *
 * Same idea as the SQL one: it writes through the same scope as the audited
 * operation. Here that scope is the session, so inside a transaction the line
 * lands in the same commit and disappears with the rollback.
 */
export class MongoAuditTrail implements IAuditTrail {
  constructor(private readonly repository: MongoGenericRepository<IAuditLog>) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.repository.insert(toRow(entry));
  }

  bindTo(scope?: unknown): IAuditTrail {
    return new MongoAuditTrail(
      this.repository.withSession(scope as ClientSession) as MongoGenericRepository<IAuditLog>
    );
  }
}

/** In-memory change log, for the database-less mode and for the tests. */
export class MemoryAuditTrail implements IAuditTrail {
  constructor(private readonly repository: IGenericRepository<IAuditLog>) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.repository.insert(toRow(entry));
  }

  /** In memory there are no per-connection transactions: the same instance serves. */
  bindTo(): IAuditTrail {
    return this;
  }
}
