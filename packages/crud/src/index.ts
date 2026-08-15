/**
 * `@monolite/crud` — the CRUD you stop writing.
 *
 * One decorator over a class that extends `CrudController` gives a resource its
 * list / getOne / create / update / softDelete over HTTP, with validation and
 * OpenAPI derived from the very same Zod schemas. Underneath, `CrudService`
 * does for the service layer what the generic repository did for the data
 * layer: you supply a repository and a mapper, and the pass-through everybody
 * used to write by hand comes for free.
 *
 * Nothing here is all-or-nothing. Any verb can be dropped from `@Crud()` and
 * declared by hand, `buildWhere` is the seam for a module's own filtering, and
 * a service with real business rules simply overrides the verb that has them.
 */

// -------------------------------------------------------------  service  ---
export { CrudService } from "./crud.service.js";
export type {
  EntityMapper,
  ICrudService,
  ListOptions,
  PaginatedDTO,
} from "./crud.service.js";

// ----------------------------------------------------------  controller  ---
export { CrudController } from "./crud.controller.js";
export type { ICrudController } from "./crud.controller.js";

// -----------------------------------------------------------  decorator  ---
export { Crud } from "./crud.decorator.js";
export type { CrudOptions, CrudVerb } from "./crud.decorator.js";

// ------------------------------------------------------  transactions  ---
export { lockRow, Transactional, TransactionalService } from "./transactional.js";

// --------------------------------------------------------------  mapping  ---
export { createMapper } from "./mapper.js";
export type {
  ComputedField,
  FieldMapping,
  Mapper,
  MappedField,
  MappingProfile,
} from "./mapper.js";

// --------------------------------------------------------------  queries  ---
export { loadRelated } from "./include.query.js";
export type { IncludeSpec } from "./include.query.js";
