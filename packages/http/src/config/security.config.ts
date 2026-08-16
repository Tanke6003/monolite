// Hardening of the HTTP layer, in one place and driven by environment
// variables: headers (helmet), request throttling, CORS by allow-list, maximum
// body size and whether the documentation is published.
//
// It lives here and not in the server because these are configuration
// decisions, not wiring: the server only mounts what this module decides, and a
// policy can be tested without standing up the whole of Express.
import type { CorsOptions } from "cors";
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { HelmetOptions } from "helmet";
import { AppError, type ILogger } from "monolite-core";
import { REQUEST_ID_HEADER } from "../middlewares/request-context.js";
import type { EnvSource } from "./env-source.js";

/**
 * Defaults. They are chosen so the toolkit starts up secure with no variable
 * defined at all: whoever deploys raises what they need, rather than lowering
 * what they forgot.
 */
export const SECURITY_DEFAULTS = {
  /**
   * 1 MB is Express's own default and it is plenty: JSON bodies in a typical
   * API stay well under a kilobyte, and file uploads do not go through this
   * parser anyway — a streaming multipart reader consumes the raw stream. A
   * high limit would only let a client make the parser pile up megabytes in
   * memory before anything got rejected.
   */
  bodyLimit: "1mb",
  /** Window and quota of the general limiter. */
  windowMs: 60_000,
  limit: 120,
  /** Window and quota of the routes that hand out credentials. Far narrower. */
  authWindowMs: 15 * 60_000,
  authLimit: 10,
} as const;

/**
 * A configuration integer with its lowest acceptable value. An empty value, or
 * one out of range, falls back to the default instead of propagating a NaN.
 */
function toInt(raw: string, fallback: number, min = 1): number {
  // `Number("")` is 0, so without this cut an undefined variable would read as
  // a zero somebody set on purpose.
  if (raw.trim() === "") return fallback;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

/** Reads a three-state variable: `true`, `false` or "whatever the caller decides". */
function readFlag(envs: EnvSource, key: string): boolean | undefined {
  const value = envs.getEnv(key).trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function isProduction(envs: EnvSource): boolean {
  return (envs.getEnv("NODE_ENV") || "development").toLowerCase() === "production";
}

// ------------------------------------------------------------------ body ----

export function resolveBodyLimit(envs: EnvSource): string {
  return envs.getEnv("BODY_LIMIT").trim() || SECURITY_DEFAULTS.bodyLimit;
}

// ----------------------------------------------------------------- proxy ----

/**
 * How many trusted proxies sit in front (0 = none, 1 = an nginx or a load
 * balancer).
 *
 * It is a number and never `true`, deliberately: with `true` Express believes
 * any `X-Forwarded-For`, and then the limiter counts against an IP the client
 * itself picks, so varying it is enough to walk straight past the quota. With a
 * number, only as many hops as really exist are read.
 */
export function resolveTrustProxy(envs: EnvSource): number {
  return toInt(envs.getEnv("TRUST_PROXY_HOPS"), 0, 0);
}

// ------------------------------------------------------------------ CORS ----

/** Drops the trailing slash and normalises case: `https://App.com/` and `https://app.com` are the same origin. */
function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Allow-list of origins, read from `CORS_ORIGINS` as comma-separated values.
 * It returns an array, so it takes as many as needed: the production domain
 * and, at the same time, the `localhost` the front end is being debugged from
 * against that very server.
 *
 * `*` is an explicit wildcard: if it appears in the list any origin is
 * accepted. Useful in development; in production it is exactly what you do not
 * want.
 */
export function resolveAllowedOrigins(envs: EnvSource): string[] {
  const configured = envs
    .getEnv("CORS_ORIGINS")
    .split(",")
    .map(normalizeOrigin)
    .filter((origin) => origin.length > 0);

  return [...new Set(configured)];
}

/**
 * CORS policy.
 *
 * A request without an `Origin` header is always accepted: it is not a
 * cross-origin browser request but curl, Postman, a local Swagger UI or the
 * load balancer's probe. CORS does not protect against those, and rejecting
 * them would only break the tooling.
 *
 * The rejection is delegated to the global error handler — the same way the
 * auth guard does it — so a disallowed origin answers with the same error shape
 * as the rest of the API, with its code and its request id.
 */
export function buildCorsOptions(envs: EnvSource, logger?: ILogger): CorsOptions {
  const allowed = resolveAllowedOrigins(envs);
  const allowAny = allowed.includes("*");

  return {
    origin(origin, callback) {
      if (!origin || allowAny || allowed.includes(normalizeOrigin(origin))) {
        callback(null, true);
        return;
      }

      // It is logged because the symptom in the browser — "blocked by CORS" —
      // does not say which origin arrived, and it is almost always a trailing
      // slash or a port.
      logger?.warn("Origin blocked by CORS", { origin, allowed });
      callback(
        new AppError(`Origin not allowed: ${origin}`, 403, true, {
          code: "CORS_ORIGIN_NOT_ALLOWED",
        })
      );
    },
    credentials: true,
    // So the front end can read the request id and show it on an error: without
    // exposing it, the browser hides the header from JavaScript.
    exposedHeaders: [REQUEST_ID_HEADER],
  };
}

// ------------------------------------------------------------ rate limit ----

interface LimiterSpec {
  windowKey: string;
  limitKey: string;
  windowFallback: number;
  limitFallback: number;
  message: string;
}

/**
 * Builds a limiter, or `null` if its quota is set to 0 (disabled).
 *
 * The rejection also travels through `next(AppError)`, so a 429 comes out with
 * `code`, `requestId` and `timestamp` like any other error. The `RateLimit-*`
 * headers are added by the library itself.
 */
function buildLimiter(envs: EnvSource, spec: LimiterSpec): RateLimitRequestHandler | null {
  const limit = toInt(envs.getEnv(spec.limitKey), spec.limitFallback, 0);
  if (limit === 0) return null;

  return rateLimit({
    windowMs: toInt(envs.getEnv(spec.windowKey), spec.windowFallback, 1000),
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError(spec.message, 429, true, { code: "RATE_LIMITED" }));
    },
  });
}

