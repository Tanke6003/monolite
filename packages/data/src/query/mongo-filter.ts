import type { FieldOperators, WhereFilter } from "../contracts/generic-repository.js";
import { EntitySchema } from "../metadata/entity-metadata.js";
import { escapeRegExp, isOperatorObject, likeToRegExp } from "./filter-helpers.js";

/**
 * Translates the same `WhereFilter<T>` that `SqlWhereCompiler` takes to SQL and
 * `matchesFilter` evaluates in memory, this time into a MongoDB query document.
 * Keeping the three implementations aligned is what allows a module to be
 * written once and to work against any of the engines.
 *
 * Two invariants, the same as the SQL compiler's:
 *  - field names always come from `EntitySchema.columnOf`, which throws if the
 *    property is not mapped, so nothing arbitrary reaches the query;
 *  - values go through `toColumnValue`, so a boolean from the model is compared
 *    against the 1/0 that is actually stored and a date travels as a `Date`.
 */

/** Query document exactly as the driver expects it. */
export type MongoQuery = Record<string, unknown>;

function isNotEmpty(query: MongoQuery): boolean {
  return Object.keys(query).length > 0;
}

/**
 * Joins conditions with AND.
 *
 * They are deliberately not merged into a single object: two conditions on the
 * same field would share a key and one would overwrite the other. `$and` is
 * explicit and does not carry that risk.
 */
function and(parts: MongoQuery[]): MongoQuery {
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

/**
 * Conditions for one field. It returns a list because a single field may need
 * more than one document: `{ gte: 1, between: [5, 9] }` would produce two
 * `$gte` and only the last one would survive inside a single object.
 */
function compileField<T>(
  schema: EntitySchema<T>,
  property: string,
  condition: unknown
): MongoQuery[] {
  const field = schema.columnOf(property);
  const value = (raw: unknown): unknown => schema.toColumnValue(property, raw);

  // A bare `null` (`{ tag: null }`) means IS NULL. `$eq: null` also reaches the
  // documents that do not even have the field, which is what a SQL engine
  // understands by "column with no value".
  if (condition === null) return [{ [field]: { $eq: null } }];
  if (!isOperatorObject(condition)) return [{ [field]: { $eq: value(condition) } }];

  const operators = condition as FieldOperators<unknown>;
  const groups: Record<string, unknown>[] = [];

  /** Places the operator in the first group that does not already use it. */
  const put = (operator: string, operand: unknown): void => {
    const slot = groups.find((group) => !(operator in group));
    if (slot) slot[operator] = operand;
    else groups.push({ [operator]: operand });
  };

  if (operators.eq !== undefined) put("$eq", value(operators.eq));
  if (operators.ne !== undefined) put("$ne", value(operators.ne));
  if (operators.gt !== undefined) put("$gt", value(operators.gt));
  if (operators.gte !== undefined) put("$gte", value(operators.gte));
  if (operators.lt !== undefined) put("$lt", value(operators.lt));
  if (operators.lte !== undefined) put("$lte", value(operators.lte));

  // The LIKE pattern is reused as is: `likeToRegExp` already escapes the
  // metacharacters, so a `%` coming from the user does not turn into an
  // arbitrary regex. `ilike` is the same pattern with the case-insensitive flag.
  if (operators.like !== undefined) put("$regex", likeToRegExp(operators.like));
  if (operators.ilike !== undefined) put("$regex", likeToRegExp(operators.ilike, true));
  if (operators.notLike !== undefined) put("$not", likeToRegExp(operators.notLike));

  // A literal substring. The text is escaped whole before reaching the
  // `$regex`: without that, a `%%%%%` from a form would be translated into
  // `.*.*.*.*.*` and would be a pathological regex running inside the MongoDB
  // server.
  if (operators.contains !== undefined) {
    put("$regex", new RegExp(escapeRegExp(operators.contains), "i"));
  }

  // An empty list in `in` matches nothing, which is exactly what `$in: []` does
  // without needing the constant condition the SQL side requires.
  if (operators.in !== undefined) put("$in", operators.in.map((item) => value(item)));
  if (operators.notIn !== undefined) put("$nin", operators.notIn.map((item) => value(item)));

  if (operators.between !== undefined) {
    const [from, to] = operators.between;
    put("$gte", value(from));
    put("$lte", value(to));
  }

  if (operators.isNull !== undefined) put(operators.isNull ? "$eq" : "$ne", null);

  return groups.map((group) => ({ [field]: group }));
}

export function toMongoFilter<T>(
  filter: WhereFilter<T> | undefined,
  schema: EntitySchema<T>
): MongoQuery {
  if (!filter) return {};

  const parts: MongoQuery[] = [];

  for (const [key, condition] of Object.entries(filter)) {
    if (condition === undefined) continue;

    if (key === "$and") {
      const group = (condition as WhereFilter<T>[])
        .map((inner) => toMongoFilter(inner, schema))
        .filter(isNotEmpty);
      if (group.length > 0) parts.push(and(group));
      continue;
    }

    if (key === "$or") {
      const group = (condition as WhereFilter<T>[])
        .map((inner) => toMongoFilter(inner, schema))
        .filter(isNotEmpty);
      // An `$or: []` is an error for the server; an empty group contributes no
      // condition, just as in the other two translators.
      if (group.length > 0) parts.push({ $or: group });
      continue;
    }

    if (key === "$not") {
      const inner = toMongoFilter(condition as WhereFilter<T>, schema);
      // MongoDB has no top-level `$not` —only one inside a field—, so `$nor`
      // with a single member is used, which is its exact negation.
      if (isNotEmpty(inner)) parts.push({ $nor: [inner] });
      continue;
    }

    parts.push(...compileField(schema, key, condition));
  }

  return and(parts);
}
