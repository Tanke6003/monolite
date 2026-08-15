import type { FieldOperators, OrderByClause } from "../contracts/generic-repository";

/** Keys recognised as operators inside a field filter. */
export const OPERATOR_KEYS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "notLike",
  "ilike",
  "contains",
  "in",
  "notIn",
  "between",
  "isNull",
]);

/**
 * Tells `{ age: { gte: 18 } }` (operators) apart from `{ createdAt: someDate }`
 * (direct equality). A `Date` or an array is a value, never an operator; a plain
 * object only counts as operators if every one of its keys is one.
 */
export function isOperatorObject(value: unknown): value is FieldOperators<unknown> {
  if (value === null || typeof value !== "object") return false;
  if (value instanceof Date || Array.isArray(value)) return false;

  const keys = Object.keys(value as object);
  // `{}` is accepted as "no condition" instead of being compared against an object.
  return keys.every((key) => OPERATOR_KEYS.has(key));
}

/** Accepts a single clause or an array and always returns an array. */
export function normalizeOrderBy<T>(
  orderBy?: OrderByClause<T> | OrderByClause<T>[]
): OrderByClause<T>[] {
  if (!orderBy) return [];
  return Array.isArray(orderBy) ? orderBy : [orderBy];
}

/**
 * Translates a SQL LIKE pattern (`%`, `_`) into an anchored regular expression,
 * escaping any metacharacter beforehand so that the pattern is not interpreted
 * as a regex.
 */
export function likeToRegExp(pattern: string, caseInsensitive = false): RegExp {
  const escaped = escapeRegExp(pattern);
  const translated = escaped.replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${translated}$`, caseInsensitive ? "i" : "");
}

/** Leaves a text ready to go inside a regular expression as a literal. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escape character for the `LIKE`s the SQL compiler generates.
 *
 * `!` is used instead of the backslash because MySQL treats the latter as an
 * escape inside the string literal itself: an `ESCAPE '\'` in the SQL reaches it
 * as an escaped quote and breaks the statement, while `!` means nothing special
 * on any of the four engines.
 */
export const LIKE_ESCAPE = "!";

/**
 * Turns literal text into a LIKE pattern that matches "contains it".
 *
 * Wildcards and the escape character itself are neutralised, so searching for
 * `100%` searches for exactly that and not for "anything starting with 100".
 */
export function containsPattern(value: string): string {
  const escaped = value.replace(
    new RegExp(`[${LIKE_ESCAPE}%_]`, "g"),
    (match) => `${LIKE_ESCAPE}${match}`
  );
  return `%${escaped}%`;
}
