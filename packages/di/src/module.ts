import type { DependencyContainer } from "tsyringe";

import type { AnyEntityRegistration, EntityRegistration } from "./repository.factory.js";

/**
 * A feature module, as one value.
 *
 * It exists because the alternative was three lists. A generated module used to
 * be added to `composition/entities.ts` for its registration, to
 * `composition/container.ts` for its bindings and to `presentation/routes.ts`
 * for the import that runs its controller's decorators — three files, six lines,
 * every time, and none of it a decision. The failure mode of forgetting one is a
 * module that compiles perfectly and is simply never served.
 *
 * Bundling the three into a descriptor makes it one line in one list, which is
 * also what makes it something a generator can insert. What could not be
 * automated safely was never the wiring; it was that the wiring was spread out.
 */
export interface MonoliteModule<T extends object = never> {
  /**
   * What the persistence layer builds this module's repository from.
   *
   * Optional, because not every module owns a table. A sales report reads three
   * that already exist; so do a search endpoint across several tables, a
   * dashboard, an import job and a webhook receiver. Each is a set of bindings
   * and a controller, and requiring an entity would send all of them back to
   * being registered by hand in the composition root — which is the wiring this
   * descriptor was introduced to remove.
   */
  registration?: EntityRegistration<T>;

  /** The module's own container bindings: its service, its controller. */
  register(container: DependencyContainer): void;

  /**
   * The controller class.
   *
   * Held rather than imported for its side effect, and the difference matters:
   * `@ApiController` only runs when the class is loaded, so something has to
   * reference it. A bare `import "./x.controller"` does that too — and is the
   * first thing a bundler or an over-eager linter removes, because nothing
   * appears to use it. A field cannot be dropped that way.
   */
  controller: new (...args: never[]) => object;
}

/** A module whatever its model type; see `AnyEntityRegistration`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMonoliteModule = MonoliteModule<any>;

/**
 * The registrations the persistence layer wants, in the order they were listed.
 *
 * Modules without one are skipped rather than rejected: a module with no table
 * is not an incomplete module, it is a module with nothing for the persistence
 * layer to build.
 */
export function entitiesOf(modules: readonly AnyMonoliteModule[]): AnyEntityRegistration[] {
  return modules
    .map((module) => module.registration)
    .filter((registration): registration is AnyEntityRegistration => registration !== undefined);
}

/**
 * Runs every module's bindings.
 *
 * Order does not matter here and that is worth saying: tsyringe resolves a
 * dependency when somebody asks for it, not when it is registered, so a module
 * may bind something a module listed before it will later inject.
 */
export function registerModules(
  container: DependencyContainer,
  modules: readonly AnyMonoliteModule[]
): void {
  for (const module of modules) module.register(container);
}
