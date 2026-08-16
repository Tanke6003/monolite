// NOTE ON THE OPTIONAL DRIVER: this module only needs `mongodb` for its types
// (`ClientSession`, `Collection`, `Document`), and a `import type` is erased at
// compile time, so nothing is required at runtime. The static import is kept for
// now; if a value from the driver were ever needed here it would have to become
// a lazy `await import("mongodb")`, otherwise a consumer that only uses
// PostgreSQL would be forced to install the optional peer dependency.
import type { ClientSession, Collection, Document } from "mongodb";
import type { ILogger, IRequestContext } from "monolite-core";
import { SYSTEM_USER } from "monolite-core";
import type {
  IGenericRepository,
  IQueryable,
  OrderByClause,
  PagedResult,
  QueryOptions,
  WhereFilter,
} from "../contracts/generic-repository.js";
import type { AuditAction, AuditActor, IAuditTrail } from "../contracts/audit-trail.js";
import { EntityMetadata, EntitySchema } from "../metadata/entity-metadata.js";
import { toMongoFilter } from "../query/mongo-filter.js";
import { QueryBuilder } from "../query/query-builder.js";
import { normalizeOrderBy } from "../query/filter-helpers.js";

/**
 * The only thing this repository needs from the connector: a collection by
 * name. It is declared here, and not in the contracts, because `Collection` is a
 * driver type: the contract layer must not know about it. `MongoConnector`
 * satisfies it structurally, without declaring it.
 */
export interface IMongoDataSource {
  collection<TDoc extends Document = Document>(name: string): Promise<Collection<TDoc>>;
}

/**
 * Counters collection, the canonical pattern for emulating a sequence in
 * MongoDB. One document per entity: `{ _id: "USERS", seq: 12 }`.
 */
const COUNTERS_COLLECTION = "_counters";

/**
 * Generic repository over MongoDB.
 *
 * It offers exactly the same contract as `SqlGenericRepository` and
 * `MemoryGenericRepository` —CRUD, soft delete, projections, pagination,
 * auditing and change log—, so services do not notice which engine they are
 * running against. What differs from SQL is confined to three things, and all
 * three are commented where they happen: there is no auto-increment PK, there is
 * no server date expression, and the transaction is bound to a session instead
 * of to a connection.
 *
 * Every field name comes from the mapping (`EntitySchema`), so no arbitrary key
 * reaches the query.
 */
