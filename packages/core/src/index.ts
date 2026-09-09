/**
 * `monolite-core` — the kernel every other package builds on.
 *
 * It carries the vocabulary the whole toolkit shares: the error type services
 * throw, the mapper that turns anything thrown into an HTTP-shaped answer, the
 * contracts for logging, request context and health, the fixed-scale decimal
 * arithmetic an application handling amounts would otherwise write for itself,
 * and the two plain implementations that need nothing but Node. It stays free
 * of Express, of any database driver and of any DI container on purpose — every
 * package may depend on the kernel, so anything the kernel depends on becomes
 * mandatory for all of them.
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

// --------------------------------------------------------------  decimal  ---
// Arithmetic on a number with a fixed number of decimals — the same thing
// `kind: "decimal"` describes in `monolite-data`, under the same name, since a
// toolkit that calls one idea two things teaches nobody either of them.
//
// Arithmetic rather than persistence, which is why it is here and not there: an
// application that never stores an amount can still need to split one, and the
// kernel is the only package all of them already depend on. Money is the case
// that motivates it and not the limit of it: hours, units and days divide the
// same way and lose the same remainder.
export { roundTo } from "./decimal/rounding.js";
export { allocate } from "./decimal/allocate.js";
export type { AllocateOptions, ResidueRule } from "./decimal/allocate.js";

// -------------------------------------------------------  implementations  ---
export { AsyncRequestContext, SYSTEM_USER } from "./context/async-request-context.js";

export { HealthProbe } from "./health/health-probe.js";
export type { HealthProbeOptions, IConnectionCheck } from "./health/health-probe.js";
