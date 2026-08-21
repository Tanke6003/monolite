/**
 * `monolite-di` — the toolkit's dependency-injection wiring, on tsyringe.
 *
 * Everything the rest of the framework needs in order to be assembled lives
 * here, and nothing the rest of the framework needs in order to *work* does.
 * The kernel, the data layer, the HTTP layer and the feature packages all take
 * their dependencies as constructor arguments and never mention a container, so
 * an application that prefers Awilix, InversifyJS or plain `new` calls simply
 * never installs this package and wires the same objects by hand. That is the
 * reason `tsyringe` and `reflect-metadata` appear in exactly one
 * `package.json` in the whole monorepo: this one.
 */

// ------------------------------------------------------------  container  ---
export {
  container,
  CompositionRoot,
  createCompositionRoot,
  createContainer,
  registerBinding,
  registerClass,
  registerFactory,
  registerInstance,
  registerSingleton,
} from "./container.js";
export type {
  Binding,
  Constructor,
  DependencyContainer,
  IManagedConnection,
} from "./container.js";

// ---------------------------------------------------------------  tokens  ---
export { storeToken, TOKENS } from "./tokens.js";
export type { Token, TokenName } from "./tokens.js";

// --------------------------------------------------------  configuration  ---
export type { IEnvs } from "./env.js";

// --------------------------------------------------------------  loggers  ---
export { createLogger } from "./logger.factory.js";
export type { LoggerDriverFactory, LoggerOptions, LoggerSettings } from "./logger.factory.js";

// ----------------------------------------------------------  persistence  ---
export {
  buildMongoConfig,
  buildOracleConfig,
  buildSequelizeConfig,
  createPersistenceLayer,
  isOracleDriver,
  missingDataSourceEnv,
  resolveDriver,
  validateDataSourceEnv,
} from "./repository.factory.js";
export type {
  AnyEntityRegistration,
  AnyGenericRepository,
  EntityRegistration,
  PersistenceDriver,
  PersistenceLayer,
  PersistenceOptions,
} from "./repository.factory.js";

// --------------------------------------------------------------  modules  ---
export { registerPlugins } from "./modules/plugins.module.js";
export type { Plugins, PluginsOptions } from "./modules/plugins.module.js";

export { registerPersistence } from "./modules/persistence.module.js";
export type { PersistenceModuleOptions } from "./modules/persistence.module.js";
