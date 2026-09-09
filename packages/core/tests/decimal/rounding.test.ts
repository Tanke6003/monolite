import { roundTo } from "../../src/decimal/rounding.js";

describe("roundTo", () => {
  it("rounds a half away from zero", () => {
    expect(roundTo(1.005)).toBe(1.01);
    expect(roundTo(2.675)).toBe(2.68);
    expect(roundTo(0.125)).toBe(0.13);
  });

  it("treats a debit and a credit the same", () => {
    // `Math.round` rounds a negative half towards +infinity, so the naive
    // implementation answers -1 here and 1.01 for the positive case. A rule
    // that rounds a charge and its credit note differently stops reconciling.
    expect(roundTo(-1.005)).toBe(-1.01);
    expect(roundTo(-2.675)).toBe(-2.68);
    expect(roundTo(-1.005)).toBe(-roundTo(1.005));
  });

  it("does not agree with multiplying by a hundred", () => {
    // The line this function exists to replace, kept here so the difference is
    // a fact of the suite and not a claim in a comment.
    const naive = (value: number): number => Math.round(value * 100) / 100;

    expect(naive(1.005)).toBe(1);
    expect(roundTo(1.005)).toBe(1.01);
  });

  it("clears the dust a float sum leaves behind", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(roundTo(0.1 + 0.2)).toBe(0.3);
    expect(roundTo(19.99 * 3)).toBe(59.97);
  });

  it("keeps the scale it is given", () => {
    expect(roundTo(1234.5678, 0)).toBe(1235);
    expect(roundTo(1234.5678, 1)).toBe(1234.6);
    expect(roundTo(1234.5678, 3)).toBe(1234.568);
    expect(roundTo(1234.5678, 4)).toBe(1234.5678);
  });

  it("leaves a value that is already rounded exactly as it was", () => {
    for (const value of [0, -0.01, 12.34, 1000, -999.99]) {
      expect(roundTo(value)).toBe(value);
    }
  });

  it("survives a magnitude big enough to print in exponential notation", () => {
    // There are no decimals left to round at that size; the answer is the value.
    expect(roundTo(1e21)).toBe(1e21);
    expect(roundTo(-1e21)).toBe(-1e21);
  });

  it("refuses what is not a number to round", () => {
    expect(() => roundTo(Number.NaN)).toThrow(/finite/);
    expect(() => roundTo(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it("refuses a scale a double cannot honour", () => {
    expect(() => roundTo(1.5, -1)).toThrow(/between 0 and 15/);
    expect(() => roundTo(1.5, 2.5)).toThrow(/whole number/);
    expect(() => roundTo(1.5, 16)).toThrow(/between 0 and 15/);
  });
});
