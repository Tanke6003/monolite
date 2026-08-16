// Loading the polyfill here, once, is deliberate. tsyringe resolves
// constructor dependencies from the design-time types the TypeScript decorators
// emit, and that metadata only exists if `reflect-metadata` was evaluated
// before the first decorated class. Doing it in this module means that
// importing anything from `monolite-di` is enough: no consumer has to remember
// the import, and no other package of the toolkit has to carry the dependency.
import "reflect-metadata";
import { container as rootContainer, Lifecycle } from "tsyringe";
import type { DependencyContainer } from "tsyringe";

export { rootContainer as container };
export type { DependencyContainer };

/**
 * A class the container can build. Mirrors the shape tsyringe expects, spelled
 * out here so consumers do not have to reach into its internal typings.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T> = new (...args: any[]) => T;

/**
 * Either an already-built instance or the class the container should build.
 *
 * Both forms are accepted everywhere a dependency is configured because the
 * choice is not stylistic: an instance is the answer when the object needs
 * arguments the container cannot invent (a logger chosen from configuration, a
 * connection pool built at start-up), and a class is the answer when it should
 * not be built until somebody actually asks for it. They are told apart at
 * runtime by `typeof binding === "function"`, so a class is always a class and
 * an instance is anything else.
 */
export type Binding<T> = T | Constructor<T>;

/**
 * A resource the process owns, rather than a dependency anybody injects: the
 * connection pool of the active engine is the canonical one. Opened on warm-up,
 * closed on shutdown.
 */
export interface IManagedConnection {
  authenticate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A container of its own, isolated from the global one.
 *
 * The default wiring registers on the root container, which is what an
 * application wants: one process, one object graph. A test that needs to swap
 * an implementation should not have to undo the global registration afterwards,
 * and a library embedding another one should not see its bindings overwritten.
 * A child container resolves everything the parent knows and shadows only what
 * it registers itself.
 */
export function createContainer(parent: DependencyContainer = rootContainer): DependencyContainer {
  return parent.createChildContainer();
}

/**
 * Binds an already-built object to a token.
 *
 * This is the registration for anything whose construction happened outside the
 * container: the logger, whose implementation is picked from configuration, or
 * the generic repositories, which are built by the persistence factory over the
 * active engine.
 */
export function registerInstance<T>(
  container: DependencyContainer,
  token: string,
  instance: T
): void {
  container.register<T>(token, { useValue: instance });
}

/**
 * Binds a class that must exist exactly once in the process.
 *
 * Singleton is not the default here, it is a decision with a reason behind it
 * each time: an `AsyncLocalStorage`-based context has to be the *same* store
 * the middleware opens and the repository reads, and an object that validates a
 * secret or creates a directory in its constructor should do that work once.
 */
export function registerSingleton<T>(
  container: DependencyContainer,
  token: string,
  target: Constructor<T>
): void {
  container.register<T>(token, { useClass: target }, { lifecycle: Lifecycle.Singleton });
}

/**
 * Binds a class that is built again on every resolution.
 *
 * This is the right default for the three layers of a feature —repository,
 * service, controller—: they keep no state between requests and the routes
 * resolve them once at start-up, so making them singletons would save nothing
 * and would hide an accidental shared state the day somebody adds a field to
 * the class.
 */
export function registerClass<T>(
  container: DependencyContainer,
  token: string,
  target: Constructor<T>
): void {
  container.register<T>(token, { useClass: target });
}

/** Binds a token to whatever the factory returns, resolved on every request. */
export function registerFactory<T>(
  container: DependencyContainer,
  token: string,
  factory: (dependencies: DependencyContainer) => T
): void {
  container.register<T>(token, { useFactory: factory });
}

/**
 * Binds an instance or a class, whichever the caller passed. Classes go in as
 * singletons: see `registerSingleton` for why that is the sensible reading of
 * "here is the class, you build it".
 */
export function registerBinding<T>(
  container: DependencyContainer,
  token: string,
  binding: Binding<T>
): void {
  if (typeof binding === "function") {
    registerSingleton<T>(container, token, binding as Constructor<T>);
    return;
  }

  registerInstance<T>(container, token, binding);
}

/**
 * The composition root: the one place that knows which implementation covers
 * each interface, and the only place allowed to know it.
 *
 * It is deliberately thin. Its job is to fix the *order* in which the modules
 * register —the environment before the logger, because the log driver is read
 * from it; the request context before persistence, because the user of the
 * audit columns comes from it— and to hold on to the resources the process owns
 * so start-up and shutdown have something to talk to. Which class covers which
 * contract is decided in each module, not in this list.
 */
export class CompositionRoot {
  private readonly resources: IManagedConnection[] = [];

  constructor(readonly container: DependencyContainer = rootContainer) {}

  /**
   * Hands over a resource whose lifetime follows the process.
   *
   * `undefined` is accepted and ignored on purpose: that is what the in-memory
   * driver returns —there is nothing to open and nothing to close— and the
   * caller should not have to branch on it.
   */
  manage(resource?: IManagedConnection): void {
    if (resource) this.resources.push(resource);
  }

  /**
   * Checks the connections at start-up, so a credentials or network problem
   * shows up in the boot log instead of in the first user request. With the
   * in-memory driver there is nothing to open and this does nothing.
   */
  async warmUp(): Promise<void> {
    for (const resource of this.resources) {
      await resource.authenticate();
    }
  }

  /**
   * Closes the open resources —the active engine's pool— on an orderly
   * shutdown, in the reverse order they were handed over.
   *
   * Every resource is closed even if one of them throws: a connector that fails
   * on close must not leave the rest open and the process hanging on their
   * sockets. The first failure is re-thrown once the loop is done, so the
   * caller still learns that the shutdown was not clean.
   */
  async shutdown(): Promise<void> {
    let failure: unknown;

    for (const resource of [...this.resources].reverse()) {
      try {
        await resource.close();
      } catch (error) {
        failure ??= error;
      }
    }

    if (failure !== undefined) throw failure;
  }
}

/**
 * Builds the composition root and runs the registrations, which is the shape an
 * application's entry point takes:
 *
 * ```ts
 * export const root = createCompositionRoot((root) => {
 *   const plugins = registerPlugins({ container: root.container, ... });
 *   const persistence = registerPersistence({ container: root.container, ...plugins, ... });
 *   root.manage(persistence.connection);
 *
 *   registerUsers(root.container); // the application's own modules
 * });
 * ```
 *
 * The order matters up to persistence —the plugins provide the environment, the
 * log and the request context the persistence layer is built from— and stops
 * mattering after it: a module declares its classes and tsyringe resolves the
 * dependencies when somebody asks for them, not when they are registered.
 */
export function createCompositionRoot(
  register: (root: CompositionRoot) => void,
  container: DependencyContainer = rootContainer
): CompositionRoot {
  const root = new CompositionRoot(container);
  register(root);
  return root;
}
