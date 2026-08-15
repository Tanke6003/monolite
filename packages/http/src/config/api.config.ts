// Where the API is mounted. One place decides it and everything else asks:
// the router, the documentation and the health endpoint itself, which publishes
// it so a client can discover it instead of being told.
import type { EnvSource } from "./env-source.js";

/** Default prefix of the current version. */
export const DEFAULT_API_PREFIX = "/api/v1";

/**
 * Unversioned prefix pointing at the same thing. It exists so callers that were
 * already hitting `/api/...` do not break. Set `API_LEGACY_PREFIX=off` to turn
 * it off.
 */
export const DEFAULT_LEGACY_PREFIX = "/api";

/**
 * Normalises a mount prefix: leading slash, no trailing slash.
 *
 * Returns `null` for an empty string, which is how "do not mount this" is
 * spelled.
 */
function normalizePrefix(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "/") return null;

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

/**
 * Path where the current version of the API is mounted (`API_PREFIX`).
 *
 * **Be careful about what changing it means.** The prefix identifies the
 * contract, not the deployment: `/api/v1` promises a concrete request and
 * response shape, and what defines that shape is the controllers and their
 * DTOs. Pointing this at `/api/v2` does not create a version 2, it renames
 * version 1.
 *
 * The legitimate use is moving the API somewhere else — behind a proxy that
 * serves it at `/appointments-service/api/v1`, or living alongside another app
 * on the same domain.
 *
 * When a v2 really exists, both will have to answer at the same time, so they
 * will not come from here but from two mounts, each with its own router:
 *
 *     app.use("/api/v1", v1);
 *     app.use("/api/v2", v2);
 */
export function resolveApiPrefix(envs: EnvSource): string {
  return normalizePrefix(envs.getEnv("API_PREFIX")) ?? DEFAULT_API_PREFIX;
}

/**
 * Unversioned alias, or `null` if it must not be mounted.
 *
 * It is turned off with `API_LEGACY_PREFIX=off`, not by leaving it empty:
 * `EnvSource.getEnv` returns `""` both for a missing variable and for an empty
 * one, so "empty" cannot mean "turn it off" without deleting the variable from
 * the file turning it off by accident too.
 *
 * If it matched the main prefix it also returns `null`: mounting the same
 * router twice on the same path would run every request through it twice.
 */
export function resolveLegacyPrefix(envs: EnvSource): string | null {
  const configured = envs.getEnv("API_LEGACY_PREFIX").trim();
  if (configured.toLowerCase() === "off") return null;

  const legacy = normalizePrefix(configured) ?? DEFAULT_LEGACY_PREFIX;
  return legacy === resolveApiPrefix(envs) ? null : legacy;
}
