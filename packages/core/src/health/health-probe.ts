import type { HealthReport, IHealthProbe } from "../contracts/health.js";

/** The only thing the probe needs from a connection: to ask whether it answers. */
export interface IConnectionCheck {
  authenticate(): Promise<void>;
}

export interface HealthProbeOptions {
  /**
   * Absent for in-memory, where there is nothing to open and nothing to check.
   * The instance is then ready as long as it is not shutting down.
   */
  connection?: IConnectionCheck;
  dataSource: string;
  /**
   * How long a result stays valid before asking again. A load balancer probes
   * every few seconds and, across several replicas, that is real load against
   * the database; the cache turns it into a steady trickle that no longer scales
   * with traffic.
   */
  ttlMs?: number;
  /**
   * Upper bound on the probe. Without it, a database that accepts the connection
   * but never answers leaves the check hanging, and the orchestrator ends up
   * deciding on its own timeout, far later than it should have.
   */
  timeoutMs?: number;
}

const DEFAULT_TTL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Health probe with a short cache and a bounded wait.
 *
 * It never throws: a failure to check *is* the answer —the database is not
 * there— rather than an error to propagate.
 */
export class HealthProbe implements IHealthProbe {
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private shuttingDown = false;
  private cached?: { at: number; database: HealthReport["database"] };

  constructor(private readonly options: HealthProbeOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    // The cached answer would still say everything is fine; draining has to be
    // visible on the very next probe, not once the cache happens to expire.
    this.cached = undefined;
  }

  async report(): Promise<HealthReport> {
    const database = await this.checkDatabase();

    return {
      ready: !this.shuttingDown && database !== "down",
      dataSource: this.options.dataSource,
      database,
      shuttingDown: this.shuttingDown,
    };
  }

  private async checkDatabase(): Promise<HealthReport["database"]> {
    if (!this.options.connection) return "not_applicable";

    const now = Date.now();
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.database;

    const database = (await this.withTimeout()) ? "up" : "down";
    this.cached = { at: now, database };
    return database;
  }

  private async withTimeout(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        this.options.connection!.authenticate(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`[HealthProbe] the database did not answer within ${this.timeoutMs} ms`)),
            this.timeoutMs
          );
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      // Without this, the losing timer keeps the event loop alive and delays the
      // exit of the process exactly when it is trying to shut down.
      if (timer) clearTimeout(timer);
    }
  }
}
