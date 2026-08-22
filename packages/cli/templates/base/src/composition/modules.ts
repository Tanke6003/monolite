import type { AnyMonoliteModule } from "monolite-di";
// #if example
import { PRODUCT_MODULE } from "./modules/product.module";
// #endif

/**
 * Every feature module this application is made of.
 *
 * One list, and it is the only one. A module used to be added in three places —
 * its registration to `entities.ts`, its bindings to `container.ts`, an import
 * to `routes.ts` — none of which was a decision, and any of which could be
 * forgotten into a module that compiles and is never served.
 *
 * A `MonoliteModule` carries all three, so what is left here is a name. The
 * persistence layer takes the registrations, the container runs the bindings,
 * and the controllers load simply by being referenced from here: `@ApiController`
 * only runs when the class does.
 *
 * A module does not have to own a table. Leave `registration` off and it is a
 * set of bindings and a controller — which is what a report, a search across
 * several entities, a dashboard or a webhook receiver actually is. It goes in
 * this list like any other, rather than being wired by hand somewhere else.
 *
 * The marker below is where `monolite generate module` inserts. It edits this
 * file and no other, and only while the marker is where it left it — move it or
 * delete it and the command goes back to telling you the line to add.
 */
export const MODULES: readonly AnyMonoliteModule[] = [
  // #if example
  PRODUCT_MODULE,
  // #endif
  // monolite:modules
];
