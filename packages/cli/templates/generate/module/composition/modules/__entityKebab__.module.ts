import type { DependencyContainer, EntityRegistration, MonoliteModule } from "monolite-di";
import { __entityName__BLL } from "../../application/bll/__entityKebab__.bll";
import type { I__entityName__ } from "../../domain/models/__entityKebab__.model";
import { __entityConst__ } from "../../infrastructure/persistence/entities/__entityKebab__.entity";
import { __entityName__Controller } from "../../presentation/controllers/__entityKebab__.controller";
import { __entityUpper___TOKENS } from "./__entityKebab__.tokens";

// #if memory
/**
 * Rows the in-memory driver starts with, so the module answers something on the
 * first request. A real engine ignores this: its rows come from a migration,
 * not from the process that queries them.
 */
const SEED = [
  { name: "First __entityKebab__", description: "Created by the scaffold" },
  { name: "Second __entityKebab__", description: null },
];
// #endif

/**
 * What the persistence layer needs in order to build this entity's repository.
 *
 * It is data rather than a call because the layer is assembled once, over every
 * entity at the same time: that is what lets the unit of work hand a BLL
 * the *same* repository inside a transaction as outside one. It travels inside
 * the module descriptor below, so listing that module in `composition/modules.ts`
 * — which the generator does for you — is all the wiring the store needs.
 */
export const __entityPluralUpper___ENTITY_REGISTRATION: EntityRegistration<I__entityName__> = {
  // The logical name the unit of work indexes by. It matches the table so that
  // a BLL asking a transaction for `"__entityPluralUpper__"` is asking for
  // the obvious thing.
  name: "__entityPluralUpper__",
  metadata: __entityConst__,
  token: __entityUpper___TOKENS.store,
  // #if memory
  seed: SEED,
  // #endif
};

/**
 * The two layers of the __entityKebab__ module the container builds.
 *
 * Transient on purpose: they hold no state between requests, and the router
 * resolves each controller once at startup, so making them singletons would
 * save nothing and would hide an accidental field the day somebody adds one.
 *
 * The repository is not here — it is registered by the persistence layer from
 * the registration above, because it is the one object that must be shared: a
 * second one per request would mean a second connection pool.
 *
 * The marker at the end is where `monolite generate repository` inserts. Move
 * it or delete it and that command goes back to printing the line to add.
 */
export function __registerFn__(container: DependencyContainer): void {
  container.register(__entityUpper___TOKENS.bll, { useClass: __entityName__BLL });
  container.register(__entityUpper___TOKENS.controller, { useClass: __entityName__Controller });
  // monolite:bindings
}

/**
 * The module, as the one value `composition/modules.ts` lists.
 *
 * Its registration, its bindings and its controller travel together, which is
 * what turns wiring a new module into a single line in a single file — and what
 * makes that line something `monolite generate module` can insert for you.
 */
export const __entityUpper___MODULE: MonoliteModule<I__entityName__> = {
  registration: __entityPluralUpper___ENTITY_REGISTRATION,
  register: __registerFn__,
  // Referenced, not imported for effect: `@ApiController` only runs when the
  // class is loaded, and a field cannot be dropped the way an unused import can.
  controller: __entityName__Controller,
};
