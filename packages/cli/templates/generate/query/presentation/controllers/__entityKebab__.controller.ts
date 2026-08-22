import type { NextFunction, Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { z } from "zod";
import { ApiController, Get } from "monolite-http";
import { __entityCamel__Dto } from "../../application/dtos/__entityKebab__.dto";
import type { I__entityName__Service } from "../../application/services/__entityKebab__.service";
import { __entityUpper___TOKENS } from "../../composition/modules/__entityKebab__.tokens";

/**
 * The __resourceLabel__ over HTTP.
 *
 * No `@Crud` here, because there is no resource: nothing to create, no id to
 * fetch, no page to delete. So the route is declared by hand — and so is the
 * shape `CrudController` would otherwise have enforced.
 *
 * **It injects the service, never the repository.** That is the whole point of
 * this schematic. A controller holding the repository would be reading rows and
 * answering with them, which puts what a client may see and what the answer
 * means in the layer furthest from either.
 *
 * What is left is what a controller is for: read the request, call one method,
 * answer, and hand anything that throws to the error middleware.
 */
@injectable()
@ApiController("__routePath__", {
  tag: "__entityPlural__",
  token: __entityUpper___TOKENS.controller,
})
export class __entityName__Controller {
  constructor(
    @inject(__entityUpper___TOKENS.service) private readonly __entityCamel__: I__entityName__Service
  ) {}

  /**
   * Declared as a field rather than a method so that `this` is bound: Express
   * calls the handler detached from the instance, and a method would arrive
   * with `this` undefined.
   */
  @Get("/", {
    summary: "The __resourceLabel__",
    // The DTO is imported as a value, not just as a type, and that is load-bearing:
    // `defineDto` registers the component when its module runs, so a DTO nobody
    // imports is a `$ref` in the document pointing at a component that is not there.
    responses: { 200: { description: "The __resourceLabel__", schema: z.array(__entityCamel__Dto) } },
  })
  public read = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await this.__entityCamel__.read());
    } catch (error) {
      next(error);
    }
  };
}
