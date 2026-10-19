/**
 * `RedisCache` against a real server: the cache contract the in-memory cache
 * passes, and the one property only a shared store can have — two connections,
 * standing in for two replicas, agree on who got a key.
 *
 * `MONOLITE_IT_CACHES` selects it the way `MONOLITE_IT_ENGINES` selects the
 * repository engines: unset means every cache this suite knows (Redis), and a
 * cache that was asked for and is not there fails the run. `none` says, out
 * loud, that this run verifies no cache.
 */
import { randomUUID } from "node:crypto";
import { CacheHealthProbe, HealthProbe, type ILogger } from "monolite-core";
import { RedisCache } from "monolite-data";
import { runCacheContract } from "monolite-data/testing";

const REDIS_URL = process.env.MONOLITE_IT_REDIS_URL ?? "redis://localhost:56379";

const asked = (process.env.MONOLITE_IT_CACHES ?? "redis").trim().toLowerCase();
const wanted = asked === "none" ? [] : asked.split(",").map((one) => one.trim());
const unknown = wanted.filter((one) => one !== "redis");
if (unknown.length) {
  throw new Error(`MONOLITE_IT_CACHES names a cache this suite does not know: ${unknown.join(", ")}. Known: redis.`);
}

const logger: ILogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  log: () => undefined,
} as unknown as ILogger;

const describeRedis = wanted.includes("redis") ? describe : describe.skip;

describeRedis("redis", () => {
  const opened: RedisCache[] = [];

  /** A cache under a prefix of its own, so no test sees another's keys. */
  const open = (keyPrefix = `it:${randomUUID()}:`) => {
    const cache = new RedisCache({ url: REDIS_URL, keyPrefix }, logger);
    opened.push(cache);
    return cache;
  };

  // Here rather than in the contract's `teardown`, which runs when the
  // contract's own block ends — before the tests below open their connections.
  afterAll(async () => {
    // Each prefix is removed through the cache itself, which is also a last
    // check that `deletePrefix` stays inside its own.
    for (const cache of opened) await cache.deletePrefix("");
    await Promise.all(opened.map((cache) => cache.close()));
  });

  runCacheContract("redis", { create: () => open() });

  describe("across two connections", () => {
    it("lets exactly one replica take a key", async () => {
      const prefix = `it:${randomUUID()}:`;
      const one = open(prefix);
      const two = open(prefix);

      const answers = await Promise.all(
        Array.from({ length: 10 }, (_, i) => (i % 2 ? one : two).add("lock", i, 10))
      );

      expect(answers.filter(Boolean)).toHaveLength(1);
    });

    it("counts both replicas' hits in one window", async () => {
      const prefix = `it:${randomUUID()}:`;
      const one = open(prefix);
      const two = open(prefix);

      await one.increment("hits", { ttlSeconds: 10 });
      const { value } = await two.increment("hits", { ttlSeconds: 10 });

      expect(value).toBe(2);
    });

    it("confirms the connection on authenticate, as warm-up calls it", async () => {
      await expect(open().authenticate()).resolves.toBeUndefined();
    });
  });

  describe("in the health probe", () => {
    const database = () => new HealthProbe({ dataSource: "memory" });

    it("reports a server that answers as up", async () => {
      const cache = open();
      const probe = new CacheHealthProbe(database(), { connection: { authenticate: () => cache.ping() } });

      await expect(probe.report()).resolves.toMatchObject({ ready: true, cache: "up" });
    });

    it("reports a server that is not there as down, within the timeout", async () => {
      // Nothing listens on port 1. The client keeps trying to reconnect on its
      // own, so without the probe's timeout this answer would never come.
      const cache = new RedisCache({ url: "redis://localhost:1" }, logger);
      const probe = new CacheHealthProbe(database(), {
        connection: { authenticate: () => cache.ping() },
        timeoutMs: 200,
      });

      try {
        await expect(probe.report()).resolves.toMatchObject({ ready: true, cache: "down" });
      } finally {
        await cache.close().catch(() => undefined);
      }
    });
  });
});
