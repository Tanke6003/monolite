import { MemoryCache, type ICache, type IHealthProbe } from "monolite-core";
import { RedisCache } from "monolite-data";
import {
  createContainer,
  registerCache,
  registerPersistence,
  TOKENS,
  type DependencyContainer,
  type IEnvs,
} from "monolite-di";
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

  describe("in /health", () => {
    const redis = envsOf({ CACHE_DRIVER: "redis", REDIS_URL: "redis://cache:6379" });
    const persistence = (container: DependencyContainer, healthProbe?: false) =>
      registerPersistence({
        container,
        dataSource: "memory",
        logger,
        entities: [],
        ...(healthProbe === false ? { healthProbe } : {}),
      });
    const report = (container: DependencyContainer) =>
      container.resolve<IHealthProbe>(TOKENS.IHealthProbe).report();

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("reports the in-memory cache as not applicable, next to the database", async () => {
      const container = createContainer();
      persistence(container);
      registerCache({ container, envs: envsOf(), logger });

      await expect(report(container)).resolves.toMatchObject({
        ready: true,
        database: "not_applicable",
        cache: "not_applicable",
      });
    });

    it("pings Redis, and reports it down without making the instance not ready", async () => {
      const ping = jest.spyOn(RedisCache.prototype, "ping").mockRejectedValue(new Error("ECONNREFUSED"));
      const container = createContainer();
      persistence(container);
      registerCache({ container, envs: redis, logger });

      await expect(report(container)).resolves.toMatchObject({ ready: true, cache: "down" });
      expect(ping).toHaveBeenCalledTimes(1);
    });

    it("makes the instance not ready with a required cache that is down", async () => {
      jest.spyOn(RedisCache.prototype, "ping").mockRejectedValue(new Error("ECONNREFUSED"));
      const container = createContainer();
      persistence(container);
      registerCache({ container, envs: redis, logger, healthProbe: { required: true } });

      await expect(report(container)).resolves.toMatchObject({ ready: false, cache: "down" });
    });

    it("does not depend on which module runs first", async () => {
      jest.spyOn(RedisCache.prototype, "ping").mockResolvedValue();
      const container = createContainer();
      registerCache({ container, envs: redis, logger });
      persistence(container);

      await expect(report(container)).resolves.toMatchObject({ database: "not_applicable", cache: "up" });
    });

    it("can be left out of the report", async () => {
      const container = createContainer();
      persistence(container);
      registerCache({ container, envs: envsOf(), logger, healthProbe: false });

      await expect(report(container)).resolves.not.toHaveProperty("cache");
    });

    it("does not take the token when the application answers readiness itself", () => {
      const container = createContainer();
      persistence(container, false);
      registerCache({ container, envs: envsOf(), logger });

      expect(container.isRegistered(TOKENS.IHealthProbe)).toBe(false);
    });
  });
});
