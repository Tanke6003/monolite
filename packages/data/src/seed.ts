//
// `seed()` — reference data, declared once and applied as often as you like.
//
// It lives here, beside the repository contract, and not in `monolite-crud`,
// because everything it does is expressed in `IGenericRepository` and nothing
// in it is business logic. A BLL is the wrong door for reference data: its
// hooks and its validation exist for what a *user* sends, and a seed that went
// through them would either be refused by a rule written for a form or would
// need a way around it. The store is the right door, and every engine's store
// already speaks the same contract, so one implementation covers all six.
import type { IGenericRepository, WhereFilter } from "./contracts/generic-repository.js";

/**
 * Which properties identify a row.
 *
 * One name, or several for a composite key (`["tenant", "code"]`). **Not the
 * primary key**, as a rule: a seed has to recognise its rows in a database it
 * did not create, where the identity column handed out whatever numbers it
 * liked. What identifies reference data is the code the application refers to
 * it by, and that column should carry a unique index — the seed matches on it,
 * and a key that matched two rows would update both.
 */
export type SeedKey<T> = Extract<keyof T, string> | readonly Extract<keyof T, string>[];

export interface SeedOptions<T> {
  key: SeedKey<T>;
}

/** What happened to one declared row that was not left as it was. */
export interface SeedChange<T> {
  action: "inserted" | "updated";
  /** The key of the row, as declared: `{ code: "payments" }`. */
  key: Partial<T>;
  /**
   * The properties that differed and were written back. Empty for an insert,
   * where every declared property was.
   */
  fields: Extract<keyof T, string>[];
}

export interface SeedReport<T> {
  inserted: number;
  updated: number;
  /** Rows already exactly as declared: nothing was written to them. */
  unchanged: number;
  /**
   * Rows that exist but are soft-deleted, and were left alone.
   *
   * A seed does not overrule a deletion. Somebody retired that row on purpose,
   * and resurrecting it on every deploy would turn the delete button into a
   * suggestion. Restore it, or remove it from the seed.
   */
  skipped: number;
  /** One entry per insert and per update, in the order they were declared. */
  changes: SeedChange<T>[];
  /**
   * The counts as one line, ready for a log: `"1 inserted, 1 updated
   * (payments: name), 3 unchanged"`. The update names the row and the fields,
   * because a seed that restored a value somebody changed by hand should say
   * so, rather than leave them wondering where their edit went.
   */
  summary: string;
}

/**
 * Brings a table in line with a declared list of rows, by key.
 *
 * ```ts
 * await seed(sections, { key: "code" }, [
 *   { code: "payments", name: "Payments" },
 *   { code: "reports",  name: "Reports"  },
 * ]);
 * ```
 *
 * Insert what is missing, update what changed, leave what matches, report the
 * counts. It is written so that running it is always safe: the second run over
 * the same input reports `0 inserted, 0 updated` and has written nothing — not
 * an `UPDATE` that sets a column to the value it already holds, which would
 * still move `updatedAt` and still add a line to the change log.
 *
 * What it compares is **only what was declared**. A property left out of a row
 * is not the seed's business, so a column the application maintains itself —
 * a counter, a last-used date, a description an administrator rewrote — is
 * not reset on every deploy. Declare it and it is enforced; leave it out and it
 * is left alone.
 *
 * What it does not do, on purpose:
 *
 * - **Delete.** A row that is in the table and not in the list stays. Removing
 *   reference data breaks whatever still points at it, and that is a decision
 *   for a migration somebody reads, not a side effect of a list getting
 *   shorter.
 * - **Open a transaction.** It works inside whichever one is open, like any
 *   other repository call, so wrapping several seeds in one `unitOfWork` makes
 *   them land together; on its own each row is its own statement, and a failure
 *   halfway leaves the rows before it applied — which the next run completes.
 *
 * Values are compared as the store hands them back: dates by instant, `null`
 * and a missing value as the same thing, everything else strictly. Declare a
 * `decimal` at its column's scale — `1.005` against a two-decimal column is
 * stored as `1.01`, and would read as changed on every run.
 */
