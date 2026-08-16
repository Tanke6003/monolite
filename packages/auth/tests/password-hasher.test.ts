/**
 * Password hashing on Node's own `crypto.scrypt`.
 *
 * Three properties are worth defending here, and none of them is "the hash is
 * correct": that a password can be checked against its own hash, that two
 * users with the same password do not end up with the same stored value, and
 * that a hash the class cannot read is a `false` rather than an exception —
 * because the caller of `verify` is a login, and a throw there turns a stale
 * column into a 500 instead of a refused sign-in.
 */
import { ScryptPasswordHasher } from "@monolite/auth";

// `require` rather than `import * as`: with `esModuleInterop` the namespace
// import is a *copy* of the module's exports, and a spy on a copy would not be
// the function the hasher calls.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeCrypto = require("node:crypto") as typeof import("node:crypto");

/**
 * Deliberately cheap parameters. The defaults cost about 32 MB and a tenth of a
 * second per derivation on purpose — that is the point of scrypt — and the
 * behaviour under test does not depend on the cost. One test below does use the
 * defaults, to pin down what actually gets stored.
 */
const cheap = () =>
  new ScryptPasswordHasher({ cost: 1024, blockSize: 4, keyLength: 32, saltLength: 8 });

describe("hash", () => {
  it("round-trips: a password verifies against its own hash", async () => {
    const hasher = cheap();
    const hash = await hasher.hash("correct horse battery staple");

    await expect(hasher.verify("correct horse battery staple", hash)).resolves.toBe(true);
  });

  it("refuses a password that is not the one", async () => {
    const hasher = cheap();
    const hash = await hasher.hash("the real one");

    await expect(hasher.verify("something else", hash)).resolves.toBe(false);
  });

  /**
   * A salt per password, never a global one. Without it two users with the same
   * password get the same stored value, which both leaks that fact to anyone
   * who reads the table and lets a single precomputed table cover every row.
   */
  it("uses a different salt each time, so two hashes of one password differ", async () => {
    const hasher = cheap();

    const first = await hasher.hash("same password");
    const second = await hasher.hash("same password");

    expect(first).not.toBe(second);
    expect(first.split("$")[4]).not.toBe(second.split("$")[4]);

    // And both still verify, which is what makes the salt free.
    await expect(hasher.verify("same password", first)).resolves.toBe(true);
    await expect(hasher.verify("same password", second)).resolves.toBe(true);
  });

  it("stores the scheme and the cost parameters alongside the hash", async () => {
    // `scrypt$N$r$p$salt$hash`. The parameters live inside each hash rather than
    // in configuration precisely so raising the cost does not invalidate every
    // password already stored.
    const [scheme, cost, blockSize, parallelization, salt, key] = (
      await cheap().hash("x")
    ).split("$");

    expect(scheme).toBe("scrypt");
    expect([cost, blockSize, parallelization]).toEqual(["1024", "4", "1"]);
    expect(Buffer.from(salt, "base64")).toHaveLength(8);
    expect(Buffer.from(key, "base64")).toHaveLength(32);
  });

  it("uses OWASP-shaped defaults when it is given none", async () => {
    // N = 2^15 with r = 8 costs about 32 MB per attempt, which is what makes
    // scrypt expensive to attack on a GPU.
    const stored = await new ScryptPasswordHasher().hash("x");

    expect(stored.startsWith("scrypt$32768$8$1$")).toBe(true);
  });

  /**
   * The reason the parameters travel inside the hash: the cost can be raised
   * without a migration, because an old hash still verifies with the parameters
   * it was made with.
   */
  it("still verifies a hash made with the older, cheaper parameters", async () => {
    const old = await new ScryptPasswordHasher({
      cost: 1024,
      blockSize: 4,
      keyLength: 32,
      saltLength: 8,
    }).hash("unchanged");

    const raised = new ScryptPasswordHasher({
      cost: 4096,
      blockSize: 8,
      keyLength: 64,
      saltLength: 16,
    });

    await expect(raised.verify("unchanged", old)).resolves.toBe(true);
  });
});

describe("verify", () => {
  it("compares in constant time", async () => {
    // A plain `===` bails out at the first byte that differs, and how long it
    // took to bail is a measurement of how much of the hash was guessed right —
    // enough, over many attempts, to reconstruct it byte by byte.
    const spy = jest.spyOn(nodeCrypto, "timingSafeEqual");
    const hasher = cheap();
    const hash = await hasher.hash("secret");

    await hasher.verify("secret", hash);

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  /**
   * Every one of these is a `false`, never a throw. The contract says so, and
   * the reason is the caller: `AuthService` treats an unreadable hash as a
   * failed login, and an exception there would answer 500 to a request that
   * simply had the wrong password.
   */
  it.each([
    ["an empty string", ""],
    ["something that is not a hash at all", "hunter2"],
    ["too few fields", "scrypt$1024$4$1$c2FsdA=="],
    ["too many fields", "scrypt$1024$4$1$c2FsdA==$aGFzaA==$extra"],
    ["another algorithm's format", "argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA"],
    ["parameters that are not numbers", "scrypt$many$4$1$c2FsdA==$aGFzaA=="],
    ["a zero cost", "scrypt$0$4$1$c2FsdA==$aGFzaA=="],
    ["a negative cost", "scrypt$-1024$4$1$c2FsdA==$aGFzaA=="],
    ["an empty salt", "scrypt$1024$4$1$$aGFzaA=="],
    ["an empty key", "scrypt$1024$4$1$c2FsdA==$"],
    ["a salt that is not base64", "scrypt$1024$4$1$!!!$aGFzaA=="],
  ])("returns false for %s", async (_case, stored) => {
    await expect(cheap().verify("anything", stored)).resolves.toBe(false);
  });

  it("returns false when the platform refuses the stored parameters", async () => {
    // N has to be a power of two. A row carrying something else is a corrupt
    // hash, not a crash: `derive` throws and the answer is still "no".
    await expect(cheap().verify("anything", "scrypt$3$4$1$c2FsdA==$aGFzaA==")).resolves.toBe(false);
  });

  it("refuses a hash of a different password even when the parameters match", async () => {
    const hasher = cheap();
    const mine = await hasher.hash("mine");

    await expect(hasher.verify("yours", mine)).resolves.toBe(false);
  });
});
