import type { HealthReport, IHealthProbe } from "../contracts/health.js";
import { CachedCheck } from "./connection-check.js";
import type { CheckTuning, IConnectionCheck } from "./connection-check.js";

export interface HealthProbeOptions extends CheckTuning {
  /**
   * Absent for in-memory, where there is nothing to open and nothing to check.
   * The instance is then ready as long as it is not shutting down.
   */
  connection?: IConnectionCheck;
  dataSource: string;
}

/**
 * Health probe with a short cache and a bounded wait.
 *
 * It never throws: a failure to check *is* the answer —the database is not
 * there— rather than an error to propagate.
 */
export class HealthProbe implements IHealthProbe {
  private readonly database: CachedCheck;
  private shuttingDown = false;

  constructor(private readonly options: HealthProbeOptions) {
    this.database = new CachedCheck(options.connection, "the database", options);
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    // The cached answer would still say everything is fine; draining has to be
    // visible on the very next probe, not once the cache happens to expire.
    this.database.forget();
  }

  async report(): Promise<HealthReport> {
    const database = await this.database.state();

    return {
      ready: !this.shuttingDown && database !== "down",
      dataSource: this.options.dataSource,
      database,
      shuttingDown: this.shuttingDown,
    };
  }
}