export class MongoGenericRepository<T extends object, TKey = number>
  implements IGenericRepository<T, TKey>
{
  readonly schema: EntitySchema<T>;

  constructor(
    private readonly db: IMongoDataSource,
    private readonly metadata: EntityMetadata<T>,
    private readonly logger: ILogger,
    /** Provides the audit user. Without it everything is written as "System". */
    private readonly context?: IRequestContext,
    /** Change log; it only acts if the entity has it enabled. */
    private readonly auditTrail?: IAuditTrail,
    /** Session of the transaction in progress; outside one, every operation goes alone. */
    private readonly session?: ClientSession
  ) {
    this.schema = new EntitySchema(metadata);
  }

  /**
   * Returns the same repository bound to a session, which is the MongoDB
   * equivalent of `SqlGenericRepository.withExecutor`. The unit of work uses it.
   */
  withSession(session: ClientSession): MongoGenericRepository<T, TKey> {
    return new MongoGenericRepository<T, TKey>(
      this.db,
      this.metadata,
      this.logger,
      this.context,
      // The change log is bound to the transaction as well: if it is rolled
      // back, its line disappears with it.
      this.auditTrail?.bindTo(session),
      session
    );
  }

  // ------------------------------------------------------------ auditing ---

  /** User recorded in the audit columns. */
  private auditUser(): string {
    return this.context?.getCurrentUserName() ?? SYSTEM_USER;
  }

  /** The change log is opt-in per entity, so auxiliary tables are not recorded. */
  private trailEnabled(): boolean {
    return Boolean(this.auditTrail && this.schema.auditTrail);
  }

  /**
   * Snapshot of who is asking, taken before the operation's first await. After
   * that it is no longer reliable: the driver may resolve its callbacks in the
   * context where it was created and not in the request's one.
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

  // ------------------------------------------------------------- helpers ---

  private collection(): Promise<Collection<Document>> {
    return this.db.collection(this.schema.table);
  }

  private get primaryKeyField(): string {
    return this.schema.columnOf(this.schema.primaryKey);
  }

  /** Filter by PK, with the values already converted to the collection format. */
  private byId(id: TKey): WhereFilter<T> {
    return { [this.schema.primaryKey]: id } as WhereFilter<T>;
  }

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

  /**
   * Projection. `_id` is always excluded: it is MongoDB's technical key, it is
   * not part of the domain model and it has no equivalent column in the other
   * engines.
   */
  private projectionOf(select?: Extract<keyof T, string>[]): Document {
    const projection: Document = { _id: 0 };
    for (const property of select ?? []) {
      projection[this.schema.columnOf(property)] = 1;
    }
    return projection;
  }

  /**
   * @param deterministic MongoDB does not guarantee the natural order of a
   * query, so when paginating it falls back to the PK if no order was asked
   * for; without that, two consecutive pages could repeat or skip documents.
   */
  private sortOf(
    orderBy: OrderByClause<T> | OrderByClause<T>[] | undefined,
    deterministic: boolean
  ): Document | undefined {
    const clauses = normalizeOrderBy(orderBy);

    if (clauses.length === 0) {
      return deterministic ? { [this.primaryKeyField]: 1 } : undefined;
    }

    const sort: Document = {};
    for (const clause of clauses) {
      sort[this.schema.columnOf(clause.field)] = clause.direction === "desc" ? -1 : 1;
    }
    return sort;
  }

  // --------------------------------------------------------------- reads ---

  async find(options: QueryOptions<T> = {}): Promise<T[]> {
    const collection = await this.collection();
    const filter = toMongoFilter(
      this.withSoftDeleteFilter(options.where, options.withDeleted),
      this.schema
    );

    const paginated = options.skip !== undefined || options.take !== undefined;
    const documents = await collection
      .find(filter, {
        projection: this.projectionOf(options.select),
        sort: this.sortOf(options.orderBy, paginated),
        skip: options.skip,
        limit: options.take,
        session: this.session,
      })
      .toArray();

    return documents.map((document) => this.schema.toEntity(document as Record<string, unknown>));
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
      where: this.byId(id),
      select: options.select,
      withDeleted: options.withDeleted,
    });
  }

  async count(where?: WhereFilter<T>, withDeleted?: boolean): Promise<number> {
    const collection = await this.collection();
    return collection.countDocuments(
      toMongoFilter(this.withSoftDeleteFilter(where, withDeleted), this.schema),
      { session: this.session }
    );
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

  // ------------------------------------------------------------ sequence ---

  /** Highest PK already present in the collection; 0 if it is empty. */
  private async highestPrimaryKey(): Promise<number> {
    const collection = await this.collection();
    const [top] = await collection
      .find({}, { projection: { _id: 0, [this.primaryKeyField]: 1 }, sort: { [this.primaryKeyField]: -1 }, limit: 1 })
      .toArray();

    return Number((top as Record<string, unknown> | undefined)?.[this.primaryKeyField] ?? 0);
  }

  /**
   * Reserves `count` consecutive PKs.
   *
   * MongoDB has neither IDENTITY nor sequences, so the canonical counter
   * pattern is used: a `findOneAndUpdate` with `$inc` over one document per
   * entity, which is atomic and therefore safe across concurrent requests.
   *
   * Two decisions worth understanding:
   *
   * 1. The whole reservation happens **outside the session** of the
   *    transaction, including the read of the highest PK. On the one hand, two
   *    transactions touching the same counter document would conflict and one
   *    would abort; on the other, this way it behaves just like an Oracle
   *    sequence or a SQL Server IDENTITY, which do not give the number back on
   *    rollback either: leaving gaps is the expected behaviour.
   *
   * 2. If the counter has just been created it starts above the highest
   *    existing PK. A seed script may insert PKs directly, without going
   *    through here, so a counter starting at 1 would immediately clash with an
   *    already used key.
   */
  private async nextIds(count: number): Promise<number[]> {
    const counters = await this.db.collection(COUNTERS_COLLECTION);

    const counter = await counters.findOneAndUpdate(
      { _id: this.schema.table as unknown as Document["_id"] },
      { $inc: { seq: count } },
      { upsert: true, returnDocument: "after" }
    );

    let last = Number(counter?.seq ?? count);

    // `last === count` can only happen if the document has just been created
    // (the upsert leaves it at zero before incrementing).
    if (last === count) {
      const highest = await this.highestPrimaryKey();
      if (highest > 0) {
        last = highest + count;
        await counters.updateOne(
          { _id: this.schema.table as unknown as Document["_id"] },
          { $set: { seq: last } }
        );
      }
    }

    return Array.from({ length: count }, (_, index) => last - count + 1 + index);
  }

  // -------------------------------------------------------------- writes ---

  /**
   * Builds the document to insert: property -> field, value -> column value,
   * plus the automatic bits that in SQL are set by the database itself.
   */
  private buildInsertDocument(entity: Partial<T>, id: unknown): Record<string, unknown> {
    const { createdAt, updatedAt } = this.schema.timestamps ?? {};
    const { createdBy, updatedBy } = this.schema.audit ?? {};
    const document: Record<string, unknown> = {};

    for (const property of this.schema.insertableProperties()) {
      // The creation date and the audit columns do not come from the request
      // body: otherwise the client could fake who wrote and when.
      if (property === createdAt || property === createdBy || property === updatedBy) continue;

      const value = (entity as Record<string, unknown>)[property];
      if (value === undefined) continue;

      document[this.schema.columnOf(property)] = this.schema.toColumnValue(property, value);
    }

    // The check happens before adding the PK, the marks and the state:
    // otherwise an entity with `createdAt` would always have some field and an
    // empty insert would slip through, writing a document with no data.
    if (Object.keys(document).length === 0) {
      throw new Error(
        `[MongoGenericRepository] insert into ${this.schema.table} with no fields to write.`
      );
    }

    if (id === undefined || id === null) {
      throw new Error(
        `[MongoGenericRepository] ${this.schema.table} does not use identity: the PK is mandatory.`
      );
    }
    document[this.primaryKeyField] = this.schema.toColumnValue(this.schema.primaryKey, id);

    // Timestamps are set by the application with the process clock: MongoDB has
    // no equivalent of `SYSTIMESTAMP` that the server evaluates on write, so
    // there is no way to delegate them as in the SQL engines.
    if (createdAt) document[this.schema.columnOf(createdAt)] = new Date();
    if (updatedAt && document[this.schema.columnOf(updatedAt)] === undefined) {
      document[this.schema.columnOf(updatedAt)] = null;
    }

    if (createdBy) document[this.schema.columnOf(createdBy)] = this.auditUser();
    if (updatedBy) document[this.schema.columnOf(updatedBy)] = null;

    // The collection validator rejects documents, it does not complete them:
    // the initial soft-delete state is written by the repository.
    const softDelete = this.schema.softDelete;
    if (softDelete && document[this.schema.columnOf(softDelete.property)] === undefined) {
      document[this.schema.columnOf(softDelete.property)] = this.schema.softDeleteActiveValue;
    }

    return document;
  }

  async insert(entity: Partial<T>): Promise<T> {
    const actor = this.captureActor();

    const id = this.schema.isIdentity
      ? ((await this.nextIds(1))[0] as unknown as TKey)
      : ((entity as Record<string, unknown>)[this.schema.primaryKey] as TKey);

    const document = this.buildInsertDocument(entity, id);
    const collection = await this.collection();
    await collection.insertOne(document, { session: this.session });

    const created = await this.getById(id, { withDeleted: true });
    if (!created) {
      throw new Error(
        `[MongoGenericRepository] The document inserted into ${this.schema.table} could not be read back (pk=${String(id)}).`
      );
    }

    await this.recordAudit(actor, "INSERT", id, { after: created as Record<string, unknown> });

    this.logger.debug("Document inserted", { collection: this.schema.table, id });
    return created;
  }

  async insertMany(entities: Partial<T>[]): Promise<number> {
    const actor = this.captureActor();
    if (entities.length === 0) return 0;

    // The PKs are reserved in one go: one `$inc` per document would multiply
    // the round trips to the counter without gaining anything.
    const ids = this.schema.isIdentity ? await this.nextIds(entities.length) : [];
    const documents = entities.map((entity, index) =>
      this.buildInsertDocument(
        entity,
        this.schema.isIdentity ? ids[index] : (entity as Record<string, unknown>)[this.schema.primaryKey]
      )
    );

    const collection = await this.collection();
    const result = await collection.insertMany(documents, { session: this.session });

    await this.recordAudit(actor, "INSERT_MANY", undefined, { affected: result.insertedCount });

    this.logger.debug("Bulk insert", {
      collection: this.schema.table,
      affected: result.insertedCount,
    });
    return result.insertedCount;
  }

  /**
   * Builds the `$set` of an update. Returns `null` if the change does not touch
   * any updatable field.
   */
  private buildUpdate(changes: Partial<T>): Record<string, unknown> | null {
    const { updatedAt } = this.schema.timestamps ?? {};
    const { createdBy, updatedBy } = this.schema.audit ?? {};
    const set: Record<string, unknown> = {};

    for (const property of this.schema.updatableProperties()) {
      if (property === updatedAt || property === createdBy || property === updatedBy) continue;

      const value = (changes as Record<string, unknown>)[property];
      if (value === undefined) continue;

      set[this.schema.columnOf(property)] = this.schema.toColumnValue(property, value);
    }

    if (Object.keys(set).length === 0) return null;

    // Same reason as in the insert: the mark is set by the process.
    if (updatedAt) set[this.schema.columnOf(updatedAt)] = new Date();
    if (updatedBy) set[this.schema.columnOf(updatedBy)] = this.auditUser();

    return set;
  }

  async update(id: TKey, changes: Partial<T>): Promise<T | null> {
    const actor = this.captureActor();
    const set = this.buildUpdate(changes);
    // An empty update is not an error: it simply returns the current state. If
    // we returned `null` the caller would read it as "it does not exist".
    if (!set) return this.getById(id);

    // The previous state is only read if there is a change log: otherwise it
    // would be one query too many.
    const before = this.trailEnabled() ? await this.getById(id) : null;

    const collection = await this.collection();
    const result = await collection.updateOne(
      toMongoFilter(this.withSoftDeleteFilter(this.byId(id)), this.schema),
      { $set: set },
      { session: this.session }
    );

    if (result.matchedCount === 0) return null;

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
    const set = this.buildUpdate(changes);
    if (!set) return 0;

    const collection = await this.collection();
    const result = await collection.updateMany(
      toMongoFilter(this.withSoftDeleteFilter(where), this.schema),
      { $set: set },
      { session: this.session }
    );

    // A bulk operation is not recorded document by document: the change log
    // would cost more than the operation itself. What was asked for and how
    // many documents it reached are stored instead.
    await this.recordAudit(actor, "UPDATE_MANY", undefined, {
      changes: changes as Record<string, unknown>,
      affected: result.matchedCount,
    });

    return result.matchedCount;
  }

  // -------------------------------------------------------------- deletes --

  private requireSoftDelete(): void {
    if (!this.schema.softDelete) {
      throw new Error(
        `[MongoGenericRepository] The entity ${this.schema.table} does not declare softDelete; ` +
          "use hardDelete or add the metadata."
      );
    }
  }

  /** Flips the soft-delete flag and returns whether it affected any document. */
  private async setSoftDeleteFlag(id: TKey, deleted: boolean): Promise<boolean> {
    this.requireSoftDelete();

    const softDelete = this.schema.softDelete!;
    const set: Record<string, unknown> = {
      [this.schema.columnOf(softDelete.property)]: deleted
        ? this.schema.softDeleteDeletedValue
        : this.schema.softDeleteActiveValue,
    };

    const { updatedAt } = this.schema.timestamps ?? {};
    if (updatedAt) set[this.schema.columnOf(updatedAt)] = new Date();

    // A soft delete is a modification: it has to leave a trace of who did it.
    const { updatedBy } = this.schema.audit ?? {};
    if (updatedBy) set[this.schema.columnOf(updatedBy)] = this.auditUser();

    // The condition on the previous state makes the operation idempotent:
    // deleting twice returns `false` the second time instead of pretending it
    // did something.
    const filter = toMongoFilter(
      {
        $and: [
          this.byId(id),
          {
            [softDelete.property]: {
              eq: deleted ? this.schema.softDeleteActiveValue : this.schema.softDeleteDeletedValue,
            },
          } as WhereFilter<T>,
        ],
      } as WhereFilter<T>,
      this.schema
    );

    const collection = await this.collection();
    const result = await collection.updateOne(filter, { $set: set }, { session: this.session });

    return result.matchedCount > 0;
  }

  async softDelete(id: TKey): Promise<boolean> {
    const actor = this.captureActor();
    const deleted = await this.setSoftDeleteFlag(id, true);
    if (deleted) {
      await this.recordAudit(actor, "SOFT_DELETE", id);
      this.logger.warn("Soft delete", { collection: this.schema.table, id });
    }
    return deleted;
  }

  async restore(id: TKey): Promise<boolean> {
    const actor = this.captureActor();
    const restored = await this.setSoftDeleteFlag(id, false);
    if (restored) {
      await this.recordAudit(actor, "RESTORE", id);
      this.logger.info("Record restored", { collection: this.schema.table, id });
    }
    return restored;
  }

  async hardDelete(id: TKey): Promise<boolean> {
    const actor = this.captureActor();
    // The document is about to disappear: if there is a change log, it is saved
    // beforehand.
    const before = this.trailEnabled() ? await this.getById(id, { withDeleted: true }) : null;

    const collection = await this.collection();
    const result = await collection.deleteOne(toMongoFilter(this.byId(id), this.schema), {
      session: this.session,
    });

    const deleted = result.deletedCount > 0;
    if (deleted) {
      await this.recordAudit(actor, "HARD_DELETE", id, {
        before: before as Record<string, unknown> | null,
      });
      this.logger.warn("Hard delete", { collection: this.schema.table, id });
    }
    return deleted;
  }

  async hardDeleteWhere(where: WhereFilter<T>): Promise<number> {
    const actor = this.captureActor();
    const collection = await this.collection();

    // No soft-delete filter: the goal here is to clean up for real, and leaving
    // out the ones already flagged would leave orphan documents pointing at
    // something that has just disappeared.
    const result = await collection.deleteMany(toMongoFilter(where, this.schema), {
      session: this.session,
    });

    if (result.deletedCount > 0) {
      await this.recordAudit(actor, "HARD_DELETE_MANY", undefined, {
        affected: result.deletedCount,
      });
      this.logger.warn("Bulk hard delete", {
        collection: this.schema.table,
        affected: result.deletedCount,
      });
    }
    return result.deletedCount;
  }

  query(): IQueryable<T> {
    return new QueryBuilder<T, TKey>(this);
  }
}
