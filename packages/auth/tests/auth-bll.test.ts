/**
 * The security-critical one.
 *
 * A login form that answers "no such email" differently from "wrong password"
 * is a lookup service: an attacker submits a list of addresses with junk
 * passwords and walks away knowing which ones are registered. That is sensitive
 * on its own — knowing somebody has an account somewhere often is — and it also
 * halves the work of the attack that follows, because guessing passwords is
 * only worth doing against addresses known to exist.
 *
 * Answering with the same message is not enough. Skipping the hash for an
 * unknown email would make that answer arrive in a millisecond and the
 * "wrong password" answer in the hundred that scrypt deliberately costs, and
 * that difference is measurable over a network. **The timing has to lie as
 * convincingly as the message does**, which is why the service verifies against
 * a throwaway hash when the user does not exist.
 *
 * The reliable evidence for that is the spy: `verify` must be called even when
 * there is nobody to verify against. The wall-clock comparison at the end of
 * this file is a second opinion, kept deliberately loose.
 */
import { AppError } from "monolite-core";
import {
  AuthBLL,
  ScryptPasswordHasher,
  type AuthUserWithSecret,
  type IPasswordHasher,
  type ITokenBLL,
  type IUserProvider,
} from "monolite-auth";

const ana: AuthUserWithSecret = {
  id: "7",
  name: "Ana",
  email: "ana@example.com",
  roles: ["admin"],
  passwordHash: "stored-hash-for-ana",
};

interface Harness {
  service: AuthBLL;
  users: jest.Mocked<IUserProvider>;
  hasher: jest.Mocked<IPasswordHasher>;
  tokens: jest.Mocked<ITokenBLL>;
}

function harness(options: { dummyPasswordHash?: string; expiresIn?: string | number } = {}): Harness {
  const users = { findByEmail: jest.fn() } as unknown as jest.Mocked<IUserProvider>;

  const hasher = {
    hash: jest.fn(async (plain: string) => `hash-of:${plain}`),
    verify: jest.fn(async () => false),
  } as unknown as jest.Mocked<IPasswordHasher>;

  const tokens = {
    sign: jest.fn(() => ({ token: "signed-token", expiresIn: 3600 })),
    verify: jest.fn(),
  } as unknown as jest.Mocked<ITokenBLL>;

  return { service: new AuthBLL(users, hasher, tokens, options), users, hasher, tokens };
}

/** Runs a login that is expected to fail and hands back the error it produced. */
async function failedLogin(
  service: AuthBLL,
  credentials: { email: string; password: string }
): Promise<AppError> {
  try {
    await service.login(credentials);
  } catch (error) {
    return error as AppError;
  }

  throw new Error("the login was expected to fail and did not");
}

