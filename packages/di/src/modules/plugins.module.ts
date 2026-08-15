import { AsyncRequestContext } from "@monolite/core";
import type { ILogger, IRequestContext } from "@monolite/core";
import { AsyncTransactionContext } from "@monolite/data";
import type { ITransactionContext } from "@monolite/data";
import { container as rootContainer, registerBinding, registerInstance } from "../container.js";
import type { Binding, Constructor, DependencyContainer } from "../container.js";
import type { IEnvs } from "../env.js";
import { TOKENS } from "../tokens.js";

/** What the rest of the wiring needs to have resolved already. */
export interface Plugins {
  /** Absent when the application does not configure itself from the environment. */
  envs?: IEnvs;
  logger: ILogger;
  requestContext: IRequestContext;
  transactions: ITransactionContext;
}

export interface PluginsOptions {
  /** Defaults to the root container; pass a child one to isolate a test. */
  container?: DependencyContainer;

  /**
   * The logger, already built. It arrives built rather than as a class because
   * choosing between backends is a configuration read, not a dependency the
   * container can resolve: see `createLogger`.
   */
  logger: ILogger;

  /** Configuration source, registered under `TOKENS.IEnvs` when given. */
  envs?: IEnvs;

  /**
   * Runs right after the environment is registered and before anything is built
   * out of it.
   *
   * This is the hook for checking that the critical secrets are there. An
   * application that starts with an unset `JWT_SECRET` does not fail: it signs
   * tokens with whatever the default was, and nobody finds out until somebody
   * forges one. Throwing here turns that into a start-up error listing exactly
   * which variables are missing.
   */
  validate?: (envs: IEnvs) => void;

  /**
   * Ambient request context. Defaults to the kernel's `AsyncRequestContext`.
   *
   * Registered as a singleton whichever form it takes, and that is not a
   * preference: the store the HTTP middleware opens has to be the very same one
   * the repository reads three layers down, so two instances would mean the
   * audit columns silently recording "System" for every request.
   */
  requestContext?: Binding<IRequestContext>;

  /**
   * Transaction in progress. Defaults to the data package's
   * `AsyncTransactionContext`, and singleton for the same reason: the unit of
   * work opens the store and the repository reads it, so they have to be the
   * same object.
   */
  transactions?: Binding<ITransactionContext>;

  /**
   * Token service, registered under `TOKENS.ITokenService` when given.
   *
   * Its contract lives in the auth package, which this one deliberately does
   * not depend on, so the binding is passed through untouched. As a class it is
   * a singleton, which is what it wants to be: the secret is validated and kept
   * in the constructor, so rebuilding it on every resolution would only repeat
   * the work.
   */
  tokenService?: Binding<object>;

  /**
   * File storage, registered under `TOKENS.IFileStorage` when given.
   *
   * Also a singleton, and here it matters more: implementations create the
   * upload directory in their constructor. Registered as a class, nothing
   * touches the disk until somebody actually asks for it.
   */
  fileStorage?: Binding<object>;
}

/**
 * Registers a binding as a singleton and hands the instance back, because the
 * caller needs it: the persistence layer is built out of these objects, not out
 * of tokens.
 */
function bind<T>(
  container: DependencyContainer,
  token: string,
  binding: Binding<T> | undefined,
  fallback: Constructor<T>
): T {
  registerBinding<T>(container, token, binding ?? fallback);
  return container.resolve<T>(token);
}

/**
 * The cross-cutting services, in the only order they can be registered in: the
 * environment first, because the log driver, the token secret and the data
 * source all come out of it, and the request context before persistence,
 * because the user the generic repository writes into the audit columns comes
 * out of that.
 *
 * Everything registered here is framework-level. The application's own modules
 * —its repositories, services and controllers— are registered after this one
 * and in whatever order they like: a module declares its classes and tsyringe
 * resolves the dependencies when somebody asks for them, not when they are
 * registered.
 */
export function registerPlugins(options: PluginsOptions): Plugins {
  const container = options.container ?? rootContainer;
  const { envs } = options;

  if (envs) {
    registerInstance<IEnvs>(container, TOKENS.IEnvs, envs);
    // Fails loudly if a critical secret is missing, instead of quietly
    // degrading with insecure defaults.
    options.validate?.(envs);
  }

  registerInstance<ILogger>(container, TOKENS.ILogger, options.logger);

  const requestContext = bind<IRequestContext>(
    container,
    TOKENS.IRequestContext,
    options.requestContext,
    AsyncRequestContext
  );

  const transactions = bind<ITransactionContext>(
    container,
    TOKENS.ITransactionContext,
    options.transactions,
    AsyncTransactionContext
  );

  if (options.tokenService) {
    registerBinding<object>(container, TOKENS.ITokenService, options.tokenService);
  }

  if (options.fileStorage) {
    registerBinding<object>(container, TOKENS.IFileStorage, options.fileStorage);
  }

  return { envs, logger: options.logger, requestContext, transactions };
}
