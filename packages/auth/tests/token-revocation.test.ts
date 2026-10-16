/**
 * The denylist behind signing out.
 *
 * A signed token cannot be taken back, so revoking one is remembering that it
 * no longer counts — in the shared cache, for exactly as long as the token
 * would otherwise have lived. These run on `MemoryCache` with a clock the test
 * moves, so "it forgets once the token would have expired anyway" is checked
 * rather than assumed.
 */
import { MemoryCache, type ICache } from "monolite-core";
import { CacheTokenRevocation } from "monolite-auth";

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

let now = T0;
const seconds = (): number => Math.floor(now / 1000);

let cache: ICache;
let revocation: CacheTokenRevocation;

beforeEach(() => {
  now = T0;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  cache = new MemoryCache({ now: () => now });
  revocation = new CacheTokenRevocation(cache);
});

afterEach(() => jest.restoreAllMocks());

/** Claims of a token issued `age` seconds ago that lives `lifetime` seconds. */
const claims = (
  jti: string,
  { sub = "7", age = 0, lifetime = 3600 }: { sub?: string; age?: number; lifetime?: number } = {}
): Record<string, unknown> => ({
  sub,
  jti,
  iat: seconds() - age,
  exp: seconds() - age + lifetime,
});

describe("revoke", () => {
  it("withdraws the token it names, and only that one", async () => {
    await revocation.revoke(claims("a"));

    await expect(revocation.isRevoked(claims("a"))).resolves.toBe(true);
    await expect(revocation.isRevoked(claims("b"))).resolves.toBe(false);
  });

  it("forgets the token once it would have expired anyway", async () => {
    // The list empties itself: an entry outliving its token would only ever
    // be read for a token the guard already refuses on `exp`.
    const token = claims("a", { lifetime: 60 });
    await revocation.revoke(token);

    now += 59_000;
    await expect(cache.get("auth:revoked:a")).resolves.toBe(true);

    now += 2_000;
    await expect(cache.get("auth:revoked:a")).resolves.toBeNull();
  });

  it("writes nothing for a token that has already expired", async () => {
    await revocation.revoke(claims("a", { age: 120, lifetime: 60 }));

    await expect(cache.get("auth:revoked:a")).resolves.toBeNull();
  });

  it("keeps a token with no expiry for the longest lifetime it was told", async () => {
    revocation = new CacheTokenRevocation(cache, { maxTokenLifetime: 10 });
    await revocation.revoke({ sub: "7", jti: "a", iat: seconds() });

    now += 9_000;
    await expect(revocation.isRevoked({ jti: "a" })).resolves.toBe(true);
    now += 2_000;
    await expect(revocation.isRevoked({ jti: "a" })).resolves.toBe(false);
  });

  it("refuses a token with no `jti`, rather than pretending", async () => {
    await expect(revocation.revoke({ sub: "7", exp: seconds() + 60 })).rejects.toThrow(/jti/);
  });

  it("writes under the prefix it was given", async () => {
    revocation = new CacheTokenRevocation(cache, { prefix: "app:" });
    await revocation.revoke(claims("a"));

    await expect(cache.get("app:revoked:a")).resolves.toBe(true);
  });
});

describe("revokeAllFor", () => {
  it("withdraws every token the subject was issued before it", async () => {
    const older = claims("a", { age: 600 });
    const recent = claims("b", { age: 1 });

    await revocation.revokeAllFor("7");

    await expect(revocation.isRevoked(older)).resolves.toBe(true);
    await expect(revocation.isRevoked(recent)).resolves.toBe(true);
  });

  it("leaves the tokens of everybody else alone", async () => {
    await revocation.revokeAllFor("7");

    await expect(revocation.isRevoked(claims("a", { sub: "8", age: 600 }))).resolves.toBe(false);
  });

  it("lets the subject sign in again afterwards", async () => {
    await revocation.revokeAllFor("7");
    now += 1_000;

    await expect(revocation.isRevoked(claims("fresh"))).resolves.toBe(false);
  });

  /**
   * The one-second blind spot, pinned down so it is a decision and not an
   * accident: `iat` is in whole seconds, and refusing tokens from the second
   * of the mark would also refuse the fresh token handed out right after a
   * password change.
   */
  it("accepts a token issued within the same second as the mark", async () => {
    await revocation.revokeAllFor("7");

    await expect(revocation.isRevoked(claims("same-second"))).resolves.toBe(false);
  });

  it("treats a token that cannot say when it was issued as older", async () => {
    await revocation.revokeAllFor("7");

    await expect(revocation.isRevoked({ sub: "7", jti: "a" })).resolves.toBe(true);
  });

  it("is remembered for the longest lifetime it was told, then forgotten", async () => {
    revocation = new CacheTokenRevocation(cache, { maxTokenLifetime: 3600 });
    const token = claims("a", { age: 10 });
    await revocation.revokeAllFor("7");

    now += 3_599_000;
    await expect(revocation.isRevoked(token)).resolves.toBe(true);
    now += 2_000;
    await expect(cache.get("auth:not-before:7")).resolves.toBeNull();
  });
});

describe("isRevoked", () => {
  it("answers no for a token nobody revoked", async () => {
    await expect(revocation.isRevoked(claims("a"))).resolves.toBe(false);
  });

  it("answers no for claims that name neither a token nor a subject", async () => {
    await expect(revocation.isRevoked({ scope: "read" })).resolves.toBe(false);
  });

  it("lets a store failure through, so the guard can refuse instead of admitting", async () => {
    const broken = { get: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    revocation = new CacheTokenRevocation(broken as unknown as ICache);

    await expect(revocation.isRevoked(claims("a"))).rejects.toThrow("ECONNREFUSED");
  });
});