/**
 * General per-IP limiter. It leaves the health checks out: a load balancer
 * probes every few seconds and would exhaust the quota of its own IP, so the
 * instance would end up marked as down for being healthy.
 */
export function buildRateLimiter(envs: EnvSource): RateLimitRequestHandler | null {
  const limiter = buildLimiter(envs, {
    windowKey: "RATE_LIMIT_WINDOW_MS",
    limitKey: "RATE_LIMIT_MAX",
    windowFallback: SECURITY_DEFAULTS.windowMs,
    limitFallback: SECURITY_DEFAULTS.limit,
    message: "Too many requests. Try again in a moment.",
  });

  if (!limiter) return null;

  return ((req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/health/")) {
      next();
      return;
    }
    limiter(req, res, next);
  }) as RateLimitRequestHandler;
}

/**
 * Limiter for the routes that hand out credentials. Far narrower than the
 * general one: a token is the only thing that opens the rest of the API, so it
 * is the first thing anyone will try to ask for in a loop.
 */
export function buildAuthRateLimiter(envs: EnvSource): RateLimitRequestHandler | null {
  return buildLimiter(envs, {
    windowKey: "AUTH_RATE_LIMIT_WINDOW_MS",
    limitKey: "AUTH_RATE_LIMIT_MAX",
    windowFallback: SECURITY_DEFAULTS.authWindowMs,
    limitFallback: SECURITY_DEFAULTS.authLimit,
    message: "Too many attempts. Try again later.",
  });
}

// ---------------------------------------------------------------- helmet ----

/**
 * Starting point for a Content-Security-Policy, kept as close to `'self'` as a
 * documented API can be.
 *
 * `style-src` allows `'unsafe-inline'` because Swagger UI injects its styles
 * inline and there is no way around it short of not serving Swagger. Everything
 * else is locked down, and any host the application actually needs — a CDN, an
 * analytics endpoint, an image bucket — is the application's to add: this
 * package cannot know them, and guessing would only widen the policy for
 * everyone.
 *
 * Pass your own directives to {@link buildHelmetOptions} to replace this set.
 */
export const DEFAULT_CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
  "font-src": ["'self'", "data:"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'self'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
};

/**
 * The CSP comes **switched off** unless `CSP_ENABLED=true` asks for it.
 *
 * This is not laziness: helmet's default CSP breaks Swagger UI (inline styles)
 * and Scalar (it loads its assets from an external CDN) at the same time, and
 * most starter front ends along with them. Turning it on by default would leave
 * a freshly cloned project with a couple of blank screens, which is the surest
 * way to get the next person to disable it wholesale instead of tuning it.
 *
 * In a real deployment, with the documentation off and your own front end, the
 * right order is `CSP_ENABLED=true` and then narrowing the directives.
 *
 * Helmet's other dozen headers — nosniff, frameguard, HSTS, referrer-policy… —
 * are always applied, with or without a CSP.
 */
export function buildHelmetOptions(
  envs: EnvSource,
  directives: Record<string, string[]> = DEFAULT_CSP_DIRECTIVES
): HelmetOptions {
  const enabled = readFlag(envs, "CSP_ENABLED") ?? false;

  return {
    contentSecurityPolicy: enabled ? { directives } : false,
  };
}

// --------------------------------------------------------- documentation ----

/**
 * Whether Swagger, Scalar and `openapi.json` are published. Off in production
 * by default; `DOCS_ENABLED` forces the value either way.
 *
 * The default is not about hiding the endpoints — anyone can find those — but
 * about the input schemas: the document describes the whole surface of the API,
 * validation rules included, and that is a map of exactly what to poke at.
 */
export function areDocsEnabled(envs: EnvSource): boolean {
  return readFlag(envs, "DOCS_ENABLED") ?? !isProduction(envs);
}
