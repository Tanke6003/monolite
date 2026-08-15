import type { ILogger, IRequestContext } from "@monolite/core";
import { SYSTEM_USER } from "@monolite/core";
import type {
  IGenericRepository,
  IQueryable,
  OrderByClause,
  PagedResult,
  QueryOptions,
  WhereFilter,
} from "../contracts/generic-repository";
import type { ISqlExecutor, SqlExecuteResult } from "../contracts/sql-executor";
import type { AuditAction, AuditActor, IAuditTrail } from "../contracts/audit-trail";
import { EntityMetadata, EntitySchema } from "../metadata/entity-metadata";
import { SqlWhereCompiler } from "../query/sql-where-compiler";
import { QueryBuilder } from "../query/query-builder";
import { normalizeOrderBy } from "../query/filter-helpers";
import type { SqlDialect } from "../dialects/sql-dialect";

/**
 * Generic repository over SQL.
 *
 * It generates the SQL for the whole CRUD out of the entity's `EntityMetadata`,
 * so a new module only describes its table and already has getAll, getById,
 * insert, update, soft delete, hard delete and chainable queries.
 *
 * What changes between engines is isolated in `SqlDialect` —how a generated PK
 * is recovered and how the server date is written—; the rest of the SQL is
 * common, so all four SQL engines share this single implementation.
 *
 * Every value travels as a named bind and every identifier comes from the
 * mapping, so no user data is ever concatenated into the SQL.
 */
