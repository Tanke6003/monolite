import type { HealthReport, IHealthProbe, LayerHealth } from "../contracts/health.js";

/**
 * One probe over several, for an application with more than one persistence
 * layer.
 *
 * An orchestrator reads one answer, so the layers are summed up into the same
 * `HealthReport` a single probe gives — not ready if any layer's database is
 * down — and `layers` says which one it was. Without that, "degraded" over two
 * engines leaves the operator guessing which of them to look at.
 */
export class CompositeHealthProbe implements IHealthProbe {
  private shuttingDown = false;

  /** Keyed by layer name, in the order they should be reported. */
  constructor(private readonly probes: ReadonlyMap<string, IHealthProbe>) {}

  beginShutdown(): void {
    this.shuttingDown = true;
    for (const probe of this.probes.values()) probe.beginShutdown();
  }

  async report(): Promise<HealthReport> {
    const names = [...this.probes.keys()];
    // In parallel: each probe is already bounded by its own timeout, and in
    // sequence two slow engines would add theirs up.
    const reports = await Promise.all([...this.probes.values()].map((probe) => probe.report()));

    const layers: Record<string, LayerHealth> = {};
    reports.forEach((report, index) => {
      layers[names[index]!] = { dataSource: report.dataSource, database: report.database };
    });

    const states = reports.map((report) => report.database);
    const database: HealthReport["database"] = states.includes("down")
      ? "down"
      : states.includes("up")
        ? "up"
        : "not_applicable";

    return {
      ready: !this.shuttingDown && reports.every((report) => report.ready),
      dataSource: [...new Set(reports.map((report) => report.dataSource))].join(","),
      database,
      shuttingDown: this.shuttingDown,
      layers,
    };
  }
}
