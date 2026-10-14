/**
 * A key-value store with expiry, shared by whatever can reach it.
 *
 * It is the seam three things inside the toolkit were missing: a rate limit
 * that holds across replicas, a token denylist every instance can see, and a
 * lock that two hosts agree on. None of those is a database — serving them from
 * the SQL store turns a sub-millisecond read into a query and makes the rate
 * limiter write to the primary on every request — and none of them can use a
 * client the application invented, because they live inside the packages.
 *
 * The interface is deliberately this small. Six operations cover a cache, a
 * counter, a lock and a denylist; a store that does far more (streams, pub/sub,
 * sorted sets) is better used through its own client than pretended into this.
 *
 * Values travel as JSON in every implementation, the in-memory one included, so
 * what comes back is what a shared store would return: a `Date` comes back as
 * its ISO string, everywhere. A test that passes on memory says something about
 * production only if memory does not keep objects a real store could not.
 *
 * `ttlSeconds` may be fractional; it must be positive. Without it a key lives
 * until it is deleted.
 */
export interface ICache {
  /** The value, or `null` when the key is absent or has expired. */
  get<T>(key: string): Promise<T | null>;
  /** Stores the value, replacing whatever was there and its expiry. */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  /** Removes the key. Removing one that is not there is not an error. */
  delete(key: string): Promise<void>;
  /** Removes every key that starts with `prefix` — `"settings:"` after a write. */
  deletePrefix(prefix: string): Promise<void>;
  /**
   * Stores the value only if the key is absent, and says whether it did.
   *
   * The primitive a lock and a denylist are built on: of two callers racing
   * for the same key, exactly one gets `true`.
   */
  add<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean>;
  /**
   * Adds `by` (default 1) to a counter, atomically, and returns the result.
   *
   * The expiry is set only when this call creates the key, so a counter
   * counts within a fixed window rather than one every hit pushes back — which
   * is what a rate limit is. `expiresAt` is when the window closes, or `null`
   * for a counter with no expiry.
   */
  increment(key: string, options?: IncrementOptions): Promise<CounterValue>;
}

export interface IncrementOptions {
  /** How much to add. Negative to take away. Defaults to 1. */
  by?: number;
  /** Expiry of the counter, applied only when this call creates it. */
  ttlSeconds?: number;
}

export interface CounterValue {
  value: number;
  expiresAt: Date | null;
}
