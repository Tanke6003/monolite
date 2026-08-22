import { inject, injectable } from "tsyringe";
import { createMapper, CrudBLL } from "monolite-crud";
import type { IGenericRepository } from "monolite-data";
import type { I__entityName__ } from "../../domain/models/__entityKebab__.model";
import type { __dtoName__ } from "../dtos/__entityKebab__.dto";
import { __entityUpper___TOKENS } from "../../composition/modules/__entityKebab__.tokens";

/**
 * Entity to DTO, declared once and used in all four directions: read, list,
 * create and partial update.
 *
 * `toPartialEntity` is the one that earns its keep — it tells "absent" apart
 * from "sent as null", which is precisely the distinction people forget when
 * writing this by hand, and forgetting it means a PUT wipes fields nobody asked
 * to change.
 */
const __mapperName__ = createMapper<I__entityName__, __dtoName__>({
  // The primary key never comes from a request body.
  id: { field: "__pkProperty__", readOnly: true },
  name: "name",
  // `null` rather than `undefined` on the way out: an absent key in a JSON
  // response reads as "unknown", and this one is known to be empty.
  description: {
    field: "description",
    to: (value) => (value ?? null) as string | null,
    from: (value) => value ?? null,
  },
});

/**
 * __entityName__: a CRUD with no rules of its own, so it writes none.
 *
 * Paging, mapping, inserting, updating by parts and soft deleting are identical
 * in every flat module and live in `CrudBLL`. All this class contributes is
 * which repository and which mapper it works with, and how the listing is
 * ordered.
 *
 * The day it grows a rule —a unique name, a state machine, a balance that
 * cannot go negative— override that one verb; the others keep coming from the
 * base. To filter the listing, override `buildWhere` and nothing else. And if
 * the module would have to contort itself to fit here, the right answer is to
 * stop extending this class.
 */
@injectable()
export class __entityName__BLL extends CrudBLL<I__entityName__, __dtoName__> {
  constructor(
    @inject(__entityUpper___TOKENS.store) store: IGenericRepository<I__entityName__>
  ) {
    super(store, __mapperName__, { field: "__pkProperty__", direction: "asc" });
  }
}
