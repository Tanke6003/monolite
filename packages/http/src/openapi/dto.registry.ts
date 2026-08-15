// A DTO is described once, with Zod, and out of it come the two things that
// used to be written separately: the TypeScript type (`z.infer`) and the
// OpenAPI component.
//
// They used to be an interface plus an `@openapi` block repeating it in YAML —
// 168 lines of comment across three DTO files — with nothing forcing them to
// agree. Adding a field to the DTO and forgetting it in the comment broke
// nothing: it just left the documentation lying.
import { z } from "zod";

/**
 * Registry of the DTOs published as components.
 *
 * Zod resolves the references between them on its own: if a registered DTO
 * contains another registered one, the second comes out as a `$ref` instead of
 * being copied, which is exactly what makes an OpenAPI document readable.
 */
const registry = z.registry<{ id: string }>();

/**
 * Declares a DTO and publishes it in `components.schemas` under that name.
 *
 * It returns the same schema, so it is used inline in the declaration:
 *
 *     export const userDto = defineDto("User", z.object({ ... }));
 *     export type UserDTO = z.infer<typeof userDto>;
 */
export function defineDto<T extends z.ZodType>(id: string, schema: T): T {
  registry.add(schema, { id });
  return schema;
}

/**
 * Wraps a DTO in the house's paginated response.
 *
 * The shape of a page is the same in every module, so it is declared here and
 * not in each of them; the item travels by reference.
 */
export function definePagedDto<T extends z.ZodType>(id: string, item: T) {
  return defineDto(
    id,
    z.object({
      data: z.array(item),
      total: z.int().meta({ description: "Total number of records matching the filter" }),
      page: z.int(),
      limit: z.int(),
      pages: z.int(),
    })
  );
}

/**
 * Strips the noise JSON Schema adds and OpenAPI does not need.
 *
 * `$schema` and `$id` are pointless inside `components`, and the bounds Zod
 * puts on an integer — JavaScript's safe integers — fill the documentation with
 * sixteen-digit numbers that say nothing.
 */
const SAFE_INTEGER_BOUNDS = new Set([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]);

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node === null || typeof node !== "object") return node;

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "$schema" || key === "$id") continue;
    if (
      (key === "minimum" || key === "maximum") &&
      typeof value === "number" &&
      SAFE_INTEGER_BOUNDS.has(value)
    ) {
      continue;
    }
    result[key] = clean(value);
  }

  return result;
}

/** OpenAPI components for every declared DTO. */
export function buildDtoComponents(): Record<string, unknown> {
  // `output` mode: a DTO describes what the API **returns**.
  const { schemas } = z.toJSONSchema(registry, {
    io: "output",
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, unknown> };

  return clean(schemas) as Record<string, unknown>;
}