describe("a successful login", () => {
  it("hands back a token, its lifetime and the identity behind it", async () => {
    const { service, users, hasher } = harness();
    users.findByEmail.mockResolvedValue(ana);
    hasher.verify.mockResolvedValue(true);

    await expect(service.login({ email: "ana@example.com", password: "right" })).resolves.toEqual({
      token: "signed-token",
      expiresIn: 3600,
      user: { id: "7", name: "Ana", email: "ana@example.com", roles: ["admin"] },
    });
  });

  it("never lets the password hash out", async () => {
    // Written field by field rather than as a spread with the hash deleted: a
    // secret added to the user type later would ride out with a spread and
    // nobody would notice.
    const { service, users, hasher } = harness();
    users.findByEmail.mockResolvedValue(ana);
    hasher.verify.mockResolvedValue(true);

    const { user } = await service.login({ email: "ana@example.com", password: "right" });

    expect(user).not.toHaveProperty("passwordHash");
  });

  it("signs the id as `sub`, which is what the audit columns read", async () => {
    // The name can change; the id cannot. Anything that depends on *who* is
    // asking has to use this claim.
    const { service, users, hasher, tokens } = harness();
    users.findByEmail.mockResolvedValue(ana);
    hasher.verify.mockResolvedValue(true);

    await service.login({ email: "ana@example.com", password: "right" });

    expect(tokens.sign).toHaveBeenCalledWith(
      { sub: "7", name: "Ana", email: "ana@example.com", roles: ["admin"] },
      undefined
    );
  });

  it("passes the configured lifetime to the token service", async () => {
    const { service, users, hasher, tokens } = harness({ expiresIn: "15m" });
    users.findByEmail.mockResolvedValue(ana);
    hasher.verify.mockResolvedValue(true);

    await service.login({ email: "ana@example.com", password: "right" });

    expect(tokens.sign).toHaveBeenCalledWith(expect.any(Object), "15m");
  });

  it("checks the password against the stored hash", async () => {
    const { service, users, hasher } = harness();
    users.findByEmail.mockResolvedValue(ana);
    hasher.verify.mockResolvedValue(true);

    await service.login({ email: "ana@example.com", password: "right" });

    expect(hasher.verify).toHaveBeenCalledWith("right", "stored-hash-for-ana");
  });

  /**
   * Normalised in the service rather than in the route schema, so it holds
   * however the service is called. Addresses are case-insensitive in practice,
   * and whoever registered as "Ana@example.com" will type it in lower case
   * sooner or later.
   */
  it("trims and lower-cases the address before looking it up", async () => {
    const { service, users, hasher } = harness();
    users.findByEmail.mockResolvedValue(ana);
    hasher.verify.mockResolvedValue(true);

    await service.login({ email: "  Ana@Example.COM  ", password: "right" });

    expect(users.findByEmail).toHaveBeenCalledWith("ana@example.com");
  });
});

describe("a failed login", () => {
  it("answers an unknown email and a wrong password identically", async () => {
    const { service, users, hasher } = harness();

    users.findByEmail.mockResolvedValue(null);
    const unknownEmail = await failedLogin(service, { email: "nobody@example.com", password: "x" });

    users.findByEmail.mockResolvedValue(ana);
    hasher.verify.mockResolvedValue(false);
    const wrongPassword = await failedLogin(service, { email: "ana@example.com", password: "x" });

    // The same status, the same code and the same message. Any one of the three
    // differing is enough to tell the two cases apart.
    expect(unknownEmail).toBeInstanceOf(AppError);
    expect(wrongPassword).toBeInstanceOf(AppError);
    expect({
      statusCode: unknownEmail.statusCode,
      code: unknownEmail.code,
      message: unknownEmail.message,
    }).toEqual({
      statusCode: wrongPassword.statusCode,
      code: wrongPassword.code,
      message: wrongPassword.message,
    });
    expect(unknownEmail).toMatchObject({
      statusCode: 401,
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
    });
  });

  /**
   * The load-bearing assertion of this file.
   *
   * With no user there is nothing to check, and the obvious implementation
   * returns immediately. That shortcut is the timing oracle: the whole point of
   * the dummy hash is that this path costs what a real check costs.
   */
  it("still runs a verification when the user does not exist", async () => {
    const { service, users, hasher } = harness();
    users.findByEmail.mockResolvedValue(null);

    await failedLogin(service, { email: "nobody@example.com", password: "guess" });

    expect(hasher.verify).toHaveBeenCalledTimes(1);
    expect(hasher.verify).toHaveBeenCalledWith("guess", expect.stringMatching(/^hash-of:/));
  });

  it("checks against a hash the injected hasher produced, not a constant", async () => {
    // A constant would be in scrypt's format. Hand that to an argon2 hasher and
    // verification fails at the parse step, in microseconds — which is exactly
    // the timing signal the dummy exists to remove.
    const { service, users, hasher } = harness();
    users.findByEmail.mockResolvedValue(null);

    await failedLogin(service, { email: "nobody@example.com", password: "guess" });

    expect(hasher.hash).toHaveBeenCalledTimes(1);
    const [[dummyPlain]] = hasher.hash.mock.calls;
    const [[password, storedHash]] = hasher.verify.mock.calls;

    expect(password).toBe("guess");
    expect(storedHash).toBe(`hash-of:${dummyPlain}`);
    // And the throwaway password is not something anybody could guess.
    expect(dummyPlain).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds the throwaway hash once and reuses it", async () => {
    // Only the first failed login of a process pays for the extra derivation.
    const { service, users, hasher } = harness();
    users.findByEmail.mockResolvedValue(null);

    await failedLogin(service, { email: "one@example.com", password: "a" });
    await failedLogin(service, { email: "two@example.com", password: "b" });

    expect(hasher.hash).toHaveBeenCalledTimes(1);
    expect(hasher.verify).toHaveBeenCalledTimes(2);
  });

  it("uses a supplied dummy hash instead of deriving one", async () => {
    // The way out for a deployment where even the very first failed login must
    // not stand out.
    const { service, users, hasher } = harness({ dummyPasswordHash: "prebuilt-dummy" });
    users.findByEmail.mockResolvedValue(null);

    await failedLogin(service, { email: "nobody@example.com", password: "guess" });

    expect(hasher.hash).not.toHaveBeenCalled();
    expect(hasher.verify).toHaveBeenCalledWith("guess", "prebuilt-dummy");
  });

  /**
   * An account that only ever signed in through an external provider has no
   * password to accept. It takes the dummy path and fails like any other, which
   * is right — and, once more, indistinguishable from the outside.
   */
  it("treats a user with no stored hash the same way", async () => {
    const { service, users, hasher } = harness();
    users.findByEmail.mockResolvedValue({ ...ana, passwordHash: "" });

    const error = await failedLogin(service, { email: "ana@example.com", password: "x" });

    // The dummy path, not the empty column: comparing against `""` would be a
    // check that can never pass but also never costs anything.
    expect(hasher.verify).toHaveBeenCalledWith("x", expect.stringMatching(/^hash-of:/));
    expect(error).toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
  });

  it("issues no token when the password does not check out", async () => {
    const { service, users, hasher, tokens } = harness();
    users.findByEmail.mockResolvedValue(ana);
    hasher.verify.mockResolvedValue(false);

    await failedLogin(service, { email: "ana@example.com", password: "x" });

    expect(tokens.sign).not.toHaveBeenCalled();
  });
});

