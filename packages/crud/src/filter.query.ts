import type { WhereFilter } from "monolite-data";
import { AppError } from "monolite-core";

/**
 * A listing's filters, declared instead of coded.
 *
 * Nearly every module that offers search used to override `buildWhere` with
 * the same function under different nouns: cast the query to a hand-written
 * type, push one clause per parameter that arrived, and assemble the result as
 * nothing, the bare clause, or an `$and`. Three things in there were re-derived
 * every time, and each was a chance to differ — the cast drifting from the zod
 * schema the controller validates against, the assembly, and the date-range
 * convention, which is an off-by-a-day nobody notices until a report disagrees
 * with a screen.
 *
 * The toolkit owns both ends of that translation — it defines the query schema
 * and it defines `WhereFilter` — so the mapping is declared once, next to the
 * schema, and the mechanics live here:
 *
 * ```ts
 * export const paymentFilters = filtersFor<IPayment>({
 *   q:        contains(["reference", "notes"]),
 *   clientId: eq("clientId"),
 *   from:     gte("paymentDate", { boundary: "startOfDay" }),
 *   to:       lte("paymentDate", { boundary: "endOfDay" }),
 * });
 * ```
 *
 * **Why the map is declared rather than inferred from the schema.** Inferring
 * `eq` because the parameter is called `clientId` and so is a column is right
 * often enough to be trusted and wrong often enough to hurt: `from` and `to` do
 * not name their column, `q` maps to a different one in every module, and a
 * parameter that happens to share a name with a column is not always a filter
 * on it. Declaring keeps it explicit and still removes everything mechanical.
 *
 * **What it is not for: rules.** "Overdue" meaning a date *and* a status *and*
 * no payment against it is logic, not a mapping. That stays in an overridden
 * `buildWhere`, which can call `super.buildWhere(query)` to get these filters
 * and combine its rule with them through `allOf`.
 */

/**
 * How a calendar date (`2026-03-14`) becomes an instant when it bounds a range.
 *
 * Named rather than written as a string literal in each module because it is
 * the same decision everywhere — the lower bound is the first millisecond of
 * the day, the upper bound the last, both in UTC — and it is the one decision
 * that has to change in exactly one place the day the application gets a
 * timezone.
 */
export type DayBoundary = "startOfDay" | "endOfDay";

/** Options of the comparison rules (`gte`, `lte`, `gt`, `lt`). */
export interface RangeOptions {
  /**
   * Read the parameter as a calendar date and compare against this end of it.
   * Without it, the value reaches the filter exactly as the query holds it.
   */
  boundary?: DayBoundary;
}

/**
 * What one query parameter turns into, for whichever columns it names.
 *
 * `K` is carried only so `filtersFor` can check the column names against the
 * entity: it appears in `fields` and nowhere else, which keeps the type
 * covariant — a rule over `"clientId"` fits where the entity's keys are
 * expected only if `"clientId"` is one of them. That is the whole compile-time
 * guarantee, and it is why the rules are built by these functions rather than
 * written as object literals.
 */
export interface FilterRule<K extends string = string> {
  /** The entity properties this rule filters on, in the order they are emitted. */
  readonly fields: readonly K[];
  /**
   * The clause for one present value, or `undefined` for none. Typed loosely on
   * purpose: the rule is built before the entity is known, and `filtersFor` is
   * the one place that pins it to a `WhereFilter<T>`.
   */
  readonly clause: (value: unknown, param: string) => object | undefined;
}

/** A module's declared filters, ready to turn a validated query into a `where`. */
export interface QueryFilters<T> {
  /** The query parameters that filter, in the order their clauses are emitted. */
  readonly params: readonly string[];
  /**
   * The filter for this query: `undefined` when no parameter is present, the
   * bare clause when one is, `$and` of them when several are. See `allOf`.
   */
  where(query: unknown): WhereFilter<T> | undefined;
}

/**
 * Combines clauses the one correct way: nothing when there are none, the bare
 * clause when there is one, `$and` when there are several.
 *
 * The middle case is the one worth the function. A one-element `$and` is the
 * same filter, but it is not the same SQL — it adds a level of parentheses —
 * and a project migrating from a hand-written `buildWhere` should see its
 * emitted statements unchanged. `undefined` rather than `{ $and: [] }` for the
 * same reason, and because an empty `$and` is exactly the kind of value a
 * driver might one day read differently.
 *
 * Exported for the `buildWhere` overrides that remain: a rule combined with the
 * declared filters is `allOf(super.buildWhere(query), rule)`.
 */
