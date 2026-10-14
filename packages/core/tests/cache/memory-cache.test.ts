import { MemoryCache } from "../../src/cache/memory-cache.js";

// What every `ICache` must do is in the contract kit, run against this one in
// `packages/data/tests/contract/memory-cache.contract.test.ts`. What is here is
// what only a cache in the process has to worry about.

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const sizeOf = (cache: MemoryCache): number =>
  (cache as unknown as { entries: Map<string, unknown> }).entries.size;

describe("MemoryCache", () => {
  it("expires by its own clock", async () => {
    const time = clock();
    const cache = new MemoryCache({ now: time.now });

    await cache.set("key", "value", 10);
    time.advance(9_999);
    expect(await cache.get("key")).toBe("value");

    time.advance(1);
    expect(await cache.get("key")).toBeNull();
  });

  it("sweeps out expired keys nobody reads again, so a limiter keyed by address does not keep every address", async () => {
    const time = clock();
    const cache = new MemoryCache({ now: time.now });

    for (let i = 0; i < 100; i++) await cache.increment(`rate:10.0.0.${i}`, { ttlSeconds: 60 });
    expect(sizeOf(cache)).toBe(100);

    // A minute later, past their window and past the sweep interval: the next
    // write takes them out, without a timer keeping the process alive.
    time.advance(61_000);
    await cache.set("unrelated", 1);

    expect(sizeOf(cache)).toBe(1);
  });

  it("does not hold on to the object it was given", async () => {
    const cache = new MemoryCache();
    const value = { roles: ["read"] };

    await cache.set("user", value);
    value.roles.push("write");

    // A shared store keeps a copy; so does this one, or a test would pass here
    // that fails against Redis.
    expect(await cache.get("user")).toEqual({ roles: ["read"] });
  });
});
