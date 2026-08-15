/**
 * `@monolite/data` — one repository contract over six engines.
 *
 * The public surface is organised in four layers:
 *
 *  1. **Contracts** — the interfaces everything else is written against. A
 *     service only ever needs `IGenericRepository<T>` and `IUnitOfWork`.
 *  2. **Metadata and query** — how an entity is mapped to a table and how the
 *     declarative filter is translated into SQL, into a Mongo query document or
 *     into an in-memory predicate.
 *  3. **Drivers, dialects and connectors** — the six implementations.
 *  4. **Testing** — the contract suite, so a consumer can check that their own
 *     driver behaves like the ones shipped here.
 */

// ------------------------------------------------------------- contracts ---

export type {
  FieldFilter,
  FieldOperators,
  IGenericRepository,
  IQueryable,
  OrderByClause,
  PagedResult,
  QueryOptions,
  SortDirection,
  WhereFilter,
} from "./contracts/generic-repository";

export type { ITransactionScope, IUnitOfWork } from "./contracts/unit-of-work";

export { AUDIT_ACTIONS } from "./contracts/audit-trail";
export type {
  AuditAction,
  AuditActor,
  AuditEntry,
  IAuditLog,
  IAuditTrail,
} from "./contracts/audit-trail";

export type {
  ISqlExecutor,
  SqlExecuteOptions,
  SqlExecuteResult,
} from "./contracts/sql-executor";

export type { DbEngine, IDbPlugin, ISqlDbPlugin } from "./contracts/db-plugin";

export type { ITransactionContext } from "./contracts/transaction-context";

// -------------------------------------------------------------- metadata ---

export { defineEntity, EntitySchema } from "./metadata/entity-metadata";
export type {
  AuditMetadata,
  ColumnDefinition,
  ColumnKind,
  ColumnMetadata,
  EntityMetadata,
  SoftDeleteMetadata,
  TimestampMetadata,
} from "./metadata/entity-metadata";

// ----------------------------------------------------------------- query ---

export {
  containsPattern,
  escapeRegExp,
  isOperatorObject,
  LIKE_ESCAPE,
  likeToRegExp,
  normalizeOrderBy,
  OPERATOR_KEYS,
} from "./query/filter-helpers";

export { QueryBuilder } from "./query/query-builder";

export { compareBy, matchesFilter } from "./query/memory-filter";

export { toMongoFilter } from "./query/mongo-filter";
export type { MongoQuery } from "./query/mongo-filter";

export { SqlWhereCompiler } from "./query/sql-where-compiler";
export type { CompiledWhere } from "./query/sql-where-compiler";

// -------------------------------------------------------------- dialects ---

export {
  mysqlDialect,
  oracleDialect,
  postgresDialect,
  sqlServerDialect,
} from "./dialects/sql-dialect";
export type {
  BuildInsertParams,
  InsertedIdSource,
  InsertStatement,
  SqlDialect,
} from "./dialects/sql-dialect";

// --------------------------------------------------------------- drivers ---

export { MemoryGenericRepository } from "./drivers/memory-generic-repository";
export type { MemorySnapshot } from "./drivers/memory-generic-repository";

export { SqlGenericRepository } from "./drivers/sql-generic-repository";

export { MongoGenericRepository } from "./drivers/mongo-generic-repository";
export type { IMongoDataSource } from "./drivers/mongo-generic-repository";

// --------------------------------------------------------- unit of work ----

export { MemoryUnitOfWork } from "./unit-of-work/memory-unit-of-work";
export type { MemoryRepositoryRegistry } from "./unit-of-work/memory-unit-of-work";

export { SqlUnitOfWork } from "./unit-of-work/sql-unit-of-work";
export type {
  ISqlTransactionRunner,
  SqlRepositoryRegistry,
} from "./unit-of-work/sql-unit-of-work";

export { MongoUnitOfWork } from "./unit-of-work/mongo-unit-of-work";
export type {
  IMongoTransactionRunner,
  MongoRepositoryRegistry,
} from "./unit-of-work/mongo-unit-of-work";

export { AsyncTransactionContext } from "./transactions/async-transaction-context";

// ----------------------------------------------------------------- audit ---

export { MemoryAuditTrail, MongoAuditTrail, SqlAuditTrail } from "./audit/audit-trail";

// ----------------------------------------------------- module repository ---

export { BaseModuleRepository } from "./module-repository";

// ------------------------------------------------------------ connectors ---

export { OracleConnector } from "./connectors/oracle-connector";
export type {
  IOracleConnector,
  IOracleTransaction,
  OracleBinds,
  OracleBindValue,
  OracleConnectionConfig,
  OracleExecuteResult,
  OracleOutBind,
} from "./connectors/oracle-connector";

export { SequelizeConnector } from "./connectors/sequelize-connector";
export type {
  SequelizeConnectionConfig,
  SequelizeEngine,
} from "./connectors/sequelize-connector";

export { MongoConnector } from "./connectors/mongo-connector";
export type { MongoConnectionConfig } from "./connectors/mongo-connector";

// --------------------------------------------------------------- testing ---

export { CONTRACT_ENTITY, runGenericRepositoryContract } from "./testing/repository-contract";
export type { ContractItem, ContractSetup } from "./testing/repository-contract";