export function allOf<T>(...clauses: (WhereFilter<T> | undefined)[]): WhereFilter<T> | undefined {
  const present = clauses.filter((one): one is WhereFilter<T> => one !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : ({ $and: present } as WhereFilter<T>);
}

/**
 * Whether a query parameter counts as sent.
 *
 * `undefined` and `null` are absence, and so is the empty string: it is what a
 * search box submits when nobody typed in it, and filtering on `contains: ""`
 * would match everything anyway at the price of a clause. `0` and `false` are
 * values — a filter on `quantity = 0` is a real question.
 */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** One clause per column, joined with `$or` when there are several. */
function anyOf(fields: readonly string[], build: (field: string) => object): object {
  const clauses = fields.map(build);
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant a calendar date stands for at one end of the day.
 *
 * Strict about its input on purpose. Concatenating `T00:00:00.000Z` onto a value
 * that already carries a time yields an `Invalid Date`, which every driver
 * treats differently and none of them as an error — a filter that silently
 * matches nothing, or everything. A value that is not a date is refused with a
 * 400 naming the parameter, and so is a day the month does not have. A schema
 * that validates with `z.coerce.date()` hands over a `Date`, which is read by
 * its UTC calendar day.
 */
function atBoundary(value: unknown, boundary: DayBoundary, param: string): Date {
  let day: string | undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    day = value.toISOString().slice(0, 10);
  } else if (typeof value === "string" && CALENDAR_DATE.test(value)) {
    day = value;
  }

  const instant = day
    ? new Date(`${day}${boundary === "startOfDay" ? "T00:00:00.000Z" : "T23:59:59.999Z"}`)
    : undefined;
  // The round trip catches `2026-02-30`, which the engine does not refuse but
  // rolls over into March — a range that ends two days late.
  if (!instant || Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== day) {
    throw new AppError(`The "${param}" parameter must be a calendar date (YYYY-MM-DD)`, 400);
  }
  return instant;
}

/** The four comparisons share everything but the operator. */
function compare<K extends string>(
  operator: "gt" | "gte" | "lt" | "lte",
  field: K,
  options: RangeOptions = {}
): FilterRule<K> {
  return {
    fields: [field],
    clause: (value, param) => ({
      [field]: {
        [operator]: options.boundary ? atBoundary(value, options.boundary, param) : value,
      },
    }),
  };
}

/** The column equals the parameter: `clientId: eq("clientId")`. */
export function eq<K extends string>(field: K): FilterRule<K> {
  return { fields: [field], clause: (value) => ({ [field]: value }) };
}

/**
 * The column contains the parameter as literal text, ignoring case — the
 * operator for whatever a user types into a search box.
 *
 * Given several columns it matches any of them, emitting an `$or` of one
 * `contains` per column and nothing else. That is the part that used to be
 * assembled by hand, which is why so many modules searched only the first
 * column somebody thought of.
 */
export function contains<K extends string>(fields: K | readonly K[]): FilterRule<K> {
  const columns: readonly K[] = typeof fields === "string" ? [fields] : fields;
  if (columns.length === 0) {
    throw new Error("[crud] contains() needs at least one column to search.");
  }

  return {
    fields: columns,
    clause: (value) => anyOf(columns, (field) => ({ [field]: { contains: String(value) } })),
  };
}

/** The column is greater than or equal to the parameter; see `RangeOptions`. */
export function gte<K extends string>(field: K, options?: RangeOptions): FilterRule<K> {
  return compare("gte", field, options);
}

/** The column is less than or equal to the parameter; see `RangeOptions`. */
export function lte<K extends string>(field: K, options?: RangeOptions): FilterRule<K> {
  return compare("lte", field, options);
}

/** The column is strictly greater than the parameter; see `RangeOptions`. */
export function gt<K extends string>(field: K, options?: RangeOptions): FilterRule<K> {
  return compare("gt", field, options);
}

/** The column is strictly less than the parameter; see `RangeOptions`. */
export function lt<K extends string>(field: K, options?: RangeOptions): FilterRule<K> {
  return compare("lt", field, options);
}

/**
 * Declares which query parameter filters on which column of `T`.
 *
 * Every column a rule names is checked against `T` at compile time, so a typo
 * or a renamed property fails the build rather than a listing. The keys of the
 * map are the query's parameter names; pass the query's type as `Q` —
 * `filtersFor<IPayment, z.infer<typeof paymentQuerySchema>>` — and they are
 * checked against the schema too, which is the drift the hand-written cast used
 * to hide.
 *
 * Clauses are emitted in the order the rules are declared, so a map written in
 * the same order as the `buildWhere` it replaces produces the identical filter,
 * and the identical SQL.
 */
export function filtersFor<T extends object, Q extends object = Record<string, unknown>>(
  rules: { [P in keyof Q]?: FilterRule<Extract<keyof T, string>> }
): QueryFilters<T> {
  const entries = Object.entries(rules as Record<string, FilterRule | undefined>).filter(
    (entry): entry is [string, FilterRule] => entry[1] !== undefined
  );

  return {
    params: entries.map(([param]) => param),
    where(query: unknown): WhereFilter<T> | undefined {
      if (typeof query !== "object" || query === null) return undefined;
      const values = query as Record<string, unknown>;

      const clauses = entries
        .filter(([param]) => isPresent(values[param]))
        .map(([param, rule]) => rule.clause(values[param], param) as WhereFilter<T> | undefined);

      return allOf(...clauses);
    },
  };
}
