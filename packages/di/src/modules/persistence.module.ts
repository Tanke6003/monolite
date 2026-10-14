import { CompositeHealthProbe, HealthProbe } from "monolite-core";
import type { IHealthProbe } from "monolite-core";
import { AsyncTransactionContext, attachTransactionSeam, transactionAware } from "monolite-data";
import type { IAuditTrail, ITransactionContext, IUnitOfWork } from "monolite-data";
import { container as rootContainer, registerInstance } from "../container.js";
import type { DependencyContainer } from "../container.js";
import { createPersistenceLayer } from "../repository.factory.js";
import type {
  AnyEntityRegistration,
  PersistenceLayer,
  PersistenceOptions,
} from "../repository.factory.js";
import {
  auditLogStoreToken,
  auditTrailToken,
  healthProbeToken,
  storeToken,
  TOKENS,
  transactionContextToken,
  unitOfWorkToken,
} from "../tokens.js";

export interface PersistenceModuleOptions extends PersistenceOptions {
  /** Defaults to the root container; pass a child one to isolate a test. */
  container?: DependencyContainer;

  /**
   * Names the layer, for an application with more than one engine (#43).
   *
   * Absent, the layer registers its unit of work, change log and probe under
   * the plain tokens, exactly as it always has. Named, under
   * `unitOfWorkToken(name)` and its siblings, so a second layer does not
   * overwrite the first; its stores join only its own transactions, and
   * `@Transactional(name)` opens one on it.
   */
  name?: string;

  /**
   * Health probe over the active connection. Registered by default; pass
   * `false` to leave the token free, or an object to tune the cache and the
   * timeout of the check.
   */
  healthProbe?: boolean | { ttlMs?: number; timeoutMs?: number };
}

/** What a container remembers about each layer registered in it. */
interface LayerRecord {
  tables: ReadonlySet<string>;
  transactions?: ITransactionContext;
  probe?: IHealthProbe;
}

/** How the unnamed layer is called in messages and in `/health`. */
const DEFAULT_LAYER = "default";

/**
 * The layers of each container, keyed by name (`DEFAULT_LAYER` for the unnamed
 * one). Weak, so a container a test throws away takes its layers with it.
 */
const layersOf = new WeakMap<DependencyContainer, Map<string, LayerRecord>>();

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
 *
 * An application with more than one engine calls it once per engine, each
 * with a `name`. What stays the same is the property worth protecting: a
 * feature injects its own store and never learns which engine is under it.
 * What does not is the transaction — **it never spans layers**, because two
 * engines cannot share a commit — and that is why the boundary is a layer with
 * a name rather than a property of each table: the name is what shows up in
 * `@Transactional("records")`.
 */
export function registerPersistence(options: PersistenceModuleOptions): PersistenceLayer {
  const container = options.container ?? rootContainer;
  const { name } = options;
  const label = name ?? DEFAULT_LAYER;

  const layers = layersOf.get(container) ?? new Map<string, LayerRecord>();
  layersOf.set(container, layers);
  const others = [...layers].filter(([other]) => other !== label);

  if (name !== undefined) assertLayerName(name, layers);
  assertNoRelationAcrossLayers(label, options.entities, others);

  // A named layer gets a context of its own. Sharing one is how a store of
  // `documents` would find a `records` transaction open and try to join it —
  // asking that transaction for a repository it does not have — and how a
  // `documents` service would believe it was already inside a transaction and
  // not open its own.
  const transactions =
    options.transactions ?? (name !== undefined ? new AsyncTransactionContext() : undefined);

  if (transactions) {
    const sharing = others.find(([, other]) => other.transactions === transactions);
    if (sharing) {
      throw new Error(
        `[persistence] layers "${sharing[0]}" and "${label}" share one transaction context, so ` +
          "each would join the other's transactions. Leave `transactions` out of a named layer " +
          "and it gets one of its own."
      );
    }
  }

  const persistence: PersistenceLayer = {
    ...createPersistenceLayer({ ...options, transactions }),
    ...(name === undefined ? {} : { name }),
  };

  // One token per entity, so a feature's repository injects its own store and
  // nothing else. The name follows the convention in `storeToken` unless the
  // registration spells one out.
  //
  // Each one is wrapped so that it joins whatever transaction is open. Without
  // that, a service decorated with `@Transactional()` opens a transaction and
  // then writes outside it on the pool's connection — quietly, because three
  // auto-commits look exactly like one transaction until something throws in
  // the middle. The wrapper is what makes the ambient behaviour the packages
  // have always documented true of the stores they actually bind.
  //
  // The unit of work rides along, so the store also carries the seam a service
  // opens a transaction with: `CrudBLL` reads it off the store it was handed,
  // which is what makes every generated module atomic by default with no
  // constructor argument added (#33).
  for (const entity of persistence.entities) {
    const store = persistence.store(entity.name);

    registerInstance(
      container,
      entity.token ?? storeToken(entity.name),
      transactions
        ? transactionAware(store, entity.name, transactions, persistence.unitOfWork, name)
        : store
    );
  }

  if (persistence.auditLogStore) {
    registerInstance(container, auditLogStoreToken(name), persistence.auditLogStore);
  }

  if (persistence.auditTrail) {
    registerInstance<IAuditTrail>(container, auditTrailToken(name), persistence.auditTrail);
  }

  if (transactions) {
    // So a service that keeps the unit of work itself, rather than a store, is
    // found by `@Transactional(name)` too.
    attachTransactionSeam(persistence.unitOfWork, {
      unitOfWork: persistence.unitOfWork,
      transactions,
      ...(name === undefined ? {} : { layer: name }),
    });
  }

  registerInstance<IUnitOfWork>(container, unitOfWorkToken(name), persistence.unitOfWork);

  if (name !== undefined && transactions) {
    registerInstance<ITransactionContext>(container, transactionContextToken(name), transactions);
  }

  // The probe is mounted here because this is where the connection is, and the
  // connection is not registered in the container: it is a resource of the
  // process, not a dependency that gets injected. With the in-memory driver
  // there is none, and the probe answers "not applicable" instead of pretending
  // to check something.
  let probe: IHealthProbe | undefined;

  if (options.healthProbe !== false) {
    const tuning = typeof options.healthProbe === "object" ? options.healthProbe : {};

    probe = new HealthProbe({
      connection: persistence.connection,
      dataSource: persistence.driver,
      ...tuning,
    });

    if (name !== undefined) registerInstance<IHealthProbe>(container, healthProbeToken(name), probe);
  }

  layers.set(label, {
    tables: new Set(persistence.entities.map((entity) => entity.metadata.table)),
    transactions,
    probe,
  });

  registerReadiness(container, layers);

  return persistence;
}

