import type { ILogger } from "@monolite/core";
import type { IEnvs } from "./env.js";

/** What every logging backend is given, whichever one is picked. */
export interface LoggerSettings {
  /** Minimum level that gets written: `trace`, `debug`, `info`, ... */
  level: string;
  /** Name the lines are tagged with, so several services share one collector. */
  service: string;
}

/** Builds a logging backend from the resolved settings. */
export type LoggerDriverFactory = (settings: LoggerSettings) => ILogger;

export interface LoggerOptions {
  /**
   * The backends this application is willing to run, by the name `LOG_DRIVER`
   * uses for them: `{ pino: (s) => new PinoLogger(s), winston: ... }`.
   *
   * They are handed in rather than imported here, and that is the one real
   * difference from the original factory, which named pino and winston
   * directly. This package is the container wiring: making it import both
   * would put both in the dependency tree of everyone who installs it, to run
   * one of them at most. The selection logic —which is the part worth
   * sharing— stays here; the implementations stay wherever they are already
   * paid for.
   */
  drivers: Record<string, LoggerDriverFactory>;

  /** Where `LOG_DRIVER`, `LOG_LEVEL` and `SERVICE_NAME` are read from. */
  envs?: IEnvs;

  /** Backend to use, overriding `LOG_DRIVER`. */
  driver?: string;

  /** Used when neither the option nor `LOG_DRIVER` says anything. */
  defaultDriver?: string;

  /** Level to use, overriding `LOG_LEVEL`. */
  level?: string;

  /** Service name, overriding `SERVICE_NAME`. */
  service?: string;
}

const DEFAULT_DRIVER = "pino";
const DEFAULT_LEVEL = "debug";
const DEFAULT_SERVICE = "app";

/**
 * Builds the `ILogger` implementation named by `LOG_DRIVER`, with pino as the
 * default. Switching logging backend is therefore a change of configuration and
 * touches nothing else in the wiring.
 *
 * It fails loudly on an unknown value instead of quietly falling back to the
 * default: a misspelled `LOG_DRIVER=wiston` would otherwise start with the
 * wrong backend, and the mistake would only show up the day somebody goes
 * looking for the log files it was supposed to be writing.
 */
export function createLogger(options: LoggerOptions): ILogger {
  const { drivers, envs } = options;

  const name = (
    options.driver ||
    envs?.getEnv("LOG_DRIVER") ||
    options.defaultDriver ||
    DEFAULT_DRIVER
  )
    .trim()
    .toLowerCase();

  const level = options.level || envs?.getEnv("LOG_LEVEL") || DEFAULT_LEVEL;
  const service = options.service || envs?.getEnv("SERVICE_NAME") || DEFAULT_SERVICE;

  const factory = drivers[name];

  if (!factory) {
    throw new Error(
      `[config] Unknown LOG_DRIVER "${name}". Valid values: ` +
        `${Object.keys(drivers).join(", ") || "none registered"}.`
    );
  }

  return factory({ level, service });
}
