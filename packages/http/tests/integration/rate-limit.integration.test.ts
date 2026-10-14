/**
 * The login limiter across two app instances on one Redis — the property the
 * shared cache exists for, checked against a real server: the sixth attempt is
 * refused by an instance that never saw the first five.
 *
 * Selected by `MONOLITE_IT_CACHES`, as the cache contract is; see
 * `packages/data/tests/integration/redis-cache.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import type { ILogger } from "monolite-core";
import { RedisCache } from "monolite-data";
import { buildAuthRateLimiter, errorHandler, type EnvSource } from "monolite-http";
import { serve, type ServedApp } from "../support/http-client";

const REDIS_URL = process.env.MONOLITE_IT_REDIS_URL ?? "redis://localhost:56379";
const asked = (process.env.MONOLITE_IT_CACHES ?? "redis").trim().toLowerCase();
const describeRedis = asked !== "none" && asked.split(",").includes("redis") ? describe : describe.skip;

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  log: () => undefined,
} as unknown as ILogger;

const envs: EnvSource = { getEnv: (key) => (key === "AUTH_RATE_LIMIT_MAX" ? "5" : "") };

describeRedis("the login limiter on Redis", () => {
  const caches: RedisCache[] = [];
  const served: ServedApp[] = [];

  afterAll(async () => {
    await Promise.all(served.map((one) => one.close()));
    for (const cache of caches) await cache.deletePrefix("");
    await Promise.all(caches.map((cache) => cache.close()));
  });

  /** One replica: its own connection to the server, the same key prefix. */
  async function replica(keyPrefix: string): Promise<ServedApp> {
    const cache = new RedisCache({ url: REDIS_URL, keyPrefix }, logger);
    caches.push(cache);

    const app = express();
    app.post("/auth/login", buildAuthRateLimiter(envs, { cache })!, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler({ logger }));

    const one = await serve(app);
    served.push(one);
    return one;
  }

  it("refuses the sixth attempt on whichever instance it lands", async () => {
    const prefix = `it:${randomUUID()}:`;
    const one = await replica(prefix);
    const two = await replica(prefix);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      statuses.push((await (attempt % 2 ? two : one).client.post("/auth/login")).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});
