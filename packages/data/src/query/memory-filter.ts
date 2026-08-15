import type { FieldOperators, WhereFilter } from "../contracts/generic-repository.js";
import { EntitySchema } from "../metadata/entity-metadata.js";
import { isOperatorObject, likeToRegExp } from "./filter-helpers.js";

/**
 * In-memory evaluation of the very same `WhereFilter<T>` that
 * `SqlWhereCompiler` translates into SQL. Keeping both implementations aligned
 * is what allows a module to be developed against the in-memory datasource and
 * to behave identically once it is pointed at a real engine.
 */

/** Brings any value to something comparable with `<` and `>` consistently. */
function toComparable(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  return String(value);
}

/** Loose equality that treats equivalent dates as equal. */
function looseEquals(a: unknown, b: unknown): boolean {
  const left = toComparable(a);
  const right = toComparable(b);
  if (left === null || right === null) return left === right;
  return left === right;
}

function compare(a: unknown, b: unknown): number | null {
  const left = toComparable(a);
  const right = toComparable(b);
  if (left === null || right === null) return null;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function matchesOperators(value: unknown, operators: FieldOperators<unknown>): boolean {
  if (operators.eq !== undefined) {
    if (operators.eq === null ? value !== null && value !== undefined : !looseEquals(value, operators.eq)) {
      return false;
    }
  }
  if (operators.ne !== undefined) {
    if (operators.ne === null ? value === null || value === undefined : looseEquals(value, operators.ne)) {
      return false;
    }
  }

  if (operators.gt !== undefined) {
    const result = compare(value, operators.gt);
    if (result === null || result <= 0) return false;
  }
  if (operators.gte !== undefined) {
    const result = compare(value, operators.gte);
    if (result === null || result < 0) return false;
  }
  if (operators.lt !== undefined) {
    const result = compare(value, operators.lt);
    if (result === null || result >= 0) return false;
  }
  if (operators.lte !== undefined) {
    const result = compare(value, operators.lte);
    if (result === null || result > 0) return false;
  }

  if (operators.like !== undefined) {
    if (value === null || value === undefined) return false;
    if (!likeToRegExp(operators.like).test(String(value))) return false;
  }
  if (operators.notLike !== undefined) {
    if (value !== null && value !== undefined && likeToRegExp(operators.notLike).test(String(value))) {
      return false;
    }
  }
  if (operators.ilike !== undefined) {
    if (value === null || value === undefined) return false;
    if (!likeToRegExp(operators.ilike, true).test(String(value))) return false;
  }
  if (operators.contains !== undefined) {
    // A literal substring, without going through the pattern: there are no
    // wildcards to interpret here, which is exactly what sets `contains` apart
    // from `ilike`.
    if (value === null || value === undefined) return false;
    if (!String(value).toLowerCase().includes(operators.contains.toLowerCase())) return false;
  }

  if (operators.in !== undefined) {
    if (!operators.in.some((candidate) => looseEquals(value, candidate))) return false;
  }
  if (operators.notIn !== undefined) {
    if (operators.notIn.some((candidate) => looseEquals(value, candidate))) return false;
  }

  if (operators.between !== undefined) {
    const [from, to] = operators.between;
    const lower = compare(value, from);
    const upper = compare(value, to);
    if (lower === null || upper === null || lower < 0 || upper > 0) return false;
  }

  if (operators.isNull !== undefined) {
    const isNull = value === null || value === undefined;
    if (operators.isNull !== isNull) return false;
  }

  return true;
}

export function matchesFilter<T>(
  entity: T,
  filter: WhereFilter<T> | undefined,
  schema: EntitySchema<T>
): boolean {
  if (!filter) return true;

  for (const [key, condition] of Object.entries(filter)) {
    if (condition === undefined) continue;

    if (key === "$and") {
      if (!(condition as WhereFilter<T>[]).every((f) => matchesFilter(entity, f, schema))) return false;
      continue;
    }
    if (key === "$or") {
      const group = condition as WhereFilter<T>[];
      if (group.length > 0 && !group.some((f) => matchesFilter(entity, f, schema))) return false;
      continue;
    }
    if (key === "$not") {
      if (matchesFilter(entity, condition as WhereFilter<T>, schema)) return false;
      continue;
    }

    // Validates that the property exists in the mapping, just like the SQL
    // compiler does: a filter with a made-up property is an error, not a silent
    // "nothing matches".
    schema.columnOf(key);
    const value = (entity as Record<string, unknown>)[key];

    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }

    if (isOperatorObject(condition)) {
      if (!matchesOperators(value, condition as FieldOperators<unknown>)) return false;
      continue;
    }

    if (!looseEquals(value, condition)) return false;
  }

  return true;
}

/** Stable ordering equivalent to SQL's `ORDER BY`. */
export function compareBy(a: unknown, b: unknown, direction: "asc" | "desc" = "asc"): number {
  const left = toComparable(a);
  const right = toComparable(b);
  const factor = direction === "desc" ? -1 : 1;

  // Oracle sorts NULLs last in ASC; we replicate that behaviour.
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  if (typeof left === "number" && typeof right === "number") {
    return (left - right) * factor;
  }
  return String(left).localeCompare(String(right)) * factor;
}
