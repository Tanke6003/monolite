import type { CounterValue, ICache, IncrementOptions } from "../contracts/cache.js";

/**
 * `ICache` in a `Map`: the default, so an application needs nothing new to run,
 * and what the generated test suite uses — the same trade the in-memory data
 * driver makes.
 *
 * It is per process, and that is the whole of its limitation: behind two
 * replicas each one has its own, so a rate limit counted here is one limit per
 * replica. `registerCache` with `CACHE_DRIVER=redis` is the answer to that, and
 * nothing that depends on `ICache` has to change for it.
 *
 * Values are stored as JSON, as a shared store would hold them, so that what
 * comes back here is what comes back from Redis — see `ICache`.
 */

interface Entry {
  json: string;
  /** Epoch milliseconds, or `null` for no expiry. */
  expiresAt: number | null;
}

export interface MemoryCacheOptions {
  /** The clock, in epoch milliseconds. A test that needs time to pass sets it. */
  now?: () => number;
}

/**
 * How often expired keys are swept out on a write. Reads already ignore them;
 * the sweep is what keeps a rate limiter keyed by client address from holding
 * every address it ever saw. A timer would do it too, and would keep the
 * process alive for no reason.
 */
const SWEEP_EVERY_MS = 60_000;

export function ttlToMs(ttlSeconds: number | undefined): number | null {
  if (ttlSeconds === undefined) return null;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError(`[cache] ttlSeconds must be a positive number; received ${ttlSeconds}.`);
  }
  return Math.max(1, Math.round(ttlSeconds * 1000));
}

export function toJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError(`[cache] the value must be serialisable to JSON; received ${String(value)}.`);
  }
  return json;
}

export class MemoryCache implements ICache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private nextSweep: number;

  constructor(options: MemoryCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.nextSweep = this.now() + SWEEP_EVERY_MS;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.live(key);
    return entry ? (JSON.parse(entry.json) as T) : null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.write(key, toJson(value), ttlToMs(ttlSeconds));
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  async add<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    const json = toJson(value);
    const ttl = ttlToMs(ttlSeconds);
    if (this.live(key)) return false;

    this.write(key, json, ttl);
    return true;
  }

  async increment(key: string, options: IncrementOptions = {}): Promise<CounterValue> {
    const by = options.by ?? 1;
    if (!Number.isInteger(by)) {
      throw new TypeError(`[cache] increment takes a whole number; received ${by}.`);
    }
    const ttl = ttlToMs(options.ttlSeconds);

    const entry = this.live(key);
    if (!entry) {
      this.write(key, String(by), ttl);
      return { value: by, expiresAt: ttl === null ? null : new Date(this.now() + ttl) };
    }

    const current = JSON.parse(entry.json) as unknown;
    if (!Number.isInteger(current)) {
      throw new TypeError(`[cache] "${key}" does not hold a counter.`);
    }
    const value = (current as number) + by;
    // The window is the one the first hit opened: the expiry stays as it was.
    entry.json = String(value);
    return { value, expiresAt: entry.expiresAt === null ? null : new Date(entry.expiresAt) };
  }

  /** The entry, unless it is absent or its time is up — in which case it goes. */
  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private write(key: string, json: string, ttlMs: number | null): void {
    const now = this.now();
    this.entries.set(key, { json, expiresAt: ttlMs === null ? null : now + ttlMs });

    if (now >= this.nextSweep) {
      this.nextSweep = now + SWEEP_EVERY_MS;
      for (const [candidate, entry] of this.entries) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) this.entries.delete(candidate);
      }
    }
  }
}
