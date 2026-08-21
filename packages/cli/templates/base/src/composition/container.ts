// Registering on import is deliberate: `main.ts`, the router and the tests all
// assume that importing this file is enough to have a working container.
import {
  createCompositionRoot,
  entitiesOf,
  registerModules,
  registerPersistence,
  registerPlugins,
  validateDataSourceEnv,
} from "monolite-di";
// #if auth
import { registerAuth } from "./auth.module";
// #endif
import { envs } from "../config/env";
import { ConsoleLogger } from "../infrastructure/logger";
import { MODULES } from "./modules";

/**
 * Composition root.
 *
 * The wiring itself lives in `monolite-di`: which class covers which contract
 * is decided per module, and the order the modules run in is decided here. That
 * order is not stylistic — the logger and the request context are what the
 * persistence layer is built with, and the request context is what the generic
 * repository reads to fill the audit columns. From the feature modules
 * downwards it stops mattering: tsyringe resolves a dependency when someone
 * asks for it, not when it is registered.
 *
 * `reflect-metadata` is not imported here. `monolite-di` loads it before
 * anything else it exports, which is early enough for every decorator in the
 * project, and importing it twice is how the polyfill ends up loaded in the
 * wrong order.
 */
export const root = createCompositionRoot((root) => {
  const plugins = registerPlugins({
    container: root.container,
    envs,
    logger: new ConsoleLogger(),
    /**
     * Everything the process cannot honestly start without, checked here rather
     * than discovered later.
     *
     * A missing credential does not stop an application: it degrades it. The
     * database one surfaces at whichever request first touches the database, by
     * which point the cause is three layers from the symptom, and the signing
     * one never surfaces at all — tokens get signed with the fallback and
     * nobody finds out until somebody forges one.
     */
    validate: (source) => {
      // #if auth
      if (!source.getEnv("JWT_SECRET")) {
        throw new Error("[config] JWT_SECRET is required and is not set");
      }
      // #endif
      // Only what the engine named in `DATA_SOURCE` needs: nobody should have
      // to configure five engines in order to run the one they chose.
      validateDataSourceEnv(source);
    },
  });

  // Every entity's generic repository, the unit of work and the health probe,
  // built over the engine `DATA_SOURCE` names. Nothing below this line knows
  // which engine that is, which is what makes switching one a change of
  // configuration instead of a change of code.
  const persistence = registerPersistence({
    container: root.container,
    entities: entitiesOf(MODULES),
    logger: plugins.logger,
    envs,
    context: plugins.requestContext,
    transactions: plugins.transactions,
  });

  // The connection is not registered in the container: it is a resource of the
  // process, not a dependency anybody injects. Handing it over here is what
  // gets it opened on warm-up and closed on shutdown.
  root.manage(persistence.connection);
  // #if auth

  registerAuth(root.container);
  // #endif

  // Every feature module's own bindings, from the one list in `modules.ts`.
  registerModules(root.container, MODULES);
});

export const container = root.container;

// Re-exported so the rest of the project has one import for the framework
// tokens rather than a choice between two spellings of the same table.
export { TOKENS } from "monolite-di";
