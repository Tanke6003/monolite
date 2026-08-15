/** State of the process as a load balancer or an orchestrator sees it. */
export interface HealthReport {
  /** `true` if this instance can serve traffic right now. */
  ready: boolean;
  /** The active engine, exactly as `DATA_SOURCE` resolved it. */
  dataSource: string;
  /** `not_applicable` for in-memory, where there is no connection to check. */
  database: "up" | "down" | "not_applicable";
  /** `true` while the process is draining after receiving SIGTERM. */
  shuttingDown: boolean;
}

/**
 * Health probe.
 *
 * It separates the two questions an orchestrator asks, which do not mean the
 * same thing: whether the process is alive —and therefore does not need a
 * restart— and whether it can take traffic. A process whose database is down is
 * alive but not ready; restarting it would fix nothing, taking traffic away
 * from it would.
 */
export interface IHealthProbe {
  /** Checks the dependency and returns the full state. */
  report(): Promise<HealthReport>;
  /** Marks that shutdown began: from here on the instance is never ready. */
  beginShutdown(): void;
}
