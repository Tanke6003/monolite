import { normalizeLicense, validateLicense, validateVersion } from "../src/util/manifest";

/**
 * The answers npm accepts without a word and then bakes into a published
 * manifest.
 *
 * `license: "yes"` is the case this file exists for. It came out of a real
 * first run: `? License (MIT):` was read as a confirmation, the answer was
 * taken, and nothing would have said otherwise until the package was
 * published with a licence field that means nothing.
 */
describe("validateLicense", () => {
  it("accepts SPDX ids, in whatever case they were typed", () => {
    expect(validateLicense("MIT")).toBeNull();
    expect(validateLicense("Apache-2.0")).toBeNull();
    expect(validateLicense("BSD-3-Clause")).toBeNull();
    expect(validateLicense("mit")).toBeNull();
  });

  it("accepts the two escape hatches npm defines", () => {
    expect(validateLicense("UNLICENSED")).toBeNull();
    expect(validateLicense("SEE LICENSE IN LICENSE.txt")).toBeNull();
  });

  it("accepts a dual licence, parenthesised the way npm writes it", () => {
    expect(validateLicense("(MIT OR Apache-2.0)")).toBeNull();
    expect(validateLicense("MIT OR Apache-2.0")).toBeNull();
    expect(validateLicense("GPL-3.0-only WITH Classpath-exception-2.0")).toBeNull();
  });

  /** The whole point: the answer to a question this never asked. */
  it("rejects a yes/no answer and says which question it was", () => {
    for (const answer of ["yes", "y", "no", "n", "true", "false", "YES"]) {
      expect(validateLicense(answer)).toMatch(/which license, not whether/);
    }
  });

  it("rejects an empty licence and free prose", () => {
    expect(validateLicense("")).toMatch(/cannot be empty/);
    expect(validateLicense("whatever you want")).toMatch(/SPDX/);
  });
});

describe("normalizeLicense", () => {
  it("cases a known id the way SPDX does", () => {
    expect(normalizeLicense("mit")).toBe("MIT");
    expect(normalizeLicense("apache-2.0")).toBe("Apache-2.0");
    expect(normalizeLicense("unlicensed")).toBe("UNLICENSED");
  });

  /** It normalises; it does not police. An unknown id is the user's business. */
  it("leaves anything it does not know alone", () => {
    expect(normalizeLicense("Beerware")).toBe("Beerware");
    expect(normalizeLicense("SEE LICENSE IN LICENSE.txt")).toBe("SEE LICENSE IN LICENSE.txt");
  });
});

describe("validateVersion", () => {
  it("accepts semver, including a prerelease and build metadata", () => {
    expect(validateVersion("0.1.0")).toBeNull();
    expect(validateVersion("1.0.0")).toBeNull();
    expect(validateVersion("1.2.3-beta.1")).toBeNull();
    expect(validateVersion("1.2.3+build.5")).toBeNull();
  });

  it("rejects what a range or a tag would put there", () => {
    expect(validateVersion("")).toMatch(/cannot be empty/);
    expect(validateVersion("latest")).toMatch(/semver/);
    expect(validateVersion("^1.0.0")).toMatch(/semver/);
    expect(validateVersion("1.0")).toMatch(/semver/);
  });
});