/**
 * The probe `/health` reads, under `TOKENS.IHealthProbe`.
 *
 * With only the unnamed layer it is that layer's own probe, as it always was.
 * With more, one over all of them, which says which store is down instead of
 * one answer for the process.
 */
function registerReadiness(container: DependencyContainer, layers: Map<string, LayerRecord>): void {
  const probes = new Map<string, IHealthProbe>();
  for (const [label, layer] of layers) if (layer.probe) probes.set(label, layer.probe);

  if (probes.size === 0) return;

  const only = layers.size === 1 ? layers.get(DEFAULT_LAYER)?.probe : undefined;

  registerInstance<IHealthProbe>(
    container,
    TOKENS.IHealthProbe,
    only ?? new CompositeHealthProbe(probes)
  );
}

function assertLayerName(name: string, layers: Map<string, LayerRecord>): void {
  if (name.trim() === "" || name !== name.trim()) {
    throw new Error(`[persistence] a layer name cannot be empty or padded; received "${name}".`);
  }
  if (name === DEFAULT_LAYER) {
    throw new Error(
      `[persistence] "${DEFAULT_LAYER}" is how the unnamed layer is reported; leave \`name\` out ` +
        "for that layer, or pick another one."
    );
  }
  if (layers.has(name)) {
    // Not a replacement: the second one would take the unit of work and leave
    // the first one's stores joining transactions nobody opens any more.
    throw new Error(`[persistence] a layer called "${name}" is already registered in this container.`);
  }
}

/**
 * A relation into a table another layer holds.
 *
 * `assemble` would refuse it anyway, as a relation to a table nobody
 * registered. Saying "across layers" instead names the actual mistake, and
 * the two layers it sits between.
 */
function assertNoRelationAcrossLayers(
  label: string,
  entities: readonly AnyEntityRegistration[],
  others: [string, LayerRecord][]
): void {
  const own = new Set(entities.map((entity) => entity.metadata.table));
  const crossing: string[] = [];

  for (const entity of entities) {
    for (const [relation, spec] of Object.entries(entity.metadata.relations ?? {})) {
      if (own.has(spec.to)) continue;
      const holder = others.find(([, layer]) => layer.tables.has(spec.to));
      if (holder) {
        crossing.push(
          `${entity.metadata.table}.${relation} -> ${spec.to} (layer "${holder[0]}")`
        );
      }
    }
  }

  if (crossing.length === 0) return;

  throw new Error(
    `[persistence] relation(s) from layer "${label}" into another layer: ${crossing.join(", ")}. ` +
      "A relation cannot cross layers — no join and no foreign key reach another engine. Keep " +
      "the key as a plain column and read the other side through its own store."
  );
}