/**
 * A second opinion on the timing, and only that: wall-clock measurements are
 * noisy, so the band is wide and the spy above remains the real evidence. What
 * this rules out is the gross difference — microseconds against a full
 * derivation — that a network attacker can actually measure.
 */
describe("the timing of a failed login", () => {
  const hasher = new ScryptPasswordHasher({
    // Costly enough that the derivation dominates the noise, cheap enough to
    // run six times in a test.
    cost: 16384,
    blockSize: 8,
    keyLength: 32,
    saltLength: 16,
  });

  const tokens = {
    sign: () => ({ token: "t", expiresIn: 1 }),
    verify: () => ({}),
  } as unknown as ITokenBLL;

  /** The fastest of several runs: the least noisy statistic available here. */
  const fastestOf = async (attempt: () => Promise<unknown>): Promise<number> => {
    const samples: number[] = [];

    for (let i = 0; i < 3; i++) {
      const started = process.hrtime.bigint();
      await attempt();
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }

    return Math.min(...samples);
  };

  it("costs about the same for an unknown email as for a wrong password", async () => {
    const known: AuthUserWithSecret = { ...ana, passwordHash: await hasher.hash("the real one") };

    const users: IUserProvider = {
      findByEmail: async (email) => (email === known.email ? known : null),
    };

    const service = new AuthBLL(users, hasher, tokens);

    // Warm up, so the one-off derivation of the dummy hash is not counted.
    await failedLogin(service, { email: "nobody@example.com", password: "x" });

    const unknownEmail = await fastestOf(() =>
      failedLogin(service, { email: "nobody@example.com", password: "x" })
    );
    const wrongPassword = await fastestOf(() =>
      failedLogin(service, { email: "ana@example.com", password: "x" })
    );

    const ratio = unknownEmail / wrongPassword;

    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(5);
  });
});
