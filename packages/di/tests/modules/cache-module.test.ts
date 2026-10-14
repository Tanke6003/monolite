import { MemoryCache, type ICache } from "monolite-core";
import { RedisCache } from "monolite-data";
import { createContainer, registerCache, TOKENS, type IEnvs } from "monolite-di";
import { silentLogger } from "../support/test-entity";

const logger = silentLogger();
const envsOf = (values: Record<string, string> = {}): IEnvs => ({
  getEnv: (key: string) => values[key] ?? "",
});

describe("registerCache", () => {
  it("keeps the cache in the process when nothing is configured", () => {
    const container = createContainer();
    const layer = registerCache({ container, envs: envsOf(), logger });

    expect(layer.driver).toBe("memory");
    expect(layer.cache).toBeInstanceOf(MemoryCache);
    // Nothing to open or close: `manage` ignores it.
    expect(layer.connection).toBeUndefined();
    expect(container.resolve<ICache>(TOKENS.ICache)).toBe(layer.cache);
  });

  it("puts it on Redis with CACHE_DRIVER=redis, and hands back the connection to manage", () => {
    const container = createContainer();
    const layer = registerCache({
      container,
      envs: envsOf({ CACHE_DRIVER: "Redis", REDIS_URL: "redis://cache:6379" }),
      logger,
    });

    expect(layer.driver).toBe("redis");
    expect(layer.cache).toBeInstanceOf(RedisCache);
    expect(layer.connection).toBe(layer.cache);
    expect(container.resolve<ICache>(TOKENS.ICache)).toBe(layer.cache);
  });

  it("refuses a driver it does not know rather than falling back to memory", () => {
    // `reids` quietly becoming memory is a rate limit that stops holding
    // across replicas, and nobody would notice until somebody abused it.
    expect(() =>
      registerCache({ container: createContainer(), envs: envsOf({ CACHE_DRIVER: "reids" }), logger })
    ).toThrow(/Unknown CACHE_DRIVER "reids".*memory, redis/);
  });

  it("asks for REDIS_URL by name when Redis is chosen without one", () => {
    expect(() =>
      registerCache({ container: createContainer(), envs: envsOf({ CACHE_DRIVER: "redis" }), logger })
    ).toThrow(/REDIS_URL/);
  });

  it("lets the options override the environment", () => {
    const layer = registerCache({
      container: createContainer(),
      envs: envsOf({ CACHE_DRIVER: "redis" }),
      driver: "memory",
      logger,
    });

    expect(layer.driver).toBe("memory");
  });
});
