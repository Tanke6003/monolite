import { addDays, daysBetween, isDay, toDay } from "../../src/day/day.js";

// Whether these hold in every timezone is a question about the process, not
// the test: Jest hands each test a copy of `process.env`, so assigning `TZ`
// here changes nothing. CI runs the unit suite west of UTC, at UTC and east of
// it — one zone per Node version, see `ci.yml`.

describe("isDay", () => {
  it("accepts a day the calendar has", () => {
    expect(isDay("2026-04-30")).toBe(true);
    expect(isDay("2028-02-29")).toBe(true);
  });

  it("refuses a day the month does not have, a time, and anything not text", () => {
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2026-4-30")).toBe(false);
    expect(isDay("2026-04-30T00:00:00Z")).toBe(false);
    expect(isDay(new Date("2026-04-30"))).toBe(false);
    expect(isDay(null)).toBe(false);
  });
});

describe("toDay", () => {
  it("returns a day as it came", () => {
    expect(toDay("2026-04-30")).toBe("2026-04-30");
  });

  it("reads a Date by its UTC day, which is the day it was parsed from", () => {
    expect(toDay(new Date("2026-04-30"))).toBe("2026-04-30");
    expect(toDay(new Date("2026-04-30T23:59:59.999Z"))).toBe("2026-04-30");
  });

  it("refuses what is not a day, naming it", () => {
    expect(() => toDay("2026-02-30")).toThrow(/2026-02-30/);
    expect(() => toDay("tomorrow")).toThrow(TypeError);
    expect(() => toDay(new Date("nope"))).toThrow(TypeError);
  });
});

describe("daysBetween", () => {
  it("counts whole days, signed", () => {
    expect(daysBetween("2026-04-30", "2026-05-02")).toBe(2);
    expect(daysBetween("2026-05-02", "2026-04-30")).toBe(-2);
    expect(daysBetween("2026-04-30", "2026-04-30")).toBe(0);
  });

  it("gives the same answer in every timezone, across a DST change and a leap day", () => {
    // Mexico City kept DST until 2022; the US changes on 2026-03-08.
    expect(daysBetween("2021-04-01", "2021-04-05")).toBe(4);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
  });
});

describe("addDays", () => {
  it("moves across a month, a year and a leap day", () => {
    expect(addDays("2026-04-30", 1)).toBe("2026-05-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-04-30", 0)).toBe("2026-04-30");
  });

  it("refuses a fraction of a day", () => {
    expect(() => addDays("2026-04-30", 0.5)).toThrow(TypeError);
  });
});
