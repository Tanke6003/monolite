import { Router, type Request, type Response } from "express";
import type { HealthReport, IHealthProbe } from "monolite-core";

export interface HealthRoutesOptions {
  /**
   * The probe that answers readiness. Optional: liveness needs nothing, and an
   * application with no data source has nothing to check.
   */
  probe?: IHealthProbe;
  /**
   * Where the API is mounted, published in the readiness payload. `API_PREFIX`
   * is configurable, so a client discovers it here instead of assuming it, and
   * it also shows at a glance what this instance is serving.
   */
  apiPrefix?: string;
}

/**
 * The health routes, as a router meant to be mounted at `/health`.
 *
 * Health is two different questions and they are answered separately, because
 * an orchestrator does opposite things with each: if the process is not *alive*
 * it restarts it, and if it is not *ready* it takes traffic away. With the
 * database down the right answer is the second one: restarting does not fix
 * someone else's database, and taking traffic away sends the requests to a
 * replica that can actually serve them.
 *
 * Mounted at `/health` this yields `/health/live`, `/health/ready` and
 * `/health` itself — the last one an alias for readiness, which is what a load
 * balancer configured with the bare path expects.
 */
export function healthRoutes(options: HealthRoutesOptions = {}): Router {
  const { probe, apiPrefix } = options;
  const router = Router();

  const describe = (report: HealthReport) => ({
    status: report.ready ? "ok" : report.shuttingDown ? "shutting_down" : "degraded",
    // Useful for knowing which driver the instance is actually running against.
    dataSource: report.dataSource,
    database: report.database,
    ...(apiPrefix ? { apiPrefix } : {}),
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });

  /** Liveness: it only says the process answers. It never touches the database. */
  router.get("/live", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    });
  });

  if (probe) {
    /** Readiness: 503 with the database down or while draining. */
    const readiness = async (_req: Request, res: Response): Promise<void> => {
      const report = await probe.report();
      res.status(report.ready ? 200 : 503).json(describe(report));
    };

    router.get("/ready", readiness);
    router.get("/", readiness);
  }

  return router;
}
