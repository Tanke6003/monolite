/**
 * `@monolite/core` — the kernel every other package builds on.
 *
 * It carries the vocabulary the whole toolkit shares: the error type services
 * throw, the mapper that turns anything thrown into an HTTP-shaped answer, the
 * contracts for logging, request context and health, and the two plain
 * implementations that need nothing but Node. It stays free of Express, of any
 * database driver and of any DI container on purpose — every package may depend
 * on the kernel, so anything the kernel depends on becomes mandatory for all of
 * them.
 */

// ---------------------------------------------------------------  errors  ---
export { AppError } from "./errors/app-error.js";
export type { AppErrorOptions, ErrorDetail } from "./errors/app-error.js";

export { causeChain, normalizeError } from "./errors/error-mapper.js";
export type { NormalizedError } from "./errors/error-mapper.js";

// ------------------------------------------------------------  contracts  ---
export type { ILogger } from "./contracts/logger.js";

export type {
  CurrentUser,
  IRequestContext,
  RequestContextData,
} from "./contracts/request-context.js";

export type { HealthReport, IHealthProbe } from "./contracts/health.js";

// -------------------------------------------------------  implementations  ---
export { AsyncRequestContext, SYSTEM_USER } from "./context/async-request-context.js";

export { HealthProbe } from "./health/health-probe.js";
export type { HealthProbeOptions, IConnectionCheck } from "./health/health-probe.js";
