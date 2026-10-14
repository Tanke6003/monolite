import type { IncrementResponse, Options, Store } from "express-rate-limit";
import type { ICache } from "monolite-core";

/**
 * `express-rate-limit`'s counter, kept in an `ICache`.
 *
 * The library's default store is a `Map` in the process, so behind two
 * replicas a limit is two limits: `AUTH_RATE_LIMIT_MAX=5` lets ten attempts
 * through, and a rolling restart resets the count for everybody. On a shared
 * cache the count is one, wherever the request lands.
 *
 * Each hit is one `increment`, which is atomic in every `ICache` and opens the
 * window on the first hit of it — a fixed window, as the library's own store
 * counts. `localKeys` stays false, which is what tells the library the counts
 * are shared; the `prefix` keeps two limiters on one cache from counting into
 * each other, and is also what the library uses to tell two stores apart.
 */
export class CacheRateLimitStore implements Store {
  readonly localKeys = false;
  private windowMs = 60_000;

  constructor(
    private readonly cache: ICache,
    readonly prefix: string
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const { value, expiresAt } = await this.cache.increment(this.prefix + key, {
      ttlSeconds: this.windowMs / 1000,
    });
    return { totalHits: value, resetTime: expiresAt ?? undefined };
  }

  /**
   * Only for `skipSuccessfulRequests`/`skipFailedRequests`, which hand a hit
   * back. With the window's expiry, so a counter this happens to create does
   * not outlive it.
   */
  async decrement(key: string): Promise<void> {
    await this.cache.increment(this.prefix + key, { by: -1, ttlSeconds: this.windowMs / 1000 });
  }

  async resetKey(key: string): Promise<void> {
    await this.cache.delete(this.prefix + key);
  }
}
