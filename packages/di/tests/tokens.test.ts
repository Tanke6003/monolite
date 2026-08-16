import { storeToken, TOKENS } from "@monolite/di";

describe("TOKENS", () => {
  /**
   * The table's whole value is that `grep ILogger` finds the registration and
   * the injection alike. A key that did not match its value would break that
   * quietly, and nothing else would ever fail.
   */
  it("spells every value exactly like its key", () => {
    for (const [key, value] of Object.entries(TOKENS)) {
      expect(value).toBe(key);
    }
  });

  it("covers the framework contracts an application never registers itself", () => {
    // Not an inventory for its own sake: each of these is resolved by name
    // somewhere in the toolkit, so dropping one is a runtime failure in wiring
    // that no compiler sees.
    expect(Object.keys(TOKENS)).toEqual(
      expect.arrayContaining([
        "IEnvs",
        "ILogger",
        "IRequestContext",
        "ITransactionContext",
        "IHealthProbe",
        "ITokenService",
        "IFileStorage",
        "IDbPlugin",
        "IUnitOfWork",
        "IAuditTrail",
        "IAuditLogStore",
      ])
    );
  });
});

describe("storeToken", () => {
  it("is the entity name plus the Store suffix", () => {
    expect(storeToken("USERS")).toBe("USERSStore");
    expect(storeToken("Products")).toBe("ProductsStore");
  });

  it("does not normalise the name it is given", () => {
    // The caller's spelling is the one their feature modules inject, so
    // "correcting" it here would break the injection rather than fix anything.
    expect(storeToken("weird_Name")).toBe("weird_NameStore");
  });
});
