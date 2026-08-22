import { inject, injectable } from "tsyringe";
import type { IRequestContext } from "monolite-core";
import { Crud, CrudController } from "monolite-crud";
import { TOKENS } from "monolite-di";
import { ApiController } from "monolite-http";
import {
  create__entityName__Schema,
  update__entityName__Schema,
  __entityCamel__QuerySchema,
} from "../../application/dtos/__entityKebab__.dto";
import type { __entityName__BLL } from "../../application/bll/__entityKebab__.bll";
import { __entityUpper___TOKENS } from "../../composition/modules/__entityKebab__.tokens";

/**
 * __entityPlural__. The whole HTTP module is this declaration.
 *
 * The five handlers come from `CrudController` and the five routes —each with
 * its validation and its slice of the OpenAPI document— from `@Crud`. Nothing
 * here repeats a path, a status code or a schema, which is the point: those
 * three used to be written once for the router, once for the validator and once
 * for the documentation, and any two of them could disagree.
 *
 * To take over one verb, drop it from `verbs` and declare it here with its own
 * `@Get` / `@Post` / ... decorator. Declaring it *without* dropping it is an
 * error, and it surfaces at startup as a duplicate-route report rather than as
 * a request that quietly hits the wrong handler.
 */
@injectable()
@ApiController("__routePath__", {
  tag: "__entityPlural__",
  token: __entityUpper___TOKENS.controller,
})
@Crud({
  resource: "__resourceLabel__",
  dto: "__entityName__",
  schemas: {
    create: create__entityName__Schema,
    update: update__entityName__Schema,
    query: __entityCamel__QuerySchema,
  },
})
export class __entityName__Controller extends CrudController {
  constructor(
    @inject(__entityUpper___TOKENS.bll) bll: __entityName__BLL,
    @inject(TOKENS.IRequestContext) context: IRequestContext
  ) {
    super(bll, context, "__resourceLabel__");
  }
}
