import { defineDto } from "monolite-http";
import { z } from "zod";

/**
 * What the __resourceLabel__ publishes.
 *
 * Declared apart from the row the repository reads, even when the two happen to
 * match today. The moment the query grows a column the API should not hand out
 * — a cost, a margin, an internal id — the change is here and every caller is
 * already going through it.
 *
 * `defineDto` puts it in `components.schemas`, which is what lets the route
 * below reference it by name instead of repeating its shape in the document.
 */
export const __entityCamel__Dto = defineDto(
  "__entityName__",
  z.object({
    total: z.int().meta({ examples: [42] }),
    lowestId: z.int().nullable(),
    highestId: z.int().nullable(),
  })
);

export type __dtoName__ = z.infer<typeof __entityCamel__Dto>;
