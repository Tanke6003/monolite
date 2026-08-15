import type { IRequestContext } from "@monolite/core";
import { SYSTEM_USER } from "@monolite/core";
import type {
  IGenericRepository,
  IQueryable,
  PagedResult,
  QueryOptions,
  WhereFilter,
} from "../contracts/generic-repository.js";
import type { AuditAction, AuditActor, IAuditTrail } from "../contracts/audit-trail.js";
import { EntityMetadata, EntitySchema } from "../metadata/entity-metadata.js";
import { compareBy, matchesFilter } from "../query/memory-filter.js";
import { QueryBuilder } from "../query/query-builder.js";
import { normalizeOrderBy } from "../query/filter-helpers.js";

/**
 * Same semantics as `SqlGenericRepository`, but over an in-memory array.
 *
 * It exists so that the in-memory data source stays a complete development
 * mode: the web interface and the tests work without bringing Docker up, and
 * the service and controller code is exactly the same as against a real engine.
 */
/** Copy of the internal state; the unit of work uses it to roll back. */
export interface MemorySnapshot<T> {
  rows: T[];
  sequence: number;
}

export class MemoryGenericRepository<T extends object, TKey = number>
  implements IGenericRepository<T, TKey>
{
  readonly schema: EntitySchema<T>;
  private readonly store: T[];
  private sequence = 0;

  constructor(
    metadata: EntityMetadata<T>,
    seed: Partial<T>[] = [],
    /** Provides the audit user. Without it everything is written as "System". */
    private readonly context?: IRequestContext,
    /** Change log; it only acts if the entity has it enabled. */
    private readonly auditTrail?: IAuditTrail
  ) {
    this.schema = new EntitySchema(metadata);
    this.store = [];
    for (const entity of seed) {
      this.insertSync(entity);
    }
  }

  /** User recorded in the audit columns. */
  private auditUser(): string {
    return this.context?.getCurrentUserName() ?? SYSTEM_USER;
  }

  /** The change log is opt-in per entity, just as in the SQL repository. */
  private trailEnabled(): boolean {
    return Boolean(this.auditTrail && this.schema.auditTrail);
  }

  /**
   * Snapshot of who is asking, taken before the operation's first await. After
   * that it is no longer reliable: the driver's pool may resolve its callbacks
   * in the context where it was created and not in the request's one.
   */
  private captureActor(): AuditActor {
    return {
      changedBy: this.auditUser(),
      requestId: this.context?.getRequestId() ?? null,
    };
  }

  private async recordAudit(
    actor: AuditActor,
    action: AuditAction,
    entityId?: unknown,
    changes?: Record<string, unknown>
  ): Promise<void> {
    if (!this.trailEnabled()) return;
    await this.auditTrail!.record({
      entity: this.schema.table,
      actor,
      entityId,
      action,
      changes,
    });
  }

  // ------------------------------------------------------------ helpers ----

  /** Defensive copy: whoever reads must not be able to mutate the store. */
  private clone(entity: T, select?: Extract<keyof T, string>[]): T {
    if (!select?.length) return { ...entity };

    const projected: Record<string, unknown> = {};
    for (const property of select) {
      // Validates the property just as the generated SELECT would.
      this.schema.columnOf(property);
      projected[property] = (entity as Record<string, unknown>)[property];
    }
    return projected as T;
  }

  private isActive(entity: T): boolean {
    const softDelete = this.schema.softDelete;
    if (!softDelete) return true;

    const value = (entity as Record<string, unknown>)[softDelete.property];
    const active = this.schema.softDeleteActiveValue;
    // The model stores booleans; the metadata expresses the value in terms of
    // the column (1/0). They are compared normalized.
    return this.schema.toColumnValue(softDelete.property, value) === (active ? 1 : 0);
  }

  private applyFilters(options: QueryOptions<T>): T[] {
    let rows = this.store.filter((entity) => matchesFilter(entity, options.where, this.schema));

    if (!options.withDeleted) {
      rows = rows.filter((entity) => this.isActive(entity));
    }

    const orderBy = normalizeOrderBy(options.orderBy);
    if (orderBy.length > 0) {
      rows = [...rows].sort((left, right) => {
        for (const clause of orderBy) {
          // Validates the property before ordering by it.
          this.schema.columnOf(clause.field);
          const result = compareBy(
            (left as Record<string, unknown>)[clause.field],
            (right as Record<string, unknown>)[clause.field],
            clause.direction
          );
          if (result !== 0) return result;
        }
        return 0;
      });
    }

    return rows;
  }

  private findEntity(id: TKey): T | undefined {
    return this.store.find(
      (entity) => (entity as Record<string, unknown>)[this.schema.primaryKey] === id
    );
  }

  // --------------------------------------------------------------- reads ---

  async find(options: QueryOptions<T> = {}): Promise<T[]> {
    let rows = this.applyFilters(options);

    const skip = options.skip ?? 0;
    if (skip > 0) rows = rows.slice(skip);
    if (options.take !== undefined) rows = rows.slice(0, options.take);

    return rows.map((entity) => this.clone(entity, options.select));
  }

  getAll(options: QueryOptions<T> = {}): Promise<T[]> {
    return this.find(options);
  }

  async firstOrDefault(options: QueryOptions<T> = {}): Promise<T | null> {
    const rows = await this.find({ ...options, take: 1 });
    return rows[0] ?? null;
  }

  async getById(
    id: TKey,
    options: Pick<QueryOptions<T>, "select" | "withDeleted"> = {}
  ): Promise<T | null> {
    return this.firstOrDefault({
      where: { [this.schema.primaryKey]: id } as WhereFilter<T>,
      select: options.select,
      withDeleted: options.withDeleted,
    });
  }

  async count(where?: WhereFilter<T>, withDeleted?: boolean): Promise<number> {
    return this.applyFilters({ where, withDeleted }).length;
  }

  async exists(where: WhereFilter<T>, withDeleted?: boolean): Promise<boolean> {
    return (await this.count(where, withDeleted)) > 0;
  }

  async getPaged(
    page: number,
    limit: number,
    options: Omit<QueryOptions<T>, "skip" | "take"> = {}
  ): Promise<PagedResult<T>> {
    const safePage = Math.max(1, Math.trunc(page) || 1);
    const safeLimit = Math.max(1, Math.trunc(limit) || 1);

    const rows = this.applyFilters(options);
    const items = rows
      .slice((safePage - 1) * safeLimit, (safePage - 1) * safeLimit + safeLimit)
      .map((entity) => this.clone(entity, options.select));

    return {
      items,
      total: rows.length,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(rows.length / safeLimit),
    };
  }

  // -------------------------------------------------------------- writes ---

  /** Synchronous version, also used to load the seed in the constructor. */
  private insertSync(entity: Partial<T>): T {
    const record: Record<string, unknown> = {};
    const { createdBy, updatedBy } = this.schema.audit ?? {};

    for (const property of this.schema.properties) {
      // Auditing comes from the context, never from the request body.
      if (property === createdBy || property === updatedBy) continue;

      const value = (entity as Record<string, unknown>)[property];
      if (value !== undefined) record[property] = value;
    }

    // Same criterion as in SQL: the check happens before adding the PK, the
    // state and the timestamps, so that an insert with no data does not slip
    // through.
    if (Object.keys(record).length === 0) {
      throw new Error(
        `[MemoryGenericRepository] insert into ${this.schema.table} with no columns to write.`
      );
    }

    if (this.schema.isIdentity) {
      this.sequence += 1;
      record[this.schema.primaryKey] = this.sequence;
    } else {
      const provided = record[this.schema.primaryKey];
      if (provided === undefined) {
        throw new Error(
          `[MemoryGenericRepository] ${this.schema.table} does not use identity: the PK is mandatory.`
        );
      }
    }

    const softDelete = this.schema.softDelete;
    if (softDelete && record[softDelete.property] === undefined) {
      record[softDelete.property] = true;
    }

    const { createdAt, updatedAt } = this.schema.timestamps ?? {};
    if (createdAt) record[createdAt] = new Date();
    if (updatedAt && record[updatedAt] === undefined) record[updatedAt] = null;

    if (createdBy) record[createdBy] = this.auditUser();
    if (updatedBy) record[updatedBy] = null;

    const stored = record as T;
    this.store.push(stored);
    return stored;
  }

  async insert(entity: Partial<T>): Promise<T> {
    const actor = this.captureActor();
    const created = this.clone(this.insertSync(entity));
    await this.recordAudit(actor, "INSERT", (created as Record<string, unknown>)[this.schema.primaryKey], {
      after: created as Record<string, unknown>,
    });
    return created;
  }

  async insertMany(entities: Partial<T>[]): Promise<number> {
    const actor = this.captureActor();
    entities.forEach((entity) => this.insertSync(entity));
    await this.recordAudit(actor, "INSERT_MANY", undefined, { affected: entities.length });
    return entities.length;
  }

  /** Applies the changes to the stored record; returns whether it touched anything. */
  private applyChanges(entity: T, changes: Partial<T>): boolean {
    const { updatedAt } = this.schema.timestamps ?? {};
    const { createdBy, updatedBy } = this.schema.audit ?? {};
    const record = entity as Record<string, unknown>;
    let touched = false;

    for (const property of this.schema.updatableProperties()) {
      if (property === updatedAt || property === createdBy || property === updatedBy) continue;

      const value = (changes as Record<string, unknown>)[property];
      if (value === undefined) continue;

      record[property] = value;
      touched = true;
    }

    if (touched && updatedAt) record[updatedAt] = new Date();
    if (touched && updatedBy) record[updatedBy] = this.auditUser();
    return touched;
  }

  async update(id: TKey, changes: Partial<T>): Promise<T | null> {
    const actor = this.captureActor();
    const entity = this.findEntity(id);
    if (!entity || !this.isActive(entity)) return null;

    const before = this.trailEnabled() ? this.clone(entity) : null;
    this.applyChanges(entity, changes);
    const updated = this.clone(entity);

    await this.recordAudit(actor, "UPDATE", id, {
      before: before as Record<string, unknown> | null,
      after: updated as Record<string, unknown>,
    });

    return updated;
  }

  async updateWhere(where: WhereFilter<T>, changes: Partial<T>): Promise<number> {
    const actor = this.captureActor();
    const targets = this.applyFilters({ where });
    let affected = 0;

    for (const entity of targets) {
      if (this.applyChanges(entity, changes)) affected += 1;
    }

    await this.recordAudit(actor, "UPDATE_MANY", undefined, {
      changes: changes as Record<string, unknown>,
      affected,
    });

    return affected;
  }

  // -------------------------------------------------------------- deletes --

  private setSoftDeleteFlag(id: TKey, deleted: boolean): boolean {
    const softDelete = this.schema.softDelete;
    if (!softDelete) {
      throw new Error(
        `[MemoryGenericRepository] The entity ${this.schema.table} does not declare softDelete; ` +
          "use hardDelete or add the metadata."
      );
    }

    const entity = this.findEntity(id);
    if (!entity) return false;
    // Idempotent: deleting twice returns `false` the second time.
    if (this.isActive(entity) === !deleted) return false;

    const record = entity as Record<string, unknown>;
    record[softDelete.property] = !deleted;

    const { updatedAt } = this.schema.timestamps ?? {};
    if (updatedAt) record[updatedAt] = new Date();

    // A soft delete is a modification: it has to leave a trace of who did it.
    const { updatedBy } = this.schema.audit ?? {};
    if (updatedBy) record[updatedBy] = this.auditUser();

    return true;
  }

  async softDelete(id: TKey): Promise<boolean> {
    const actor = this.captureActor();
    const deleted = this.setSoftDeleteFlag(id, true);
    if (deleted) await this.recordAudit(actor, "SOFT_DELETE", id);
    return deleted;
  }

  async restore(id: TKey): Promise<boolean> {
    const actor = this.captureActor();
    const restored = this.setSoftDeleteFlag(id, false);
    if (restored) await this.recordAudit(actor, "RESTORE", id);
    return restored;
  }

  async hardDelete(id: TKey): Promise<boolean> {
    const actor = this.captureActor();
    const index = this.store.findIndex(
      (entity) => (entity as Record<string, unknown>)[this.schema.primaryKey] === id
    );
    if (index === -1) return false;

    // The row is about to disappear: if there is a change log, its last state
    // is kept.
    const before = this.trailEnabled() ? this.clone(this.store[index]) : null;
    this.store.splice(index, 1);

    await this.recordAudit(actor, "HARD_DELETE", id, {
      before: before as Record<string, unknown> | null,
    });
    return true;
  }

  async hardDeleteWhere(where: WhereFilter<T>): Promise<number> {
    const actor = this.captureActor();
    // `withDeleted` so that it also reaches the soft-deleted records.
    const targets = new Set(this.applyFilters({ where, withDeleted: true }));
    if (targets.size === 0) return 0;

    const survivors = this.store.filter((entity) => !targets.has(entity));
    const removed = this.store.length - survivors.length;
    this.store.splice(0, this.store.length, ...survivors);

    await this.recordAudit(actor, "HARD_DELETE_MANY", undefined, { affected: removed });
    return removed;
  }

  query(): IQueryable<T> {
    return new QueryBuilder<T, TKey>(this);
  }

  // -------------------------------------------------------- unit of work ---

  /**
   * Snapshot of the store. In memory there are no real transactions, so the way
   * to emulate a rollback is to save the state before starting.
   */
  snapshot(): MemorySnapshot<T> {
    return {
      rows: this.store.map((entity) => ({ ...entity })),
      sequence: this.sequence,
    };
  }

  /** Restores a previous snapshot, discarding everything written since then. */
  restoreSnapshot(state: MemorySnapshot<T>): void {
    // `splice` instead of reassigning: `store` is readonly and other references
    // to the array must see the restored state.
    this.store.splice(0, this.store.length, ...state.rows.map((entity) => ({ ...entity })));
    this.sequence = state.sequence;
  }
}
