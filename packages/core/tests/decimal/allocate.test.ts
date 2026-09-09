import { allocate } from "../../src/decimal/allocate.js";
import { roundTo } from "../../src/decimal/rounding.js";

/** The sum of the shares, added at the scale they were split at. */
const sumAt = (shares: number[], scale = 2): number =>
  roundTo(shares.reduce((total, share) => roundTo(total + share, scale), 0), scale);

describe("allocate", () => {
  it("splits what divides evenly without inventing a residue", () => {
    expect(allocate(1000, [50, 30, 20])).toEqual([500, 300, 200]);
    expect(allocate(90, [1, 1, 1])).toEqual([30, 30, 30]);
  });

  it("gives the cent that does not divide to the last share", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([33.33, 33.33, 33.34]);
  });

  it("puts the residue where it is told to", () => {
    expect(allocate(100, [1, 1, 1], { residue: "first" })).toEqual([33.34, 33.33, 33.33]);
    expect(allocate(100, [1, 1, 1], { residue: "last" })).toEqual([33.33, 33.33, 33.34]);
    expect(allocate(100, [1, 5, 1], { residue: "largest" })).toEqual([14.28, 71.44, 14.28]);
  });

  it("breaks a tie for the largest weight in favour of the earliest", () => {
    expect(allocate(100, [1, 1, 1], { residue: "largest" })).toEqual([33.34, 33.33, 33.33]);
  });

  it("adds back up to the total, whatever the split", () => {
    const cases: Array<[number, number[]]> = [
      [100, [1, 1, 1]],
      [0.03, [1, 1, 1]],
      [1234.56, [31, 30, 31, 30]],
      [10, [1, 2, 3, 4, 5, 6, 7]],
      [999999.99, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
      [0.01, [1, 1]],
      [7, [0.1, 0.2, 0.7]],
    ];

    for (const [total, weights] of cases) {
      for (const residue of ["first", "last", "largest"] as const) {
        const shares = allocate(total, weights, { residue });

        expect(shares).toHaveLength(weights.length);
        expect(sumAt(shares)).toBe(roundTo(total));
      }
    }
  });

  it("divides a credit note exactly as it divided the invoice", () => {
    const invoice = allocate(100, [1, 1, 1]);
    const credit = allocate(-100, [1, 1, 1]);

    expect(credit).toEqual(invoice.map((share) => -share));
    expect(sumAt(credit)).toBe(-100);
  });

  it("splits nothing into nothing", () => {
    expect(allocate(0, [1, 2, 3])).toEqual([0, 0, 0]);
  });

  it("gives a weight of zero nothing at all", () => {
    expect(allocate(100, [1, 0, 1])).toEqual([50, 0, 50]);
  });

  it("still honours the residue rule when the bucket that gets it weighs zero", () => {
    // The last share takes the residue by convention, not by merit: a bucket
    // that exists to absorb differences is often the one with no weight of its
    // own, and dropping the residue instead would lose the cent.
    const shares = allocate(100, [1, 1, 1, 0]);

    expect(shares).toEqual([33.33, 33.33, 33.33, 0.01]);
    expect(sumAt(shares)).toBe(100);
  });

  it("does not lose a tenth to the way a float adds up", () => {
    // `0.1 + 0.2 + 0.7` is `1.0000000000000002`, so the first share divides to
    // `0.6999999999999999`. Flooring that as it stands takes a clean seventy
    // cents down to sixty-nine and hands the difference to another bucket.
    expect(allocate(7, [0.1, 0.2, 0.7])).toEqual([0.7, 1.4, 4.9]);
  });

  it("works at other scales", () => {
    expect(allocate(100, [1, 1, 1], { scale: 0 })).toEqual([33, 33, 34]);
    expect(allocate(1, [1, 1, 1], { scale: 4 })).toEqual([0.3333, 0.3333, 0.3334]);
    expect(sumAt(allocate(1, [1, 1, 1], { scale: 4 }), 4)).toBe(1);
  });

  it("does not care how the weights are scaled", () => {
    const byOnes = allocate(100, [1, 1, 1]);

    expect(allocate(100, [50, 50, 50])).toEqual(byOnes);
    expect(allocate(100, [0.2, 0.2, 0.2])).toEqual(byOnes);
  });

  it("takes a single share", () => {
    expect(allocate(19.99, [1])).toEqual([19.99]);
  });

  it("refuses a split that is not a proportion", () => {
    expect(() => allocate(100, [])).toThrow(/at least one weight/);
    expect(() => allocate(100, [0, 0])).toThrow(/add up to zero/);
    expect(() => allocate(100, [1, -1])).toThrow(/non-negative/);
    expect(() => allocate(100, [1, Number.NaN])).toThrow(/non-negative/);
    expect(() => allocate(Number.NaN, [1])).toThrow(/finite total/);
  });
});
