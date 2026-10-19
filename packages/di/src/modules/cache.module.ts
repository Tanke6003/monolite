import { MemoryCache } from "monolite-core";
import type { CacheHealthOptions, ICache, ILogger } from "monolite-core";
import { RedisCache } from "monolite-data";
import type { RedisCacheConfig } from "monolite-data";
import { container as rootContainer, registerInstance } from "../container.js";
import type { DependencyContainer, IManagedConnection } from "../container.js";
import type { IEnvs } from "../env.js";
import { TOKENS } from "../tokens.js";
import { publishReadiness } from "./readiness.js";

export type CacheDriver = "memory" | "redis";

const DRIVERS: CacheDriver[] = ["memory", "redis"];

export interface CacheModuleOptions {
  /** Defaults to the root container; pass a child one to isolate a test. */
  container?: DependencyContainer;
  /** Where `CACHE_DRIVER`, `REDIS_URL`, `REDIS_KEY_PREFIX` and `SERVICE_NAME` are read. */
  envs?: IEnvs;
  logger: ILogger;
  /** Overrides `CACHE_DRIVER`. */
  driver?: CacheDriver;
  /** Overrides what the environment says about the Redis server. */
  redis?: RedisCacheConfig;
  /**
   * Reports the cache in `/health`, next to the database. On by default; pass
   * `false` to leave it out, or an object to tune the check's cache and
   * timeout — and `required: true` for a cache that is down to make the
   * instance not ready, which by default it does not.
   */
  healthProbe?: boolean | Omit<CacheHealthOptions, "connection">;
}

export interface CacheLayer {
  driver: CacheDriver;
  cache: ICache;
  /**
   * The connection to open on warm-up and close on shutdown — hand it to the
   * composition root's `manage`. `undefined` for the in-memory cache, which has
   * none, and `manage` ignores it.
   */
  connection?: IManagedConnection;
}

/**
 * The cache every package reaches through `TOKENS.ICache`, on the store the
 * configuration names.
 *
 * `CACHE_DRIVER=memory` — the default — keeps it in the process, so nothing new
 * is needed to run an application and the generated tests need no container.
 * `CACHE_DRIVER=redis` puts it on `REDIS_URL`, which is what makes a rate limit
 * one limit across replicas instead of one per replica. Nothing that depends on
 * `ICache` changes between the two.
 *
 * Every key goes under `REDIS_KEY_PREFIX`, or `SERVICE_NAME:` when that is not
 * set: two applications sharing a server would otherwise count each other's
 * login attempts.
 *
 * Like `registerPersistence`, it returns the layer because the connection is a
 * resource of the process, not a dependency anybody injects.
 */
export function registerCache(options: CacheModuleOptions): CacheLayer {
  const container = options.container ?? rootContainer;
  const { envs, logger } = options;

  const name = (options.driver || envs?.getEnv("CACHE_DRIVER") || "memory").trim().toLowerCase();
  if (!DRIVERS.includes(name as CacheDriver)) {
    // Loudly, as `DATA_SOURCE` and `LOG_DRIVER` do: `CACHE_DRIVER=reids` quietly
    // falling back to memory is a rate limit that stops holding across
    // replicas, and nobody would find out until somebody abused it.
    throw new Error(`[config] Unknown CACHE_DRIVER "${name}". Valid values: ${DRIVERS.join(", ")}.`);
  }

  const layer: CacheLayer =
    name === "redis"
      ? redisLayer(options.redis ?? redisConfigFrom(envs), logger)
      : { driver: "memory", cache: new MemoryCache() };

  registerInstance<ICache>(container, TOKENS.ICache, layer.cache);
  logger.info(`Cache: ${layer.driver}`);

  if (options.healthProbe !== false) {
    const tuning = typeof options.healthProbe === "object" ? options.healthProbe : {};
    // `ping`, not the connection's `authenticate`, which logs a line every time
    // it succeeds — every few seconds under a load balancer.
    const redis = layer.cache instanceof RedisCache ? layer.cache : undefined;
    const connection = redis && { authenticate: () => redis.ping() };

    publishReadiness(container, { cache: { ...tuning, connection } });
  }

  return layer;
}

function redisLayer(config: RedisCacheConfig, logger: ILogger): CacheLayer {
  const cache = new RedisCache(config, logger);
  return { driver: "redis", cache, connection: cache };
}

function redisConfigFrom(envs: IEnvs | undefined): RedisCacheConfig {
  const url = envs?.getEnv("REDIS_URL").trim();
  if (!url) {
    throw new Error(
      "[config] CACHE_DRIVER=redis needs REDIS_URL (redis://[[user]:password@]host[:port][/db]), " +
        "or pass `redis` to registerCache."
    );
  }

  const service = envs?.getEnv("SERVICE_NAME").trim();
  const keyPrefix = envs?.getEnv("REDIS_KEY_PREFIX") || (service ? `${service}:` : "");
  return { url, keyPrefix };
}
