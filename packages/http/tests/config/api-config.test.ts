import {
  DEFAULT_API_PREFIX,
  DEFAULT_LEGACY_PREFIX,
  processEnv,
  resolveApiPrefix,
  resolveLegacyPrefix,
  type EnvSource,
} from "@monolite/http";

/** A fake environment: anything not declared answers "", as a real one does. */
const envsOf = (values: Record<string, string> = {}): EnvSource => ({
  getEnv: (key: string) => values[key] ?? "",
});

describe("resolveApiPrefix", () => {
  it("falls back to /api/v1 with no configuration", () => {
    expect(resolveApiPrefix(envsOf())).toBe(DEFAULT_API_PREFIX);
  });

  it("respects the configured prefix", () => {
    // The legitimate use is moving the API elsewhere — behind a proxy, or
    // alongside another application on the same domain. It does not create a
    // version 2; it renames version 1.
    expect(resolveApiPrefix(envsOf({ API_PREFIX: "/appointments-service/api/v1" }))).toBe(
      "/appointments-service/api/v1"
    );
  });

  it("normalises the leading and the trailing slash", () => {
    expect(resolveApiPrefix(envsOf({ API_PREFIX: "api/v2" }))).toBe("/api/v2");
    expect(resolveApiPrefix(envsOf({ API_PREFIX: "/api/v2/" }))).toBe("/api/v2");
    expect(resolveApiPrefix(envsOf({ API_PREFIX: "  /api/v2  " }))).toBe("/api/v2");
  });

  it("treats a lone slash or an empty value as unconfigured", () => {
    expect(resolveApiPrefix(envsOf({ API_PREFIX: "/" }))).toBe(DEFAULT_API_PREFIX);
    expect(resolveApiPrefix(envsOf({ API_PREFIX: "   " }))).toBe(DEFAULT_API_PREFIX);
  });
});

describe("resolveLegacyPrefix", () => {
  it("mounts /api by default", () => {
    expect(resolveLegacyPrefix(envsOf())).toBe(DEFAULT_LEGACY_PREFIX);
  });

  it("is turned off with `off`, not by leaving it empty", () => {
    expect(resolveLegacyPrefix(envsOf({ API_LEGACY_PREFIX: "off" }))).toBeNull();
    expect(resolveLegacyPrefix(envsOf({ API_LEGACY_PREFIX: "OFF" }))).toBeNull();
    // An empty value is indistinguishable from an undefined one, so it means the
    // default: otherwise deleting the line from the file would turn the alias
    // off without anybody asking for it.
    expect(resolveLegacyPrefix(envsOf({ API_LEGACY_PREFIX: "" }))).toBe(DEFAULT_LEGACY_PREFIX);
  });

  it("is not mounted when it would collide with the main prefix", () => {
    // Mounting the same router twice on the same path would run every request
    // through it twice — which is what `API_PREFIX=/api` plus the default alias
    // would do.
    expect(resolveLegacyPrefix(envsOf({ API_PREFIX: "/api" }))).toBeNull();
  });

  it("accepts an alias of its own", () => {
    expect(resolveLegacyPrefix(envsOf({ API_LEGACY_PREFIX: "/rest/" }))).toBe("/rest");
  });
});

describe("processEnv", () => {
  afterEach(() => {
    delete process.env.MONOLITE_TEST_VALUE;
  });

  it("reads the variable from the process", () => {
    process.env.MONOLITE_TEST_VALUE = "here";

    expect(processEnv.getEnv("MONOLITE_TEST_VALUE")).toBe("here");
  });

  /**
   * The contract the rest of the package reads against: an undefined variable
   * is `""`, never `undefined`. Every helper that consumes it has to tell
   * "absent" from "set to something empty" by hand, and it can only do that if
   * the source is consistent about which one it returns.
   */
  it("normalises a missing variable to an empty string", () => {
    expect(processEnv.getEnv("MONOLITE_TEST_VALUE")).toBe("");
  });
});
