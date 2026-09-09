/**
 * Rounding a number to a fixed number of decimals, for the one case where the
 * usual trick is not good enough: money.
 *
 * The usual trick is `Math.round(value * 100) / 100`, and it is wrong often
 * enough to matter. `1.005 * 100` is `100.49999999999999` in a double, so the
 * expression answers `1` where every invoice in the world says `1.01`. It is
 * also the kind of wrong that never shows up in a test written with `0.5`, and
 * shows up in production against a cent somebody can see.
 *
 * This rounds through the decimal *text* of the number instead of through a
 * multiplication. `String(1.005)` is `"1.005"` — the shortest text that reads
 * back as the same double — and `Number("1.005e2")` parses that text to the
 * nearest double to `100.5`, which is `100.5` exactly. The error the
 * multiplication introduced never happens, because there is no multiplication.
 *
 * **Half away from zero**, which is what invoices, statements and every
 * accountant mean by rounding: `1.005 -> 1.01` and `-1.005 -> -1.01`. That is
 * *not* what `Math.round` does with a negative half — it rounds towards `+∞`,
 * so `Math.round(-0.5)` is `-0` — and a rule that treats a charge and a credit
 * note differently is a rule that stops reconciling.
 */

/**
 * Past fifteen decimals a double has no digits left to round, so a scale beyond
 * it is a mistake in the caller rather than a request this can honour.
 */
const MAX_SCALE = 15;

export function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new Error(
      `[decimal] scale must be a whole number between 0 and ${MAX_SCALE}; received ${scale}.`
    );
  }
}

/**
 * `value` multiplied by `10^places`, done through the number's own decimal text
 * so that the shift introduces no error of its own.
 *
 * `null` means the text was already in exponential form (`1e+21`), where this
 * cannot work. That is not a failure to handle: a magnitude that large has no
 * digits after the point left to round anyway.
 */
function shift(value: number, places: number): number | null {
  const text = String(value);
  if (text.includes("e") || text.includes("E")) return null;

  const shifted = Number(`${text}e${places}`);
  return Number.isFinite(shifted) ? shifted : null;
}

/**
 * Rounds to `scale` decimals, half away from zero.
 *
 * ```ts
 * roundTo(1.005);        // 1.01   — not 1, which `Math.round(v * 100) / 100` gives
 * roundTo(-1.005);       // -1.01  — symmetric with the line above
 * roundTo(2.675);        // 2.68
 * roundTo(1234.5678, 2); // 1234.57
 * roundTo(1234.5678, 0); // 1235
 * ```
 *
 * @param scale Decimals to keep. Defaults to 2, which is what money is.
 * @throws if `value` is not finite, or `scale` is not a whole number in range.
 */
export function roundTo(value: number, scale = 2): number {
  assertScale(scale);

  if (!Number.isFinite(value)) {
    throw new Error(`[decimal] roundTo needs a finite number; received ${value}.`);
  }

  const shifted = shift(value, scale);
  if (shifted === null) return value;

  // `Math.round` alone would break the symmetry between a debit and a credit;
  // see the note at the top of the file.
  const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted));

  return shift(rounded, -scale) ?? rounded / 10 ** scale;
}
