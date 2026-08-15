export interface SqlExecuteResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  rowsAffected: number;
  /** Values of the output parameters, indexed by name (Oracle). */
  outBinds: Record<string, unknown[]>;
}

export interface SqlExecuteOptions {
  /**
   * What is expected from the statement.
   *
   * Oracle returns rows and affected rows in the same response and ignores
   * this, but the rest need to know in order to choose how to run it: reading a
   * result set, asking for `@@ROWCOUNT` or collecting the generated id are not
   * the same call. With `identity` the executor returns the id in
   * `rows[0].insertedId`, which is where the dialect looks for it.
   */
  expects?: "rows" | "affected" | "identity";
}

/**
 * The minimum the generic repository needs in order to talk to a SQL engine.
 *
 * It is implemented both by the pool (every statement with auto-commit) and by
 * a transaction context, and both by Oracle and SQL Server. Thanks to that the
 * same repository serves both engines, inside or outside a transaction.
 *
 * Binds are always named (`:name`), which is the syntax accepted by
 * node-oracledb and by Sequelize's `replacements`.
 */
export interface ISqlExecutor {
  execute<TRow = Record<string, unknown>>(
    sql: string,
    binds?: Record<string, unknown>,
    options?: SqlExecuteOptions
  ): Promise<SqlExecuteResult<TRow>>;

  /** Runs the same statement with many sets of binds (bulk). */
  executeMany(sql: string, binds: Record<string, unknown>[]): Promise<number>;
}
