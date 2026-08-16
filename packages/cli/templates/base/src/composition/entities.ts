import type { AnyEntityRegistration } from "monolite-di";
// #if example
import { PRODUCTS_ENTITY_REGISTRATION } from "./modules/product.module";
// #endif

/**
 * Every entity the persistence layer builds a repository for.
 *
 * One list, and it has to be one list: the unit of work indexes the
 * repositories by entity name so that a transaction can hand a service the
 * *same* repository it would get outside one, and that index is built once,
 * when the layer is assembled. An entity registered afterwards would have a
 * store and no seat in any transaction.
 *
 * This is the file `monolite generate module` asks you to add one line to. It
 * is deliberately the only one — the module it writes carries its own tokens,
 * its own registration and its own metadata, so what is left here is a name.
 */
export const ENTITIES: readonly AnyEntityRegistration[] = [
  // #if example
  PRODUCTS_ENTITY_REGISTRATION,
  // #endif
];
