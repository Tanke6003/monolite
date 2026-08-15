import { AppError } from "@monolite/core";

/**
 * Turns a path parameter into a valid numeric id.
 *
 * `Number("")` is 0 and `Number(" 1 ")` is 1, so `isNaN` is not enough: a
 * positive integer is demanded so that `/branches/abc` answers 400 instead of
 * ending up querying for an absurd id.
 */
export function parseId(raw: string | undefined, resource: string): number {
  const id = Number(raw);

  if (!raw || !Number.isInteger(id) || id <= 0) {
    throw new AppError(`Invalid ${resource} ID`, 400);
  }

  return id;
}
