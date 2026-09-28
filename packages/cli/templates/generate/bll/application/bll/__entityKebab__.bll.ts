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
 * base. To filter the listing, declare the filters with `filtersFor` and pass
 * them as `filters`; override `buildWhere` only for a filter that is a rule
 * rather than a mapping. And if the module would have to contort itself to fit
 * here, the right answer is to stop extending this class.
 */
@injectable()
export class __entityName__BLL extends CrudBLL<I__entityName__, __dtoName__> {
  constructor(
    @inject(__entityUpper___TOKENS.store) store: IGenericRepository<I__entityName__>
  ) {
    super(store, __mapperName__, { field: "__pkProperty__", direction: "asc" });
  }

  // The day a verb writes more than once — or checks other tables before it
  // writes — keep it in one transaction. `CrudBLL` already carries the unit of
  // work, so the decorator is all it takes: no second base class, no extra
  // constructor argument. `create`, `update` and `softDelete` are already atomic
  // on their own; `super.create` below joins the transaction the decorator
  // opens, and a throw anywhere in the method rolls all of it back.
  //
  // Add `Transactional` to the `monolite-crud` import, then:
  //
  // @Transactional()
  // override async create(dto: Partial<__dtoName__>): Promise<__dtoName__> {
  //   await this.assertNameIsFree(dto.name);
  //   return super.create(dto);
  // }
  //
  // For the part of a method rather than the whole of it, `this.tx(() => ...)`
  // does the same.
}
