import { HealthProbe } from "@monolite/core";
import type { IHealthProbe } from "@monolite/core";
import type { IAuditTrail, IUnitOfWork } from "@monolite/data";
import { container as rootContainer, registerInstance } from "../container.js";
import type { DependencyContainer } from "../container.js";
import { createPersistenceLayer } from "../repository.factory.js";
import type { PersistenceLayer, PersistenceOptions } from "../repository.factory.js";
import { storeToken, TOKENS } from "../tokens.js";

export interface PersistenceModuleOptions extends PersistenceOptions {
  /** Defaults to the root container; pass a child one to isolate a test. */
  container?: DependencyContainer;

  /**
   * Health probe over the active connection. Registered by default; pass
   * `false` to leave the token free, or an object to tune the cache and the
   * timeout of the check.
   */
  healthProbe?: boolean | { ttlMs?: number; timeoutMs?: number };
}

/**
 * A single point builds the generic repositories of every entity and the unit
 * of work, on whatever engine the configuration names —memory, Oracle, SQL
 * Server, PostgreSQL, MySQL or MongoDB. From here on nobody knows which one it
 * is: each feature's repository receives its store and they all speak the same
 * contract.
 *
 * It returns the whole layer because start-up and shutdown need the connection,
 * which is *not* registered in the container: it is not a dependency anybody
 * injects, it is a resource of the process. Hand it to the composition root's
 * `manage` and it will be opened and closed with it.
 */
export function registerPersistence(options: PersistenceModuleOptions): PersistenceLayer {
  const container = options.container ?? rootContainer;
  const persistence = createPersistenceLayer(options);

  // One token per entity, so a feature's repository injects its own store and
  // nothing else. The name follows the convention in `storeToken` unless the
  // registration spells one out.
  for (const entity of persistence.entities) {
    registerInstance(
      container,
      entity.token ?? storeToken(entity.name),
      persistence.store(entity.name)
    );
  }

  if (persistence.auditLogStore) {
    registerInstance(container, TOKENS.IAuditLogStore, persistence.auditLogStore);
  }

  if (persistence.auditTrail) {
    registerInstance<IAuditTrail>(container, TOKENS.IAuditTrail, persistence.auditTrail);
  }

  registerInstance<IUnitOfWork>(container, TOKENS.IUnitOfWork, persistence.unitOfWork);

  // The probe is mounted here because this is where the connection is, and the
  // connection is not registered in the container: it is a resource of the
  // process, not a dependency that gets injected. With the in-memory driver
  // there is none, and the probe answers "not applicable" instead of pretending
  // to check something.
  if (options.healthProbe !== false) {
    const tuning = typeof options.healthProbe === "object" ? options.healthProbe : {};

    registerInstance<IHealthProbe>(
      container,
      TOKENS.IHealthProbe,
      new HealthProbe({
        connection: persistence.connection,
        dataSource: persistence.driver,
        ...tuning,
      })
    );
  }

  return persistence;
}
