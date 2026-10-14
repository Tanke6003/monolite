/**
 * A calendar day — `"2026-04-30"` — as a value of its own, not as an instant.
 *
 * A due date, a payment date and the end of a period have no time and no
 * timezone: `2026-04-30` is the same day to everyone. Carried as a `Date` it
 * becomes midnight *somewhere*, and every piece of code that reads it has to
 * pick where. One application built with the toolkit picked twice inside a
 * single subtraction — `getFullYear()` on one side, `getUTCFullYear()` on the
 * other — and west of UTC an invoice went overdue a day early.
 *
 * A string cannot be shifted. It sorts and compares correctly as text,
 * serialises to JSON as itself, and is what a DTO wanted in the first place.
 * The arithmetic below goes through `Date.UTC` and nothing else, so its answer
 * does not depend on the timezone of the machine running it.
 */

/** A calendar day, `YYYY-MM-DD`. A string, on purpose — see above. */
export type Day = string;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Midnight UTC of the day, or `NaN` when the text is not a day that exists. */
function utcMidnight(value: string): number {
  const match = DAY_PATTERN.exec(value);
  if (!match) return Number.NaN;

  const [, year, month, day] = match.map(Number);
  const time = Date.UTC(year, month - 1, day);
  // `Date.UTC` rolls `2026-02-30` over into March instead of refusing it; the
  // round trip is what tells a day the month has from one it does not.
  return new Date(time).toISOString().slice(0, 10) === value ? time : Number.NaN;
}

/** `YYYY-MM-DD`, and a day the calendar has: `2026-02-30` is not one. */
export function isDay(value: unknown): value is Day {
  return typeof value === "string" && !Number.isNaN(utcMidnight(value));
}

/**
 * The day a value stands for, or an error saying why it stands for none.
 *
 * A `Date` is read by its **UTC** calendar day. That is not a guess about
 * where the caller is: it is what `new Date("2026-04-30")` and
 * `z.coerce.date()` produce from a day — midnight UTC — so reading it back the
 * same way returns the day that went in, whatever `TZ` says.
 */
export function toDay(value: unknown): Day {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (isDay(value)) return value;

  throw new TypeError(`[day] expected a calendar day (YYYY-MM-DD); received ${String(value)}.`);
}

/**
 * Whole days from `from` to `to`: positive when `to` is later, zero on the same
 * day. `daysBetween("2026-04-30", "2026-05-02")` is `2`.
 */
export function daysBetween(from: Day, to: Day): number {
  return Math.round((utcMidnight(toDay(to)) - utcMidnight(toDay(from))) / MS_PER_DAY);
}

/** The day `days` after `day`, or before it when negative. */
export function addDays(day: Day, days: number): Day {
  if (!Number.isInteger(days)) {
    throw new TypeError(`[day] days must be a whole number; received ${days}.`);
  }
  return new Date(utcMidnight(toDay(day)) + days * MS_PER_DAY).toISOString().slice(0, 10);
}
