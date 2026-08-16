import {
  areDocsEnabled,
  resolveApiPrefix,
  resolveCorsOrigins,
  toBool,
  toInt,
} from "../src/config/env";

/**
 * The one test the scaffold ships with, and it is deliberately about
 * configuration rather than about a route.
 *
 * These functions decide where the API is mounted, whether the documentation is
 * public and which origins may call it — decisions that are made once at
 * startup, are never exercised by a happy-path request, and whose failure mode
 * is silent. They are also the only part of the bootstrap with no dependency on
 * the container, so this file proves the toolchain works before a single
 * `monolite-*` package has to resolve.
 */
describe("configuration helpers", () => {
  describe("toInt", () => {
    it("falls back when the variable is unset or empty", () => {
      expect(toInt(undefined, 3000)).toBe(3000);
      expect(toInt("", 3000)).toBe(3000);
      expect(toInt("   ", 3000)).toBe(3000);
    });

    it("falls back on anything that is not a whole number", () => {
      expect(toInt("abc", 3000)).toBe(3000);
      expect(toInt("3.5", 3000)).toBe(3000);
    });

    it("rejects values below the minimum instead of propagating them", () => {
      expect(toInt("0", 3000, 1)).toBe(3000);
      expect(toInt("0", 10, 0)).toBe(0);
    });

    it("takes a valid value", () => {
      expect(toInt("8080", 3000)).toBe(8080);
    });
  });

  describe("toBool", () => {
    it("understands the spellings people actually write", () => {
      expect(toBool("true", false)).toBe(true);
      expect(toBool("YES", false)).toBe(true);
      expect(toBool("0", true)).toBe(false);
      expect(toBool("off", true)).toBe(false);
    });

    it("falls back when the value means nothing", () => {
      expect(toBool("maybe", true)).toBe(true);
      expect(toBool(undefined, false)).toBe(false);
    });
  });

  describe("resolveApiPrefix", () => {
    it("normalises the three ways of writing the same prefix", () => {
      expect(resolveApiPrefix("api/v2")).toBe("/api/v2");
      expect(resolveApiPrefix("/api/v2")).toBe("/api/v2");
      expect(resolveApiPrefix("/api/v2/")).toBe("/api/v2");
    });

    it("uses the project's prefix when nothing is configured", () => {
      expect(resolveApiPrefix(undefined)).toBe("__apiPrefix__");
      expect(resolveApiPrefix("")).toBe("__apiPrefix__");
    });

    it("collapses a bare slash to the root", () => {
      expect(resolveApiPrefix("/")).toBe("/");
    });
  });

  describe("resolveCorsOrigins", () => {
    it("defaults to same-origin rather than to a wildcard", () => {
      expect(resolveCorsOrigins(undefined)).toBe(false);
      expect(resolveCorsOrigins("")).toBe(false);
    });

    it("treats an explicit asterisk as the wildcard", () => {
      expect(resolveCorsOrigins("*")).toBe(true);
    });

    it("splits and trims a list", () => {
      expect(resolveCorsOrigins("http://a.test, http://b.test")).toEqual([
        "http://a.test",
        "http://b.test",
      ]);
    });
  });

  describe("areDocsEnabled", () => {
    it("is on outside production and off in it, unless overridden", () => {
      expect(areDocsEnabled(undefined, "development")).toBe(true);
      expect(areDocsEnabled(undefined, "production")).toBe(false);
      expect(areDocsEnabled("true", "production")).toBe(true);
      expect(areDocsEnabled("false", "development")).toBe(false);
    });
  });
});
