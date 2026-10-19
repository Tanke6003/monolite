import type { HealthReport } from "../contracts/health.js";

/** The only thing a probe needs from a connection: to ask whether it answers. */
export interface IConnectionCheck {
  authenticate(): Promise<void>;
}

/** What a probe says about one dependency. */
export type DependencyState = HealthReport["database"];

export interface CheckTuning {
  /**
   * How long a result stays valid before asking again. A load balancer probes
   * every few seconds and, across several replicas, that is real load against
   * the dependency; the cache turns it into a steady trickle that no longer
   * scales with traffic.
   */
  ttlMs?: number;
  /**
   * Upper bound on the check. Without it, a server that accepts the connection
   * but never answers leaves the check hanging, and the orchestrator ends up
   * deciding on its own timeout, far later than it should have.
   */
  timeoutMs?: number;
}

const DEFAULT_TTL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * One dependency's answer, with a short cache and a bounded wait.
 *
 * It never throws: a failure to check *is* the answer —the dependency is not
 * there— rather than an error to propagate.
 */
export class CachedCheck {
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private cached?: { at: number; state: DependencyState };

  /** `what` names the dependency in the timeout's message. */
  constructor(
    private readonly connection: IConnectionCheck | undefined,
    private readonly what: string,
    tuning: CheckTuning = {}
  ) {
    this.ttlMs = tuning.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = tuning.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async state(): Promise<DependencyState> {
    if (!this.connection) return "not_applicable";

    const now = Date.now();
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.state;

    const state = (await this.withTimeout(this.connection)) ? "up" : "down";
    this.cached = { at: now, state };
    return state;
  }

  /** Drops the cached answer, so the next `state()` asks again. */
  forget(): void {
    this.cached = undefined;
  }

  private async withTimeout(connection: IConnectionCheck): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        connection.authenticate(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`[HealthProbe] ${this.what} did not answer within ${this.timeoutMs} ms`)),
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