export async function seed<T extends object, TKey = number>(
  repository: IGenericRepository<T, TKey>,
  options: SeedOptions<T>,
  rows: readonly Partial<T>[]
): Promise<SeedReport<T>> {
  const keys = (Array.isArray(options.key) ? options.key : [options.key]) as Extract<
    keyof T,
    string
  >[];

  if (keys.length === 0) throw new Error("[seed] the key names no property");

  assertKeyed(rows, keys);

  const report: Omit<SeedReport<T>, "summary"> = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    changes: [],
  };

  for (const row of rows) {
    const key = pick(row, keys);
    const where = key as WhereFilter<T>;

    const existing = await repository.firstOrDefault({ where });

    if (!existing) {
      // Not visible does not mean not there: a soft-deleted row is hidden from
      // reads, and inserting beside it would either break the unique index the
      // key should have or quietly create a twin. See `skipped`.
      if (await repository.exists(where, true)) {
        report.skipped += 1;
        continue;
      }

      await repository.insert(row);
      report.inserted += 1;
      report.changes.push({ action: "inserted", key, fields: [] });
      continue;
    }

    const changed = (Object.keys(row) as Extract<keyof T, string>[]).filter(
      (field) => !keys.includes(field) && !sameValue(existing[field], row[field])
    );

    if (changed.length === 0) {
      report.unchanged += 1;
      continue;
    }

    // Only the fields that differ: the others already hold their value, and
    // writing them anyway would make the change log say something changed that
    // did not.
    await repository.updateWhere(where, pick(row, changed));
    report.updated += 1;
    report.changes.push({ action: "updated", key, fields: changed });
  }

  return { ...report, summary: summarize(report) };
}

/**
 * Every row carries its whole key, and no two rows share one.
 *
 * Both are mistakes in the list rather than in the database, so they are
 * caught before a single statement runs. A row without its key would match on
 * nothing — `{ code: undefined }` — and a duplicate would make the second
 * declaration silently overwrite the first on every run, flip-flopping a value
 * in the log for as long as nobody noticed.
 */
function assertKeyed<T>(rows: readonly Partial<T>[], keys: Extract<keyof T, string>[]): void {
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    const missing = keys.filter((key) => row[key] === undefined || row[key] === null);

    if (missing.length > 0) {
      throw new Error(`[seed] row ${index} has no value for its key (${missing.join(", ")})`);
    }

    const identity = JSON.stringify(keys.map((key) => row[key]));

    if (seen.has(identity)) {
      throw new Error(`[seed] row ${index} repeats the key ${describeKey(pick(row, keys))}`);
    }
    seen.add(identity);
  });
}

function pick<T>(row: Partial<T>, fields: Extract<keyof T, string>[]): Partial<T> {
  const picked: Partial<T> = {};
  for (const field of fields) picked[field] = row[field];
  return picked;
}

/**
 * Equality as a database round trip understands it.
 *
 * `null` and `undefined` are one value: an optional column the store returns
 * as `null` and a row that declares it `undefined` agree. Dates compare by the
 * instant, since the store hands back a new object every time. Anything else —
 * strings, numbers, booleans — must be identical, which is what the repository
 * already normalises them to.
 */
function sameValue(stored: unknown, declared: unknown): boolean {
  if (stored === null || stored === undefined) return declared === null || declared === undefined;
  if (stored instanceof Date && declared instanceof Date) {
    return stored.getTime() === declared.getTime();
  }
  return stored === declared;
}

function describeKey(key: object): string {
  return Object.values(key).map(String).join("/");
}

function summarize<T>(report: Omit<SeedReport<T>, "summary">): string {
  const updates = report.changes
    .filter((change) => change.action === "updated")
    .map((change) => `${describeKey(change.key)}: ${change.fields.join(", ")}`);

  const parts = [
    `${report.inserted} inserted`,
    `${report.updated} updated${updates.length > 0 ? ` (${updates.join("; ")})` : ""}`,
    `${report.unchanged} unchanged`,
  ];

  if (report.skipped > 0) parts.push(`${report.skipped} skipped (soft-deleted)`);

  return parts.join(", ");
}
