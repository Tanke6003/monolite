import type { IEnvs } from "monolite-di";

/**
 * Reading configuration, and the conversions that go with it.
 *
 * Everything here is a pure function over a string, with no `process.env` read
 * at module scope and no side effects on import. That is what makes it the one
 * part of the bootstrap that can be unit tested without standing anything up —
 * see `tests/smoke.test.ts` — and it is also why `dotenv` is loaded in
 * `main.ts` instead: a module that loads a file when it is imported cannot be
 * imported by a test.
 */

export function readEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

/**
 * The whole contract `monolite-di` needs in order to configure itself: a
 * function that answers by name. Swapping `process.env` for a secrets manager
 * is replacing this object, and nothing that reads configuration through the
 * container notices.
 *
 * The import is type-only, so this file still has no runtime dependency on the
 * toolkit and `tests/smoke.test.ts` can keep exercising it on its own.
 */
export const envs: IEnvs = {
  getEnv: (name: string) => readEnv(name),
};

/**
 * For values that have no safe default. Failing loudly at startup beats
 * degrading quietly: a missing `JWT_SECRET` that falls back to a constant is a
 * production incident waiting for someone to notice.
 */
export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) throw new Error(`[config] ${name} is required and is not set`);
  return value;
}

/**
 * `min` is a parameter and not a constant because 0 means different things per
 * setting: a shutdown delay of 0 is a real choice, a port of 0 is not.
 */
export function toInt(raw: string | undefined, fallback: number, min = 0): number {
  // `Number("")` is 0, so without this an unset variable would read as a
  // deliberately configured zero.
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function toBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

/**
 * Normalises the mount point. `api/v1`, `/api/v1` and `/api/v1/` all mean the
 * same thing to a human and three different things to an Express router, so the
 * ambiguity is resolved once, here.
 */
export function resolveApiPrefix(raw: string | undefined, fallback = "__apiPrefix__"): string {
  const value = (raw ?? "").trim() || fallback;
  const withoutTrailing = value.replace(/\/+$/, "");

  if (!withoutTrailing) return "/";
  return withoutTrailing.startsWith("/") ? withoutTrailing : `/${withoutTrailing}`;
}

/**
 * The OpenAPI document describes the whole surface, input schemas included, so
 * outside development it is published only when explicitly asked for.
 */
export function areDocsEnabled(raw: string | undefined, nodeEnv: string): boolean {
  return toBool(raw, nodeEnv !== "production");
}
