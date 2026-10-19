import { CacheHealthProbe } from "monolite-core";
import type { CacheHealthOptions, IHealthProbe } from "monolite-core";
import { registerInstance } from "../container.js";
import type { DependencyContainer } from "../container.js";
import { TOKENS } from "../tokens.js";

/** What a container's readiness is built from, as each module hands it over. */
interface Readiness {
  /** The persistence layers' probe: one layer's own, or one over all of them. */
  database?: IHealthProbe;
  /** How to check the shared cache, once `registerCache` ran. */
  cache?: CacheHealthOptions;
}

/** Weak, so a container a test throws away takes its readiness with it. */
const readinessOf = new WeakMap<DependencyContainer, Readiness>();

/**
 * Registers the probe `/health` reads, under `TOKENS.IHealthProbe`, from what
 * the modules handed over so far.
 *
 * Both `registerPersistence` and `registerCache` call it with their part, so
 * neither has to run first: whichever runs second finds the other's part here
 * and the token ends up with both. The cache only rides along on a database
 * probe — an application that turned that probe off answers readiness itself,
 * and a cache check should not quietly take the token back.
 */
export function publishReadiness(container: DependencyContainer, part: Readiness): void {
  const readiness = { ...readinessOf.get(container), ...part };
  readinessOf.set(container, readiness);

  if (!readiness.database) return;

  registerInstance<IHealthProbe>(
    container,
    TOKENS.IHealthProbe,
    readiness.cache ? new CacheHealthProbe(readiness.database, readiness.cache) : readiness.database
  );
}