export class SqlGenericRepository<T extends object, TKey = number>
  implements IGenericRepository<T, TKey>
{
  readonly schema: EntitySchema<T>;

  constructor(
    protected readonly db: ISqlExecutor,
    protected readonly metadata: EntityMetadata<T>,
    protected readonly logger: ILogger,
    protected readonly dialect: SqlDialect,
    /** Provides the audit user. Without it everything is written as "System". */
    protected readonly context?: IRequestContext,
    /** Change log; it only acts if the entity has it enabled. */
    protected readonly auditTrail?: IAuditTrail
  ) {
    this.schema = new EntitySchema(metadata);
  }

  /** The change log is opt-in per entity, so auxiliary tables are not recorded. */
  protected trailEnabled(): boolean {
    return Boolean(this.auditTrail && this.schema.auditTrail);
  }

  /**
   * Records the operation. It goes through the same executor, so inside a
   * transaction it lands in the same commit; if it fails, the whole operation
   * fails.
   */
  /**
   * Snapshot of who is asking, taken before the operation's first await. After
   * that it is no longer reliable: the driver's pool may resolve its callbacks
   * in the context where it was created and not in the request's one.
   */
  protected captureActor(): AuditActor {
    return {
      changedBy: this.auditUser(),
      requestId: this.context?.getRequestId() ?? null,
    };
  }

  protected async recordAudit(
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

  /**
   * Returns the same repository running against another *executor*, typically a
   * transaction context. The unit of work uses it.
   */
  withExecutor(executor: ISqlExecutor): SqlGenericRepository<T, TKey> {
    return new SqlGenericRepository<T, TKey>(
      executor,
      this.metadata,
      this.logger,
      this.dialect,
      this.context,
      // The change log is bound to the transaction as well: if it is rolled
      // back, its line disappears with it.
      this.auditTrail?.bindTo(executor)
    );
  }

  /** User recorded in the audit columns. */
  protected auditUser(): string {
    return this.context?.getCurrentUserName() ?? SYSTEM_USER;
  }

  // ------------------------------------------------------------ helpers ----

  /**
   * Adds the soft-delete filter unless the deleted records are explicitly
   * requested. It is the equivalent of EF Core's global *query filter*.
   */
  private withSoftDeleteFilter(
    where: WhereFilter<T> | undefined,
    withDeleted?: boolean
  ): WhereFilter<T> | undefined {
    const softDelete = this.schema.softDelete;
    if (!softDelete || withDeleted) return where;

    const activeOnly = {
      [softDelete.property]: { eq: this.schema.softDeleteActiveValue },
    } as WhereFilter<T>;

    return where ? ({ $and: [where, activeOnly] } as WhereFilter<T>) : activeOnly;
  }

  private selectList(select?: Extract<keyof T, string>[]): string {
    const properties = select?.length ? select : this.schema.properties;
    return properties.map((property) => this.schema.columnOf(property)).join(", ");
  }

  /**
   * @param deterministic Neither Oracle nor SQL Server guarantees the order of
   * an OFFSET/FETCH without an ORDER BY —and SQL Server flatly requires one—, so
   * when paginating we fall back to the PK if no order was asked for.
   */
  private orderByClause(
    orderBy: OrderByClause<T> | OrderByClause<T>[] | undefined,
    deterministic: boolean
  ): string {
    const clauses = normalizeOrderBy(orderBy);

    if (clauses.length === 0) {
      return deterministic ? ` ORDER BY ${this.schema.columnOf(this.schema.primaryKey)}` : "";
    }

    const rendered = clauses
      .map(
        (clause) =>
          `${this.schema.columnOf(clause.field)} ${clause.direction === "desc" ? "DESC" : "ASC"}`
      )
      .join(", ");

    return ` ORDER BY ${rendered}`;
  }

  private mapRows(rows: Record<string, unknown>[]): T[] {
    return rows.map((row) => this.schema.toEntity(row));
  }

  // --------------------------------------------------------------- reads ---

  async find(options: QueryOptions<T> = {}): Promise<T[]> {
    const compiler = new SqlWhereCompiler<T>(this.schema, "w", this.dialect.toBindValue);
    const where = compiler.compile(this.withSoftDeleteFilter(options.where, options.withDeleted));

    const paginated = options.skip !== undefined || options.take !== undefined;
    let sql = `SELECT ${this.selectList(options.select)} FROM ${this.schema.table}`;
    if (where.sql) sql += ` WHERE ${where.sql}`;
    sql += this.orderByClause(options.orderBy, paginated);

    const binds: Record<string, unknown> = { ...where.binds };
    if (paginated) {
      sql += this.dialect.buildPagination(options.take !== undefined);
      binds.pgskip = options.skip ?? 0;
      if (options.take !== undefined) binds.pgtake = options.take;
    }

    const result = await this.db.execute<Record<string, unknown>>(sql, binds, { expects: "rows" });
    return this.mapRows(result.rows);
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
    const compiler = new SqlWhereCompiler<T>(this.schema, "w", this.dialect.toBindValue);
    const compiled = compiler.compile(this.withSoftDeleteFilter(where, withDeleted));

    let sql = `SELECT COUNT(*) AS TOTAL FROM ${this.schema.table}`;
    if (compiled.sql) sql += ` WHERE ${compiled.sql}`;

    const result = await this.db.execute<{ TOTAL: number; total?: number }>(sql, compiled.binds, {
      expects: "rows",
    });

    const [row] = result.rows;
    return Number(row?.TOTAL ?? row?.total ?? 0);
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

    const total = await this.count(options.where, options.withDeleted);
    const items = await this.find({
      ...options,
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(total / safeLimit),
    };
  }

  // -------------------------------------------------------------- writes ---

  async insert(entity: Partial<T>): Promise<T> {
    const actor = this.captureActor();
    const { createdAt } = this.schema.timestamps ?? {};
    const { createdBy, updatedBy } = this.schema.audit ?? {};
    const columns: string[] = [];
    const values: string[] = [];
    const binds: Record<string, unknown> = {};

    for (const property of this.schema.insertableProperties()) {
      // Timestamps are set by the database, so they do not depend on the Node
      // process clock. Audit columns come from the context and never from the
      // request body: otherwise the client could fake who wrote.
      if (property === createdAt || property === createdBy || property === updatedBy) continue;

      const value = (entity as Record<string, unknown>)[property];
      if (value === undefined) continue;

      const bindName = `b${columns.length}`;
      columns.push(this.schema.columnOf(property));
      values.push(`:${bindName}`);
      binds[bindName] = this.dialect.toBindValue(this.schema.toColumnValue(property, value));
    }

    // The check happens before adding the timestamp: otherwise an entity with
    // `createdAt` would always have one column and an empty insert would slip
    // through, writing a row with no data.
    if (columns.length === 0) {
      throw new Error(
        `[SqlGenericRepository] insert into ${this.schema.table} with no columns to write.`
      );
    }

    if (createdAt) {
      columns.push(this.schema.columnOf(createdAt));
      values.push(this.dialect.currentTimestamp);
    }

    if (createdBy) {
      columns.push(this.schema.columnOf(createdBy));
      values.push(":auditUser");
      binds.auditUser = this.auditUser();
    }

    const statement = this.dialect.buildInsert({
      table: this.schema.table,
      columns,
      values,
      primaryKeyColumn: this.schema.columnOf(this.schema.primaryKey),
      identity: this.schema.isIdentity,
    });

    // What is asked of the executor depends on where the engine returns the PK.
    const expects =
      statement.idFrom === "rows" ? "rows" : statement.idFrom === "driver" ? "identity" : "affected";

    const result = await this.db.execute(statement.sql, { ...binds, ...statement.binds }, { expects });

    const id = this.schema.isIdentity
      ? (this.dialect.readInsertedId(result as SqlExecuteResult) as TKey)
      : ((entity as Record<string, unknown>)[this.schema.primaryKey] as TKey);

    const created = await this.getById(id, { withDeleted: true });
    if (!created) {
      throw new Error(
        `[SqlGenericRepository] The row inserted into ${this.schema.table} could not be read back (pk=${String(id)}).`
      );
    }

    await this.recordAudit(actor, "INSERT", id, { after: created as Record<string, unknown> });

    this.logger.debug("Record inserted", { table: this.schema.table, id });
    return created;
  }

  async insertMany(entities: Partial<T>[]): Promise<number> {
    const actor = this.captureActor();
    if (entities.length === 0) return 0;

    const { createdAt } = this.schema.timestamps ?? {};
    const { createdBy, updatedBy } = this.schema.audit ?? {};

    // `executeMany` requires a single statement, so the union of the present
    // properties is taken and the ones missing from a row travel as NULL.
    const properties = this.schema
      .insertableProperties()
      .filter(
        (property) => property !== createdAt && property !== createdBy && property !== updatedBy
      )
      .filter((property) =>
        entities.some((entity) => (entity as Record<string, unknown>)[property] !== undefined)
      );

    if (properties.length === 0) {
      throw new Error(
        `[SqlGenericRepository] insertMany into ${this.schema.table} with no columns to write.`
      );
    }

    const columns = properties.map((property) => this.schema.columnOf(property));
    const placeholders = properties.map((_, index) => `:b${index}`);

    if (createdAt) {
      columns.push(this.schema.columnOf(createdAt));
      placeholders.push(this.dialect.currentTimestamp);
    }

    if (createdBy) {
      columns.push(this.schema.columnOf(createdBy));
      placeholders.push(":auditUser");
    }

    const sql = `INSERT INTO ${this.schema.table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;

    const auditUser = this.auditUser();
    const rows = entities.map((entity) => {
      const row: Record<string, unknown> = {};
      properties.forEach((property, index) => {
        row[`b${index}`] = this.dialect.toBindValue(
          this.schema.toColumnValue(property, (entity as Record<string, unknown>)[property])
        );
      });
      if (createdBy) row.auditUser = auditUser;
      return row;
    });

    const affected = await this.db.executeMany(sql, rows);
    await this.recordAudit(actor, "INSERT_MANY", undefined, { affected });

    this.logger.debug("Bulk insert", { table: this.schema.table, affected });
    return affected;
  }

  /**
   * Builds the `SET` of an UPDATE. Returns `null` if the change does not touch
   * any updatable column.
   */
  private buildSetClause(changes: Partial<T>): { sql: string; binds: Record<string, unknown> } | null {
    const { updatedAt } = this.schema.timestamps ?? {};
    const { createdBy, updatedBy } = this.schema.audit ?? {};
    const assignments: string[] = [];
    const binds: Record<string, unknown> = {};

    for (const property of this.schema.updatableProperties()) {
      if (property === updatedAt || property === createdBy || property === updatedBy) continue;

      const value = (changes as Record<string, unknown>)[property];
      if (value === undefined) continue;

      const bindName = `s${assignments.length}`;
      assignments.push(`${this.schema.columnOf(property)} = :${bindName}`);
      binds[bindName] = this.dialect.toBindValue(this.schema.toColumnValue(property, value));
    }

    if (assignments.length === 0) return null;

    if (updatedAt) {
      assignments.push(`${this.schema.columnOf(updatedAt)} = ${this.dialect.currentTimestamp}`);
    }

    if (updatedBy) {
      assignments.push(`${this.schema.columnOf(updatedBy)} = :auditUser`);
      binds.auditUser = this.auditUser();
    }

    return { sql: assignments.join(", "), binds };
  }

  private async executeUpdate(
    setClause: { sql: string; binds: Record<string, unknown> },
    where: WhereFilter<T>
  ): Promise<number> {
    // A different prefix for the WHERE binds: otherwise they would clash with
    // the SET ones.
    const compiler = new SqlWhereCompiler<T>(this.schema, "w", this.dialect.toBindValue);
    const compiled = compiler.compile(this.withSoftDeleteFilter(where));

    let sql = `UPDATE ${this.schema.table} SET ${setClause.sql}`;
    if (compiled.sql) sql += ` WHERE ${compiled.sql}`;

    const result = await this.db.execute(
      sql,
      { ...setClause.binds, ...compiled.binds },
      { expects: "affected" }
    );
    return result.rowsAffected;
  }

  async update(id: TKey, changes: Partial<T>): Promise<T | null> {
    const actor = this.captureActor();
    const setClause = this.buildSetClause(changes);
    // An empty update is not an error: it simply returns the current state. If
    // we returned `null` the caller would read it as "it does not exist".
    if (!setClause) return this.getById(id);

    // The previous state is only read if there is a change log: otherwise it
    // would be one query too many.
    const before = this.trailEnabled() ? await this.getById(id) : null;

    const affected = await this.executeUpdate(setClause, {
      [this.schema.primaryKey]: id,
    } as WhereFilter<T>);

    if (affected === 0) return null;

    const updated = await this.getById(id);
    await this.recordAudit(actor, "UPDATE", id, {
      before: before as Record<string, unknown> | null,
      after: updated as Record<string, unknown> | null,
    });

    return updated;
  }

  /** Note: it does not reach the soft-deleted records. */
  async updateWhere(where: WhereFilter<T>, changes: Partial<T>): Promise<number> {
    const actor = this.captureActor();
    const setClause = this.buildSetClause(changes);
    if (!setClause) return 0;

    const affected = await this.executeUpdate(setClause, where);
    // A bulk operation is not recorded row by row: the change log would cost
    // more than the operation itself. What was asked for and how many rows it
    // reached are stored instead.
    await this.recordAudit(actor, "UPDATE_MANY", undefined, {
      changes: changes as Record<string, unknown>,
      affected,
    });

    return affected;
  }

  // -------------------------------------------------------------- deletes --

  private requireSoftDelete(): void {
    if (!this.schema.softDelete) {
      throw new Error(
        `[SqlGenericRepository] The entity ${this.schema.table} does not declare softDelete; ` +
          "use hardDelete or add the metadata."
      );
    }
  }

  /** Flips the soft-delete flag and returns whether it affected any row. */
  private async setSoftDeleteFlag(id: TKey, deleted: boolean): Promise<boolean> {
    this.requireSoftDelete();

    const softDelete = this.schema.softDelete!;
    const column = this.schema.columnOf(softDelete.property);
    const { updatedAt } = this.schema.timestamps ?? {};

    const assignments = [`${column} = :flag`];
    if (updatedAt) {
      assignments.push(`${this.schema.columnOf(updatedAt)} = ${this.dialect.currentTimestamp}`);
    }

    // A soft delete is a modification: it has to leave a trace of who did it.
    const { updatedBy } = this.schema.audit ?? {};
    if (updatedBy) assignments.push(`${this.schema.columnOf(updatedBy)} = :auditUser`);

    // The condition on the previous state makes the operation idempotent:
    // deleting twice returns `false` the second time instead of pretending it
    // did something.
    const sql =
      `UPDATE ${this.schema.table} SET ${assignments.join(", ")} ` +
      `WHERE ${this.schema.columnOf(this.schema.primaryKey)} = :pk AND ${column} = :previous`;

    const result = await this.db.execute(
      sql,
      {
        flag: deleted ? this.schema.softDeleteDeletedValue : this.schema.softDeleteActiveValue,
        pk: id,
        previous: deleted ? this.schema.softDeleteActiveValue : this.schema.softDeleteDeletedValue,
        ...(updatedBy ? { auditUser: this.auditUser() } : {}),
      },
      { expects: "affected" }
    );

    return result.rowsAffected > 0;
  }

  async softDelete(id: TKey): Promise<boolean> {
    const actor = this.captureActor();
    const deleted = await this.setSoftDeleteFlag(id, true);
    if (deleted) {
      await this.recordAudit(actor, "SOFT_DELETE", id);
      this.logger.warn("Soft delete", { table: this.schema.table, id });
    }
    return deleted;
  }

  async restore(id: TKey): Promise<boolean> {
    const actor = this.captureActor();
    const restored = await this.setSoftDeleteFlag(id, false);
    if (restored) {
      await this.recordAudit(actor, "RESTORE", id);
      this.logger.info("Record restored", { table: this.schema.table, id });
    }
    return restored;
  }

  async hardDelete(id: TKey): Promise<boolean> {
    const actor = this.captureActor();
    // The row is about to disappear: if there is a change log, it is saved
    // beforehand.
    const before = this.trailEnabled() ? await this.getById(id, { withDeleted: true }) : null;

    const sql = `DELETE FROM ${this.schema.table} WHERE ${this.schema.columnOf(this.schema.primaryKey)} = :pk`;
    const result = await this.db.execute(sql, { pk: id }, { expects: "affected" });

    const deleted = result.rowsAffected > 0;
    if (deleted) {
      await this.recordAudit(actor, "HARD_DELETE", id, {
        before: before as Record<string, unknown> | null,
      });
      this.logger.warn("Hard delete", { table: this.schema.table, id });
    }
    return deleted;
  }

  async hardDeleteWhere(where: WhereFilter<T>): Promise<number> {
    const actor = this.captureActor();
    const compiler = new SqlWhereCompiler<T>(this.schema, "w", this.dialect.toBindValue);
    // No soft-delete filter: the goal here is to clean up for real.
    const compiled = compiler.compile(where);

    let sql = `DELETE FROM ${this.schema.table}`;
    if (compiled.sql) sql += ` WHERE ${compiled.sql}`;

    const result = await this.db.execute(sql, compiled.binds, { expects: "affected" });
    if (result.rowsAffected > 0) {
      await this.recordAudit(actor, "HARD_DELETE_MANY", undefined, {
        affected: result.rowsAffected,
      });
      this.logger.warn("Bulk hard delete", {
        table: this.schema.table,
        affected: result.rowsAffected,
      });
    }
    return result.rowsAffected;
  }

  query(): IQueryable<T> {
    return new QueryBuilder<T, TKey>(this);
  }

  /**
   * Locks a row by PK until commit. It only makes sense over a transaction
   * executor: with auto-commit the lock is released when the statement itself
   * ends and protects nothing, which is why it is the unit of work that exposes
   * it and not the repository contract.
   *
   * It does not filter by soft delete: the row that exists is locked, and
   * whether it is also deactivated is for the caller to decide with its own
   * read.
   *
   * @returns `false` if the row does not exist.
   */
  async lockById(id: TKey): Promise<boolean> {
    const sql = this.dialect.buildRowLock(
      this.schema.table,
      this.schema.columnOf(this.schema.primaryKey)
    );

    const result = await this.db.execute(sql, { pk: id }, { expects: "rows" });
    return result.rows.length > 0;
  }

  /**
   * Escape hatch for what the generic API deliberately does not express
   * —aggregations, `GROUP BY`, views, stored procedures—.
   *
   * Module repositories use it when they declare extra methods on their own
   * interface. Values still travel as binds; the SQL is written by the caller,
   * so it must never be built by concatenating user input.
   */
  async executeRaw<TRow = Record<string, unknown>>(
    sql: string,
    binds: Record<string, unknown> = {}
  ): Promise<TRow[]> {
    const result = await this.db.execute<TRow>(sql, binds, { expects: "rows" });
    return result.rows;
  }
}
