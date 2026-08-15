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
} from "./contracts/generic-repository.js";

export type { ITransactionScope, IUnitOfWork } from "./contracts/unit-of-work.js";

export { AUDIT_ACTIONS } from "./contracts/audit-trail.js";
export type {
  AuditAction,
  AuditActor,
  AuditEntry,
  IAuditLog,
  IAuditTrail,
} from "./contracts/audit-trail.js";

export type {
  ISqlExecutor,
  SqlExecuteOptions,
  SqlExecuteResult,
} from "./contracts/sql-executor.js";

export type { DbEngine, IDbPlugin, ISqlDbPlugin } from "./contracts/db-plugin.js";

export type { ITransactionContext } from "./contracts/transaction-context.js";

// -------------------------------------------------------------- metadata ---

export { defineEntity, EntitySchema } from "./metadata/entity-metadata.js";
export type {
  AuditMetadata,
  ColumnDefinition,
  ColumnKind,
  ColumnMetadata,
  EntityMetadata,
  SoftDeleteMetadata,
  TimestampMetadata,
} from "./metadata/entity-metadata.js";

// ----------------------------------------------------------------- query ---

export {
  containsPattern,
  escapeRegExp,
  isOperatorObject,
  LIKE_ESCAPE,
  likeToRegExp,
  normalizeOrderBy,
  OPERATOR_KEYS,
} from "./query/filter-helpers.js";

export { QueryBuilder } from "./query/query-builder.js";

export { compareBy, matchesFilter } from "./query/memory-filter.js";

export { toMongoFilter } from "./query/mongo-filter.js";
export type { MongoQuery } from "./query/mongo-filter.js";

export { SqlWhereCompiler } from "./query/sql-where-compiler.js";
export type { CompiledWhere } from "./query/sql-where-compiler.js";

// -------------------------------------------------------------- dialects ---

export {
  mysqlDialect,
  oracleDialect,
  postgresDialect,
  sqlServerDialect,
} from "./dialects/sql-dialect.js";
export type {
  BuildInsertParams,
  InsertedIdSource,
  InsertStatement,
  SqlDialect,
} from "./dialects/sql-dialect.js";

// --------------------------------------------------------------- drivers ---

export { MemoryGenericRepository } from "./drivers/memory-generic-repository.js";
export type { MemorySnapshot } from "./drivers/memory-generic-repository.js";

export { SqlGenericRepository } from "./drivers/sql-generic-repository.js";

export { MongoGenericRepository } from "./drivers/mongo-generic-repository.js";
export type { IMongoDataSource } from "./drivers/mongo-generic-repository.js";

// --------------------------------------------------------- unit of work ----

export { MemoryUnitOfWork } from "./unit-of-work/memory-unit-of-work.js";
export type { MemoryRepositoryRegistry } from "./unit-of-work/memory-unit-of-work.js";

export { SqlUnitOfWork } from "./unit-of-work/sql-unit-of-work.js";
export type {
  ISqlTransactionRunner,
  SqlRepositoryRegistry,
} from "./unit-of-work/sql-unit-of-work.js";

export { MongoUnitOfWork } from "./unit-of-work/mongo-unit-of-work.js";
export type {
  IMongoTransactionRunner,
  MongoRepositoryRegistry,
} from "./unit-of-work/mongo-unit-of-work.js";

export { AsyncTransactionContext } from "./transactions/async-transaction-context.js";

// ----------------------------------------------------------------- audit ---

export { MemoryAuditTrail, MongoAuditTrail, SqlAuditTrail } from "./audit/audit-trail.js";

// ----------------------------------------------------- module repository ---

export { BaseModuleRepository } from "./module-repository.js";

// ------------------------------------------------------------ connectors ---

export { OracleConnector } from "./connectors/oracle-connector.js";
export type {
  IOracleConnector,
  IOracleTransaction,
  OracleBinds,
  OracleBindValue,
  OracleConnectionConfig,
  OracleExecuteResult,
  OracleOutBind,
} from "./connectors/oracle-connector.js";

export { SequelizeConnector } from "./connectors/sequelize-connector.js";
export type {
  SequelizeConnectionConfig,
  SequelizeEngine,
} from "./connectors/sequelize-connector.js";

export { MongoConnector } from "./connectors/mongo-connector.js";
export type { MongoConnectionConfig } from "./connectors/mongo-connector.js";

// --------------------------------------------------------------- testing ---

export { CONTRACT_ENTITY, runGenericRepositoryContract } from "./testing/repository-contract.js";
export type { ContractItem, ContractSetup } from "./testing/repository-contract.js";
