import type { HealthReport, IHealthProbe } from "../contracts/health.js";
import { CachedCheck } from "./connection-check.js";
import type { CheckTuning, IConnectionCheck } from "./connection-check.js";

export interface CacheHealthOptions extends CheckTuning {
  /**
   * Absent for the in-memory cache, which lives in the process and cannot be
   * unreachable: `cache` then reports `not_applicable`.
   */
  connection?: IConnectionCheck;
  /**
   * Whether a cache that is down takes the instance out of rotation. Off by
   * default — see the class.
   */
  required?: boolean;
}

/**
 * The database probe, with the shared cache reported next to it.
 *
 * A cache that is down is reported and, by default, does not make the instance
 * not ready. Every replica talks to the same server, so a Redis outage is the
 * same outage on all of them: taking them all out of rotation turns a cache
 * outage into a full one — the routes that never touch the cache stop working
 * too — and moves traffic nowhere better. `required: true` is for an
 * application where nothing useful works without it.
 */
export class CacheHealthProbe implements IHealthProbe {
  private readonly cache: CachedCheck;

  constructor(
    private readonly inner: IHealthProbe,
    private readonly options: CacheHealthOptions = {}
  ) {
    this.cache = new CachedCheck(options.connection, "the cache", options);
  }

  beginShutdown(): void {
    this.inner.beginShutdown();
    this.cache.forget();
  }

  async report(): Promise<HealthReport> {
    // In parallel: each check is bounded by its own timeout, and in sequence a
    // slow database and a slow cache would add theirs up.
    const [report, cache] = await Promise.all([this.inner.report(), this.cache.state()]);

    return {
      ...report,
      ready: report.ready && !(this.options.required && cache === "down"),
      cache,
    };
  }
}
