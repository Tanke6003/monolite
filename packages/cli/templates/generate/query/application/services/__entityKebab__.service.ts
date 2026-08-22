import { inject, injectable } from "tsyringe";
import { __entityUpper___TOKENS } from "../../composition/modules/__entityKebab__.tokens";
import type {
  I__entityName__Repository,
  __entityName__Row,
} from "../../infrastructure/persistence/__entityKebab__.repository";
import type { __dtoName__ } from "../dtos/__entityKebab__.dto";

export interface I__entityName__Service {
  read(): Promise<__dtoName__[]>;
}

/**
 * The layer the controller talks to, and the reason it exists even for a query
 * with one method.
 *
 * **A controller talks to a service, never to a repository.** Every `@Crud`
 * module in this project keeps that shape without anyone thinking about it,
 * because `CrudController` takes an `ICrudService` and will not take anything
 * else. Written by hand, the shape has to be chosen — and this is the one place
 * in a monolite project where nothing enforces it, which is exactly why the
 * generator writes it for you.
 *
 * What it buys is two decisions kept out of the controller: *what a client is
 * allowed to see*, and *what the answer means*. A repository knows how to count
 * rows. It does not know which of them are worth publishing, in what order, or
 * how many.
 */
@injectable()
export class __entityName__Service implements I__entityName__Service {
  constructor(
    @inject(__entityUpper___TOKENS.repository)
    private readonly __entityCamel__: I__entityName__Repository
  ) {}

  public async read(): Promise<__dtoName__[]> {
    return (await this.__entityCamel__.rows()).map(toDto);
  }
}

/** Row to DTO, in one place, so there is one place to change when it diverges. */
function toDto(row: __entityName__Row): __dtoName__ {
  return {
    total: row.total,
    lowestId: row.lowestId,
    highestId: row.highestId,
  };
}
