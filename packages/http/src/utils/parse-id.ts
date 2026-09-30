import { AppError } from "monolite-core";

/**
 * Turns a path parameter into a valid numeric id.
 *
 * `Number("")` is 0 and `Number(" 1 ")` is 1, so `isNaN` is not enough: a
 * positive integer is demanded so that `/branches/abc` answers 400 instead of
 * ending up querying for an absurd id.
 *
 * It takes `req.params.id` exactly as Express 5 types it, `string | string[]`,
 * so no caller has to narrow first. An array — a repeated parameter — is never
 * an id, not even with one element: that is the case a `as string` cast lets
 * through, since `Number(["7"])` is 7.
 */
export function parseId(raw: string | string[] | undefined, resource: string): number {
  const id = typeof raw === "string" ? Number(raw) : NaN;

  if (!raw || !Number.isInteger(id) || id <= 0) {
    throw new AppError(`Invalid ${resource} ID`, 400);
  }

  return id;
}
