/**
 * The limiters on a shared `ICache`.
 *
 * Two Express apps over one `MemoryCache` stand in for two replicas over one
 * Redis: what matters is that both count into the same place, and the cache
 * contract is what says Redis keeps the counts the way the memory one does.
 */
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { MemoryCache, type ICache } from "monolite-core";
import {
  buildAuthRateLimiter,
  buildRateLimiter,
  CacheRateLimitStore,
  type EnvSource,
} from "monolite-http";
import { serve, type ServedApp } from "../support/http-client";

const envsOf = (values: Record<string, string> = {}): EnvSource => ({
  getEnv: (key: string) => values[key] ?? "",
});

/** An app with the given limiters in front of a login that always answers 200. */
function replica(limiters: (RequestHandler | null)[]) {
  const app = express();
  for (const limiter of limiters) if (limiter) app.use(limiter);
  app.post("/login", (_req, res) => {
    res.json({ ok: true });
  });
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status((err as { statusCode?: number }).statusCode ?? 500).json({ message: String(err) });
  };
  app.use(onError);
  return app;
}

describe("the rate limiters on a shared cache", () => {
  const served: ServedApp[] = [];
  const up = async (app: express.Application) => {
    const one = await serve(app);
    served.push(one);
    return one;
  };

  afterEach(async () => {
    await Promise.all(served.splice(0).map((one) => one.close()));
  });

  const envs = envsOf({ AUTH_RATE_LIMIT_MAX: "5" });

  it("counts one limit across two replicas: the sixth attempt is refused wherever it lands", async () => {
    const cache = new MemoryCache();
    const one = await up(replica([buildAuthRateLimiter(envs, { cache })]));
    const two = await up(replica([buildAuthRateLimiter(envs, { cache })]));

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const target = attempt % 2 ? two : one;
      statuses.push((await target.client.post("/login")).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("is two limits without it, which is the bug a shared cache closes", async () => {
    const one = await up(replica([buildAuthRateLimiter(envs)]));
    const two = await up(replica([buildAuthRateLimiter(envs)]));

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      statuses.push((await (attempt % 2 ? two : one).client.post("/login")).status);
    }

    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it("keeps the general and the auth limiter apart on one cache", async () => {
    // `/auth/login` goes through both. One store shared between them would be
    // refused by the library, and one key would count every hit twice.
    const cache = new MemoryCache();
    const app = await up(
      replica([
        buildRateLimiter(envsOf({ RATE_LIMIT_MAX: "100" }), { cache }),
        buildAuthRateLimiter(envsOf({ AUTH_RATE_LIMIT_MAX: "2" }), { cache }),
      ])
    );

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt++) statuses.push((await app.client.post("/login")).status);

    expect(statuses).toEqual([200, 200, 429]);
  });

  describe("when the cache cannot be reached", () => {
    const down: ICache = {
      get: () => Promise.reject(new Error("connection refused")),
      set: () => Promise.reject(new Error("connection refused")),
      delete: () => Promise.reject(new Error("connection refused")),
      deletePrefix: () => Promise.reject(new Error("connection refused")),
      add: () => Promise.reject(new Error("connection refused")),
      increment: () => Promise.reject(new Error("connection refused")),
    };

    it("lets traffic through the general limiter, so an outage of the cache is not one of the API", async () => {
      // The library says so on the console; that is the line an operator sees.
      const said = jest.spyOn(console, "error").mockImplementation(() => undefined);
      const app = await up(replica([buildRateLimiter(envsOf(), { cache: down })]));

      expect((await app.client.post("/login")).status).toBe(200);
      expect(said).toHaveBeenCalledWith(expect.stringContaining("allowing request"), expect.anything());
      said.mockRestore();
    });

    it("fails a login instead, because a login nobody counts can be guessed at full speed", async () => {
      const app = await up(replica([buildAuthRateLimiter(envsOf(), { cache: down })]));

      expect((await app.client.post("/login")).status).toBe(500);
    });
  });
});

describe("CacheRateLimitStore", () => {
  it("counts under its prefix, in a window as long as the limiter's", async () => {
    const cache = new MemoryCache();
    const store = new CacheRateLimitStore(cache, "rate-limit:test:");
    store.init({ windowMs: 60_000 } as never);

    const before = Date.now();
    const first = await store.increment("10.0.0.1");
    await store.increment("10.0.0.1");

    expect(first.totalHits).toBe(1);
    expect(first.resetTime!.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(await cache.get("rate-limit:test:10.0.0.1")).toBe(2);

    await store.decrement("10.0.0.1");
    expect(await cache.get("rate-limit:test:10.0.0.1")).toBe(1);

    await store.resetKey("10.0.0.1");
    expect(await cache.get("rate-limit:test:10.0.0.1")).toBeNull();
  });
});
