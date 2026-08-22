import type { DependencyContainer, MonoliteModule } from "monolite-di";
import { __entityName__BLL } from "../../application/bll/__entityKebab__.bll";
import { __entityName__Repository } from "../../infrastructure/persistence/__entityKebab__.repository";
import { __entityName__Controller } from "../../presentation/controllers/__entityKebab__.controller";
import { __entityUpper___TOKENS } from "./__entityKebab__.tokens";

/**
 * The three layers of the __entityKebab__ query the container builds.
 *
 * The repository is here, unlike in an entity module, because nothing else
 * builds it: the persistence layer registers the generic store of every
 * *entity*, and this is not one. What it injects — the __overPlural__ store —
 * comes from that layer under __overUpper___TOKENS.store, already bound to the
 * active engine and to any transaction that happens to be open.
 *
 * Transient, like every generated binding: they hold nothing between requests,
 * and the router resolves each controller once at startup.
 */
export function __registerFn__(container: DependencyContainer): void {
  container.register(__entityUpper___TOKENS.repository, { useClass: __entityName__Repository });
  container.register(__entityUpper___TOKENS.bll, { useClass: __entityName__BLL });
  container.register(__entityUpper___TOKENS.controller, { useClass: __entityName__Controller });
}

/**
 * The module, as the one value `composition/modules.ts` lists.
 *
 * **No `registration`, and that is the point.** A query owns no table, so there
 * is nothing for the persistence layer to build from it — and a module with no
 * table is not an incomplete module. It joins the same list as everything else
 * instead of being wired by hand in the composition root, which is where this
 * kind of module used to end up.
 */
export const __entityUpper___MODULE: MonoliteModule = {
  register: __registerFn__,
  // Referenced, not imported for effect: `@ApiController` only runs when the
  // class is loaded, and a field cannot be dropped the way an unused import can.
  controller: __entityName__Controller,
};
