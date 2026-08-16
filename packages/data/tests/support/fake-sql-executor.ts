import type { ISqlExecutor, SqlExecuteOptions, SqlExecuteResult } from "@monolite/data";

export interface RecordedCall {
  sql: string;
  binds: Record<string, unknown> | Record<string, unknown>[];
  /** What the repository expected from the statement: rows or affected rows. */
  expects?: SqlExecuteOptions["expects"];
}

/**
 * Fake executor: it records the generated SQL and returns canned answers. It
 * makes it possible to check exactly which statement and which binds the
 * generic repository produces without needing a database.
 */
export class FakeSqlExecutor implements ISqlExecutor {
  readonly calls: RecordedCall[] = [];
  private readonly responses: SqlExecuteResult[] = [];

  /** Queues the answer for the next call to `execute`. */
  queue(response: Partial<SqlExecuteResult>): this {
    this.responses.push({
      rows: response.rows ?? [],
      rowsAffected: response.rowsAffected ?? 0,
      outBinds: response.outBinds ?? {},
    });
    return this;
  }

  async execute<TRow = Record<string, unknown>>(
    sql: string,
    binds: Record<string, unknown> = {},
    options: SqlExecuteOptions = {}
  ): Promise<SqlExecuteResult<TRow>> {
    this.calls.push({ sql, binds, expects: options.expects });
    const next = this.responses.shift();
    return (next ?? { rows: [], rowsAffected: 0, outBinds: {} }) as SqlExecuteResult<TRow>;
  }

  async executeMany(sql: string, binds: Record<string, unknown>[]): Promise<number> {
    this.calls.push({ sql, binds });
    return binds.length;
  }

  /** SQL of the last call, with the whitespace normalised. */
  get lastSql(): string {
    return (this.calls.at(-1)?.sql ?? "").replace(/\s+/g, " ").trim();
  }

  get lastBinds(): Record<string, unknown> {
    return (this.calls.at(-1)?.binds ?? {}) as Record<string, unknown>;
  }

  sqlAt(index: number): string {
    return (this.calls[index]?.sql ?? "").replace(/\s+/g, " ").trim();
  }
}

export const silentLogger = {
  log: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
} as never;
