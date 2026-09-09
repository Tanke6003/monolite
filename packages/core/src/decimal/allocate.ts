/**
 * Splitting an amount into shares that add back up to it.
 *
 * This is the operation every application that handles money writes for itself,
 * writes more than once, and gets subtly different each time — prorating an
 * expense across the months it covers, splitting revenue between partners by
 * percentage, paying a balance down across several outstanding debts. Each of
 * those is `total × weight ÷ Σweights` followed by a decision nobody writes
 * down: **who absorbs the cent that does not divide.**
 *
 * A hundred pesos between three people is 33.333…, and no rounding of the three
 * shares adds up to a hundred. One of them has to be 33.34. Which one is a
 * convention, and the point of this function is that the convention is chosen
 * by name and applied in one place, instead of being whatever the third
 * implementation happened to do.
 *
 * The arithmetic runs in **minor units** — integers at the requested scale —
 * for the same reason: a sum of rounded shares drifts, a sum of integers does
 * not. What comes back are the shares in major units, and their total is the
 * total, exactly, at that scale.
 */
import { assertScale, roundTo } from "./rounding.js";

/** Which share absorbs the units that do not divide evenly. */
export type ResidueRule =
  /**
   * The last share. The default, and the right one when the list ends in the
   * bucket meant to absorb differences — a cash box, the final month of a
   * prorated expense.
   */
  | "last"
  /** The first share, for a list ordered with that bucket at the front. */
  | "first"
  /**
   * The share with the largest weight, ties going to the earliest of them.
   * The right one when no share is special and the residue should land where
   * it is proportionally least visible.
   */
  | "largest";

export interface AllocateOptions {
  /** Decimals of the currency. Defaults to 2. */
  scale?: number;
  /** Where the leftover units go. Defaults to `"last"`. */
  residue?: ResidueRule;
}

/**
 * What is added before flooring a share.
 *
 * `[0.1, 0.2, 0.7]` adds up to `1.0000000000000002` in a double, so seven pesos
 * split by it computes the first share as `0.6999999999999999` — and a bare
 * floor would take a clean tenth down to a cent short, then hand three stray
 * cents to whichever bucket absorbs the residue. The nudge is nine orders of
 * magnitude below a minor unit and several above the error a division of this
 * size introduces, so it corrects that and reaches nothing else.
 */
const NUDGE = 1e-9;

function residueIndex(rule: ResidueRule, weights: readonly number[]): number {
  if (rule === "first") return 0;
  if (rule === "last") return weights.length - 1;

  let index = 0;
  for (let i = 1; i < weights.length; i += 1) {
    if (weights[i] > weights[index]) index = i;
  }
  return index;
}

/**
 * Splits `total` in the given proportions, losing nothing.
 *
 * ```ts
 * allocate(100, [1, 1, 1]);                       // [33.33, 33.33, 33.34]
 * allocate(100, [1, 1, 1], { residue: "first" }); // [33.34, 33.33, 33.33]
 * allocate(1000, [50, 30, 20]);                   // [500, 300, 200]
 * allocate(-100, [1, 1, 1]);                      // [-33.33, -33.33, -33.34]
 * allocate(12000, [31, 30, 31], { scale: 2 });    // days in a quarter
 * ```
 *
 * The weights are proportions, not amounts: they need not add up to anything in
 * particular, and `[1, 1, 1]`, `[50, 50, 50]` and `[0.2, 0.2, 0.2]` all split
 * three ways. A weight of zero is allowed and takes nothing.
 *
 * **The guarantee is at `scale`.** The returned shares add up to
 * `roundTo(total, scale)` when added at that scale — adding them with `+` and
 * comparing to the last bit is asking a question about doubles, not about the
 * split.
 *
 * @throws if `total` or any weight is not finite, if a weight is negative, if
 *   there are no weights, or if they add up to zero — none of which describes a
 *   proportion, and all of which are worth failing on rather than guessing at.
 */
export function allocate(
  total: number,
  weights: readonly number[],
  options: AllocateOptions = {}
): number[] {
  const { scale = 2, residue = "last" } = options;
  assertScale(scale);

  if (!Number.isFinite(total)) {
    throw new Error(`[decimal] allocate needs a finite total; received ${total}.`);
  }

  if (weights.length === 0) {
    throw new Error("[decimal] allocate needs at least one weight to split between.");
  }

  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `[decimal] allocate needs finite, non-negative weights; received ${weight}. ` +
          "A negative share is not a proportion — if the amount itself is negative, " +
          "pass a negative total."
      );
    }
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  if (totalWeight <= 0) {
    throw new Error(
      "[decimal] allocate cannot split by weights that add up to zero: there is no " +
        "proportion to apply. Decide what an all-zero split means before calling."
    );
  }

  const factor = 10 ** scale;
  // Rounded first, so a total carrying float dust does not put that dust into
  // every share; then to integers, where the sum cannot drift.
  const units = Math.round(roundTo(total, scale) * factor);

  // The magnitude is what gets split, and the sign is put back at the end, so
  // that a credit note divides exactly as the invoice it reverses does.
  const sign = units < 0 ? -1 : 1;
  const magnitude = Math.abs(units);

  const shares = weights.map((weight) => Math.floor((magnitude * weight) / totalWeight + NUDGE));
  const assigned = shares.reduce((sum, share) => sum + share, 0);

  // Flooring never overshoots, so this is zero or a handful of units. Rounded
  // because the division above is still floating point, and a leftover of
  // `2.0000000000000004` would put a fraction of a cent into an integer.
  const leftover = Math.round(magnitude - assigned);
  shares[residueIndex(residue, weights)] += leftover;

  return shares.map((share) => roundTo((sign * share) / factor, scale));
}
