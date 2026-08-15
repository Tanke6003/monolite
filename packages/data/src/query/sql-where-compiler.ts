import type { FieldOperators, WhereFilter } from "../contracts/generic-repository.js";
import { EntitySchema } from "../metadata/entity-metadata.js";
import { containsPattern, isOperatorObject, LIKE_ESCAPE } from "./filter-helpers.js";

export interface CompiledWhere {
  /** Body of the WHERE without the keyword; empty string if there are no conditions. */
  sql: string;
  binds: Record<string, unknown>;
}

/**
 * Translates a `WhereFilter<T>` into standard SQL, valid for every supported
 * SQL engine.
 *
 * Two security invariants:
 *  - column names always come from `EntitySchema.columnOf`, which throws if the
 *    property is not mapped, so nothing arbitrary reaches the SQL;
 *  - values are never interpolated, they are always bound as named binds.
 *
 * Each compiler is single-use: it accumulates its binds internally.
 */
export class SqlWhereCompiler<T> {
  private index = 0;
  private readonly binds: Record<string, unknown> = {};

  /**
   * @param prefix Bind prefix. It is used so that an UPDATE can mix the SET
   * binds and the WHERE binds without them colliding.
   */
  constructor(
    private readonly schema: EntitySchema<T>,
    private readonly prefix = "w",
    /**
     * Final adjustment of the value before binding it, specific to the engine.
     * The dialect supplies it; without it, values travel as they are.
     */
    private readonly toBindValue: (value: unknown) => unknown = (value) => value
  ) {}

  compile(filter?: WhereFilter<T>): CompiledWhere {
    const sql = filter ? this.compileFilter(filter) : "";
    return { sql, binds: this.binds };
  }

  private bind(property: string, value: unknown): string {
    const name = `${this.prefix}${this.index++}`;
    this.binds[name] = this.toBindValue(this.schema.toColumnValue(property, value));
    return `:${name}`;
  }

  private compileFilter(filter: WhereFilter<T>): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined) continue;

      if (key === "$and") {
        const group = (value as WhereFilter<T>[])
          .map((f) => this.compileFilter(f))
          .filter(Boolean);
        if (group.length > 0) parts.push(`(${group.join(" AND ")})`);
        continue;
      }

      if (key === "$or") {
        const group = (value as WhereFilter<T>[])
          .map((f) => this.compileFilter(f))
          .filter(Boolean);
        if (group.length > 0) parts.push(`(${group.join(" OR ")})`);
        continue;
      }

      if (key === "$not") {
        const inner = this.compileFilter(value as WhereFilter<T>);
        if (inner) parts.push(`NOT (${inner})`);
        continue;
      }

      const condition = this.compileField(key, value);
      if (condition) parts.push(condition);
    }

    return parts.join(" AND ");
  }

  private compileField(property: string, condition: unknown): string {
    const column = this.schema.columnOf(property);

    if (condition === null) return `${column} IS NULL`;
    if (!isOperatorObject(condition)) return `${column} = ${this.bind(property, condition)}`;

    const operators = condition as FieldOperators<unknown>;
    const parts: string[] = [];

    if (operators.eq !== undefined) {
      parts.push(
        operators.eq === null
          ? `${column} IS NULL`
          : `${column} = ${this.bind(property, operators.eq)}`
      );
    }
    if (operators.ne !== undefined) {
      parts.push(
        operators.ne === null
          ? `${column} IS NOT NULL`
          : `${column} <> ${this.bind(property, operators.ne)}`
      );
    }
    if (operators.gt !== undefined) parts.push(`${column} > ${this.bind(property, operators.gt)}`);
    if (operators.gte !== undefined) parts.push(`${column} >= ${this.bind(property, operators.gte)}`);
    if (operators.lt !== undefined) parts.push(`${column} < ${this.bind(property, operators.lt)}`);
    if (operators.lte !== undefined) parts.push(`${column} <= ${this.bind(property, operators.lte)}`);

    if (operators.like !== undefined) {
      parts.push(`${column} LIKE ${this.bind(property, operators.like)}`);
    }
    if (operators.notLike !== undefined) {
      parts.push(`${column} NOT LIKE ${this.bind(property, operators.notLike)}`);
    }
    if (operators.ilike !== undefined) {
      parts.push(`UPPER(${column}) LIKE UPPER(${this.bind(property, operators.ilike)})`);
    }
    if (operators.contains !== undefined) {
      // The pattern is built here, the caller does not write it: the wildcards
      // in the text are neutralised and the ESCAPE clause tells the engine that
      // this character marks a literal.
      const pattern = this.bind(property, containsPattern(operators.contains));
      parts.push(`UPPER(${column}) LIKE UPPER(${pattern}) ESCAPE '${LIKE_ESCAPE}'`);
    }

    if (operators.in !== undefined) {
      // An empty list cannot match anything; `1 = 0` expresses that without
      // generating the `IN ()` that Oracle would reject.
      parts.push(
        operators.in.length === 0
          ? "1 = 0"
          : `${column} IN (${operators.in.map((v) => this.bind(property, v)).join(", ")})`
      );
    }
    if (operators.notIn !== undefined) {
      parts.push(
        operators.notIn.length === 0
          ? "1 = 1"
          : `${column} NOT IN (${operators.notIn.map((v) => this.bind(property, v)).join(", ")})`
      );
    }

    if (operators.between !== undefined) {
      const [from, to] = operators.between;
      parts.push(`${column} BETWEEN ${this.bind(property, from)} AND ${this.bind(property, to)}`);
    }

    if (operators.isNull !== undefined) {
      parts.push(operators.isNull ? `${column} IS NULL` : `${column} IS NOT NULL`);
    }

    return parts.length > 1 ? `(${parts.join(" AND ")})` : parts.join("");
  }
}
