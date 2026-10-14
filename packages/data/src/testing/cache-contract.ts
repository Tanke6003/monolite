// Contract suite for `ICache`.
//
// The same assertions for every implementation — the in-memory one in
// `monolite-core`, `RedisCache` here, and any a consumer writes — in the shape
// of the repository contract next to it. What it holds them to is the promise
// that makes the in-memory cache worth testing against: that a module behaves
// the same once it is pointed at a shared store.
//
// Expiry is checked with real time, in fractions of a second, because a
// shared store keeps its own clock and a fake one cannot reach it.
//
// It expects the Jest globals (`describe`, `it`, `expect`, `beforeEach`,
// `afterAll`) to be in scope.
import type { ICache } from "monolite-core";

export interface CacheContractSetup {
  /** An empty cache for each test, sharing no keys with any other. */
  create(): Promise<ICache> | ICache;
  /** Runs at the end, in case the implementation has something to close. */
  teardown?(): Promise<void> | void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Short enough to keep the suite quick, long enough to outlast a round trip. */
const TTL_SECONDS = 0.3;
const PAST_TTL_MS = 450;

export function runCacheContract(implementation: string, setup: CacheContractSetup): void {
  describe(`ICache contract — ${implementation}`, () => {
    let cache: ICache;

    beforeEach(async () => {
      cache = await setup.create();
    });

    afterAll(async () => {
      await setup.teardown?.();
    });

    describe("get and set", () => {
      it("answers null for a key that was never set", async () => {
        expect(await cache.get("missing")).toBeNull();
      });

      it("returns what was stored, as JSON returns it", async () => {
        await cache.set("object", { name: "ana", roles: ["admin"], active: true, n: 1.5 });
        await cache.set("number", 42);
        await cache.set("text", "hello");

        expect(await cache.get("object")).toEqual({
          name: "ana",
          roles: ["admin"],
          active: true,
          n: 1.5,
        });
        expect(await cache.get("number")).toBe(42);
        expect(await cache.get("text")).toBe("hello");
      });

      it("hands a Date back as its ISO string, on every implementation", async () => {
        await cache.set("when", { at: new Date("2026-04-30T12:00:00.000Z") });

        expect(await cache.get("when")).toEqual({ at: "2026-04-30T12:00:00.000Z" });
      });

      it("replaces the value and the expiry of a key that existed", async () => {
        await cache.set("key", "first", TTL_SECONDS);
        await cache.set("key", "second");
        await sleep(PAST_TTL_MS);

        expect(await cache.get("key")).toBe("second");
      });

      it("forgets a key once its time is up", async () => {
        await cache.set("key", "value", TTL_SECONDS);
        expect(await cache.get("key")).toBe("value");

        await sleep(PAST_TTL_MS);
        expect(await cache.get("key")).toBeNull();
      });

      it("refuses an expiry that is not a positive number, and a value JSON cannot hold", async () => {
        await expect(cache.set("key", "value", 0)).rejects.toThrow(TypeError);
        await expect(cache.set("key", "value", -1)).rejects.toThrow(TypeError);
        await expect(cache.set("key", undefined)).rejects.toThrow(TypeError);
      });
    });

    describe("delete and deletePrefix", () => {
      it("deletes a key, and deleting one that is not there is not an error", async () => {
        await cache.set("key", 1);
        await cache.delete("key");
        await cache.delete("never-there");

        expect(await cache.get("key")).toBeNull();
      });

      it("removes a prefix and leaves its neighbours alone", async () => {
        await cache.set("settings:theme", "dark");
        await cache.set("settings:lang", "es");
        await cache.set("settingsx:other", 1);
        await cache.set("permissions:7", ["read"]);

        await cache.deletePrefix("settings:");

        expect(await cache.get("settings:theme")).toBeNull();
        expect(await cache.get("settings:lang")).toBeNull();
        expect(await cache.get("settingsx:other")).toBe(1);
        expect(await cache.get("permissions:7")).toEqual(["read"]);
      });

      it("treats a prefix literally, glob characters included", async () => {
        await cache.set("a*:one", 1);
        await cache.set("ab:two", 2);

        await cache.deletePrefix("a*:");

        expect(await cache.get("a*:one")).toBeNull();
        expect(await cache.get("ab:two")).toBe(2);
      });
    });

    describe("add", () => {
      it("stores a key that is absent, and refuses one that exists without touching it", async () => {
        expect(await cache.add("lock", "first")).toBe(true);
        expect(await cache.add("lock", "second")).toBe(false);

        expect(await cache.get("lock")).toBe("first");
      });

      it("can take a key again once it has expired", async () => {
        expect(await cache.add("lock", 1, TTL_SECONDS)).toBe(true);
        await sleep(PAST_TTL_MS);

        expect(await cache.add("lock", 2)).toBe(true);
      });

      it("lets exactly one of many racing callers in, which is what a lock stands on", async () => {
        const answers = await Promise.all(
          Array.from({ length: 20 }, (_, i) => cache.add("lock", i, 10))
        );

        expect(answers.filter(Boolean)).toHaveLength(1);
      });
    });

    describe("increment", () => {
      it("starts a counter at what it adds, and keeps adding", async () => {
        expect((await cache.increment("hits")).value).toBe(1);
        expect((await cache.increment("hits")).value).toBe(2);
        expect((await cache.increment("hits", { by: 5 })).value).toBe(7);
        expect((await cache.increment("hits", { by: -3 })).value).toBe(4);

        expect(await cache.get("hits")).toBe(4);
      });

      it("counts every one of many concurrent hits", async () => {
        await Promise.all(Array.from({ length: 50 }, () => cache.increment("hits", { ttlSeconds: 10 })));

        expect(await cache.get("hits")).toBe(50);
      });

      it("opens a window on the first hit and does not move it on the next", async () => {
        const before = Date.now();
        const first = await cache.increment("hits", { ttlSeconds: 10 });
        const second = await cache.increment("hits", { ttlSeconds: 10 });

        expect(first.expiresAt).toBeInstanceOf(Date);
        const opened = first.expiresAt!.getTime();
        expect(opened).toBeGreaterThanOrEqual(before + 9_000);
        expect(opened).toBeLessThanOrEqual(Date.now() + 10_100);
        // The same window, give or take the round trip.
        expect(Math.abs(second.expiresAt!.getTime() - opened)).toBeLessThan(250);
      });

      it("starts again once the window has closed", async () => {
        await cache.increment("hits", { ttlSeconds: TTL_SECONDS });
        await cache.increment("hits", { ttlSeconds: TTL_SECONDS });
        await sleep(PAST_TTL_MS);

        expect((await cache.increment("hits", { ttlSeconds: TTL_SECONDS })).value).toBe(1);
      });

      it("has no expiry when none was asked for", async () => {
        expect((await cache.increment("hits")).expiresAt).toBeNull();
      });

      it("refuses to count on a key that holds something else, or by a fraction", async () => {
        await cache.set("name", "ana");

        await expect(cache.increment("name")).rejects.toThrow();
        await expect(cache.increment("hits", { by: 0.5 })).rejects.toThrow(TypeError);
      });
    });
  });
}
