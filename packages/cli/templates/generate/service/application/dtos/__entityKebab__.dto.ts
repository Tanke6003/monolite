import { defineDto, definePagedDto } from "monolite-http";
import { z } from "zod";

/**
 * What crosses the HTTP boundary, and the schemas that police it.
 *
 * The DTO is not the entity: it omits the primary-key column name, the
 * soft-delete flag and the audit columns, so none of them can be set from a
 * request body. The mapping between the two lives in the service.
 *
 * The Zod schemas are declared once and used twice — the route validates with
 * them and the OpenAPI document is derived from them — which is the whole point
 * of handing them to `@Crud`. A hand-written description next to a schema is a
 * description that starts lying the first time either one changes.
 */

/**
 * The shape the API answers with, published as an OpenAPI component.
 *
 * `defineDto` is what puts it in `components.schemas`, and it is not optional:
 * `@Crud({ dto: "__entityName__" })` documents its responses as a `$ref` to
 * that name, so without this the document points at a component nobody
 * declared. The result still serves with a 200 and the reader is the only thing
 * that notices — Swagger UI shows the operation with an empty body, Scalar
 * shows nothing.
 *
 * The type comes out of the schema rather than being declared beside it, for
 * the same reason: two declarations of one shape drift.
 */
export const __entityCamel__Dto = defineDto(
  "__entityName__",
  z.object({
    id: z.int().meta({ examples: [1] }),
    name: z.string().meta({ examples: ["__entityName__ one"] }),
    description: z.string().nullish(),
  })
);

/**
 * The page the listing answers with. `Paginated__entityName__` is the name
 * `@Crud` references for its 200, and the item travels inside it by reference.
 */
export const paginated__entityName__Dto = definePagedDto(
  "Paginated__entityName__",
  __entityCamel__Dto
);

export type __dtoName__ = z.infer<typeof __entityCamel__Dto>;

const shape = {
  name: z.string().min(1, "name is required").max(150, "name is too long"),
  description: z.string().max(500, "description is too long").nullish(),
};

export const create__entityName__Schema = z.object(shape);

export const update__entityName__Schema = z.object(shape);

/**
 * Query of the listing. The strings come out of the URL, so each one is parsed
 * and then range-checked: `?limit=99999` is a request to page the whole table
 * into memory.
 */
export const __entityCamel__QuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((value) => (value ? parseInt(value, 10) : 1))
    .pipe(z.number().int().min(1, "page must be >= 1")),
  limit: z
    .string()
    .optional()
    .transform((value) => (value ? parseInt(value, 10) : 10))
    .pipe(z.number().int().min(1).max(100, "limit must be <= 100")),
});

export type Create__entityName__Input = z.infer<typeof create__entityName__Schema>;
export type Update__entityName__Input = z.infer<typeof update__entityName__Schema>;
