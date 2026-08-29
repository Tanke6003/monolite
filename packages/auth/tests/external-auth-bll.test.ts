/**
 * The login flow for identities somebody else holds the password for.
 *
 * Three things here are load-bearing and each of them is a bug that has shipped
 * in a hand-rolled version of this class:
 *
 *  - **An outage is not a wrong password.** The provider throwing and the
 *    provider saying no are different answers, and collapsing them tells an
 *    entire organisation to reset a password that was fine. The assertions on
 *    the 503 are what keep the distinction alive.
 *  - **A rename must not produce a second account.** The lookup by external key
 *    is the only thing standing between a changed address and an orphaned row
 *    that owns every audit trail the person left behind.
 *  - **The roles are this application's.** `identity.groups` is carried and
 *    never read: a test that asserts the negative is the only way that stays
 *    true, because the code that would break it is code somebody adds on
 *    purpose, believing it to be a feature.
 *
 * The timing defence is verified the same way `auth-bll.test.ts` verifies it,
 * with a spy: the hasher must be called even when there is nothing to check.
 */
import { AppError } from "monolite-core";
import type { ILogger } from "monolite-core";
import {
  ExternalAuthBLL,
  type ExternalAuthBLLOptions,
  type ExternalAuthUser,
  type ExternalIdentity,
  type IExternalUserProvider,
  type IIdentityProvider,
  type IPasswordHasher,
  type ITokenBLL,
} from "monolite-auth";

const identity: ExternalIdentity = {
  key: "ana",
  name: "Ana Guzmán",
  email: "ana@example.com",
  groups: ["everyone", "admin"],
};

/** Already linked, and with no local password: the ordinary case here. */
const linked: ExternalAuthUser = {
  id: "7",
  name: "Ana Guzmán",
  email: "ana@example.com",
  roles: ["reader"],
  passwordHash: "",
  externalKey: "ana",
};

interface Harness {
  service: ExternalAuthBLL;
  provider: jest.Mocked<IIdentityProvider>;
  users: jest.Mocked<IExternalUserProvider>;
  hasher: jest.Mocked<IPasswordHasher>;
  tokens: jest.Mocked<ITokenBLL>;
  logger: jest.Mocked<ILogger>;
}

function harness(options: ExternalAuthBLLOptions = {}): Harness {
  const provider = { verify: jest.fn(async () => null) } as unknown as jest.Mocked<IIdentityProvider>;

  const users = {
    findByEmail: jest.fn(async () => null),
    findByExternalKey: jest.fn(async () => null),
    // The default implementations mirror what a real one does: hand back the
    // account as it now stands.
    provision: jest.fn(async (external: ExternalIdentity, fallbackEmail: string) => ({
      id: "99",
      name: external.name,
      email: external.email ?? fallbackEmail,
      roles: ["reader"],
      passwordHash: "",
      externalKey: external.key,
    })),
    link: jest.fn(async (user: ExternalAuthUser) => user),
  } as unknown as jest.Mocked<IExternalUserProvider>;

  const hasher = {
    hash: jest.fn(async (plain: string) => `hash-of:${plain}`),
    verify: jest.fn(async () => false),
  } as unknown as jest.Mocked<IPasswordHasher>;

  const tokens = {
    sign: jest.fn(() => ({ token: "signed-token", expiresIn: 3600 })),
    verify: jest.fn(),
  } as unknown as jest.Mocked<ITokenBLL>;

  const logger = {
    log: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<ILogger>;

  const service = new ExternalAuthBLL(provider, users, hasher, tokens, { logger, ...options });
  return { service, provider, users, hasher, tokens, logger };
}

/** Runs a login that is expected to fail and hands back the error it produced. */
async function failedLogin(
  service: ExternalAuthBLL,
  credentials: { email: string; password: string }
): Promise<AppError> {
  try {
    await service.login(credentials);
  } catch (error) {
    return error as AppError;
  }

  throw new Error("the login was expected to fail and did not");
}

const signIn = { email: "ana@example.com", password: "right" };

describe("a login the provider vouches for", () => {
  it("hands back a token, its lifetime and the identity behind it", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue(linked);

    await expect(service.login(signIn)).resolves.toEqual({
      token: "signed-token",
      expiresIn: 3600,
      user: { id: "7", name: "Ana Guzmán", email: "ana@example.com", roles: ["reader"] },
    });
  });

  /**
   * The claim that fills the audit columns and that every rule about *who* is
   * asking resolves against. The provider's key identifies the person to the
   * provider; it is not this application's name for them.
   */
  it("signs the local id as `sub`, never the external key", async () => {
    const { service, provider, users, tokens } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue(linked);

    await service.login(signIn);

    expect(tokens.sign).toHaveBeenCalledWith(
      { sub: "7", name: "Ana Guzmán", email: "ana@example.com", roles: ["reader"] },
      undefined
    );
    expect(JSON.stringify(tokens.sign.mock.calls)).not.toContain('"ana"');
  });

  /**
   * The privilege-escalation one. `identity.groups` says `admin`; the local
   * account says `reader`, and `reader` is what the token carries. Mapping the
   * two automatically hands this application to whoever is added to a directory
   * group for an unrelated reason.
   */
  it("takes the roles from the local account and not from the provider's groups", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue(linked);

    const { user } = await service.login(signIn);

    expect(user.roles).toEqual(["reader"]);
  });

  it("never lets a password hash out", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue({ ...linked, passwordHash: "stored-hash" });

    const { user } = await service.login(signIn);

    expect(user).not.toHaveProperty("passwordHash");
    expect(user).not.toHaveProperty("externalKey");
  });

  it("passes the configured lifetime to the token service", async () => {
    const { service, provider, users, tokens } = harness({ expiresIn: "15m" });
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue(linked);

    await service.login(signIn);

    expect(tokens.sign).toHaveBeenCalledWith(expect.any(Object), "15m");
  });

  it("trims and lower-cases the address before looking it up", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue(linked);

    await service.login({ email: "  Ana@Example.COM  ", password: "right" });

    expect(users.findByEmail).toHaveBeenCalledWith("ana@example.com");
  });

  /** The key is what still works after somebody changes their address there. */
  it("asks the provider by external key once there is one", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue({ ...linked, externalKey: "a.guzman" });

    await service.login(signIn);

    expect(provider.verify).toHaveBeenCalledWith("a.guzman", "right");
  });

  it("asks by the typed address when the account has never been linked", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue({ ...linked, externalKey: null });

    await service.login(signIn);

    expect(provider.verify).toHaveBeenCalledWith("ana@example.com", "right");
  });

  it("records what the provider said about an account it already knows", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue(linked);

    await service.login(signIn);

    expect(users.link).toHaveBeenCalledWith(linked, identity);
    expect(users.provision).not.toHaveBeenCalled();
  });

  /** What `link` returns is what the token is built from, not what was found. */
  it("issues the token from the account `link` handed back", async () => {
    const { service, provider, users, tokens } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue(linked);
    users.link.mockResolvedValue({ ...linked, name: "Ana G." });

    await service.login(signIn);

    expect(tokens.sign).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ana G." }),
      undefined
    );
  });
});

describe("the first sign-in of an identity", () => {
  it("creates the local account and signs a token for it", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(identity);

    const result = await service.login(signIn);

    expect(users.provision).toHaveBeenCalledWith(identity, "ana@example.com");
    expect(result.user).toMatchObject({ id: "99", roles: ["reader"] });
  });

  /** A provider that captures no address: the one just typed is safe to use, */
  /* because the provider has confirmed the account belongs to whoever typed it. */
  it("falls back to the typed address when the provider has none", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue({ ...identity, email: null });

    const { user } = await service.login({ email: "Ana@Example.com", password: "right" });

    expect(user.email).toBe("ana@example.com");
    expect(users.provision).toHaveBeenCalledWith(
      expect.objectContaining({ email: null }),
      "ana@example.com"
    );
  });

  /**
   * The rename. The address changed over there, so the lookup by email finds
   * nothing — and provisioning again would leave a second account and orphan
   * everything the first one signed.
   */
  it("finds an account by external key rather than creating a second one", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue({ ...identity, email: "ana.guzman@example.com" });
    users.findByEmail.mockResolvedValue(null);
    users.findByExternalKey.mockResolvedValue(linked);

    const { user } = await service.login({ email: "ana.guzman@example.com", password: "right" });

    expect(users.findByExternalKey).toHaveBeenCalledWith("ana");
    expect(users.provision).not.toHaveBeenCalled();
    expect(users.link).toHaveBeenCalled();
    expect(user.id).toBe("7");
  });

  /**
   * With provisioning off, a verified identity with no account here gets the
   * ordinary 401. Answering anything else — a 403, a different message —
   * confirms to whoever was guessing that the password was right.
   */
  it("answers a verified stranger like a wrong password when provisioning is off", async () => {
    const { service, provider, users, tokens } = harness({ autoProvision: false });
    provider.verify.mockResolvedValue(identity);

    const error = await failedLogin(service, signIn);

    expect(users.provision).not.toHaveBeenCalled();
    expect(tokens.sign).not.toHaveBeenCalled();
    expect(error).toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
  });
});

describe("an account the provider rejects", () => {
  it("falls back to the hash this application stores", async () => {
    const { service, provider, users, hasher } = harness();
    provider.verify.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue({ ...linked, passwordHash: "stored-hash" });
    hasher.verify.mockResolvedValue(true);

    await expect(service.login(signIn)).resolves.toMatchObject({ token: "signed-token" });
    expect(hasher.verify).toHaveBeenCalledWith("right", "stored-hash");
  });

  it("fails with the one error when there is no local password either", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue(linked);

    const error = await failedLogin(service, signIn);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 401,
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password",
    });
  });

  it("answers an unknown address and a rejected password identically", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(null);

    users.findByEmail.mockResolvedValue(null);
    const unknown = await failedLogin(service, { email: "nobody@example.com", password: "x" });

    users.findByEmail.mockResolvedValue(linked);
    const rejected = await failedLogin(service, signIn);

    expect({
      statusCode: unknown.statusCode,
      code: unknown.code,
      message: unknown.message,
    }).toEqual({
      statusCode: rejected.statusCode,
      code: rejected.code,
      message: rejected.message,
    });
  });

  /**
   * The load-bearing assertion for the timing, exactly as in `AuthBLL`: with no
   * account there is nothing to check and the obvious implementation returns
   * immediately, which is the oracle the throwaway hash exists to close.
   */
  it("still runs a verification when there is no local account", async () => {
    const { service, provider, users, hasher } = harness();
    provider.verify.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue(null);

    await failedLogin(service, { email: "nobody@example.com", password: "guess" });

    expect(hasher.verify).toHaveBeenCalledTimes(1);
    expect(hasher.verify).toHaveBeenCalledWith("guess", expect.stringMatching(/^hash-of:/));
  });

  it("builds the throwaway hash once and reuses it", async () => {
    const { service, provider, hasher } = harness();
    provider.verify.mockResolvedValue(null);

    await failedLogin(service, { email: "one@example.com", password: "a" });
    await failedLogin(service, { email: "two@example.com", password: "b" });

    expect(hasher.hash).toHaveBeenCalledTimes(1);
    expect(hasher.verify).toHaveBeenCalledTimes(2);
  });

  it("uses a supplied dummy hash instead of deriving one", async () => {
    const { service, provider, hasher } = harness({ dummyPasswordHash: "prebuilt-dummy" });
    provider.verify.mockResolvedValue(null);

    await failedLogin(service, { email: "nobody@example.com", password: "guess" });

    expect(hasher.hash).not.toHaveBeenCalled();
    expect(hasher.verify).toHaveBeenCalledWith("guess", "prebuilt-dummy");
  });
});

/**
 * The reason `IIdentityProvider.verify` throws for one failure and returns
 * `null` for the other. During an outage every sign-in fails at once, and
 * answering all of them with "wrong password" sends the whole organisation to
 * reset a password that was fine — while burying the only fact an operator
 * needed.
 */
describe("a provider that does not answer", () => {
  it("lets the locally stored password in", async () => {
    const { service, provider, users, hasher } = harness();
    provider.verify.mockRejectedValue(new Error("ECONNREFUSED"));
    users.findByEmail.mockResolvedValue({ ...linked, passwordHash: "stored-hash" });
    hasher.verify.mockResolvedValue(true);

    await expect(service.login(signIn)).resolves.toMatchObject({ token: "signed-token" });
  });

  it("answers 503 and not 401 when the local password does not get you in", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockRejectedValue(new Error("ECONNREFUSED"));
    users.findByEmail.mockResolvedValue(linked);

    const error = await failedLogin(service, signIn);

    expect(error).toMatchObject({
      statusCode: 503,
      code: "IDENTITY_PROVIDER_UNAVAILABLE",
    });
  });

  /**
   * And the same 503 for an address that does not exist here. Answering 401 for
   * one and 503 for the other would turn an outage into the account-existence
   * oracle the rest of this file is about.
   */
  it("answers the same way for an address it has never seen", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockRejectedValue(new Error("ECONNREFUSED"));
    users.findByEmail.mockResolvedValue(null);

    const error = await failedLogin(service, { email: "nobody@example.com", password: "x" });

    expect(error).toMatchObject({ statusCode: 503, code: "IDENTITY_PROVIDER_UNAVAILABLE" });
  });

  it("records the outage", async () => {
    const { service, provider, users, logger } = harness();
    provider.verify.mockRejectedValue(new Error("ECONNREFUSED"));
    users.findByEmail.mockResolvedValue(linked);

    await failedLogin(service, signIn);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("identity provider"),
      expect.objectContaining({ error: "ECONNREFUSED" })
    );
  });

  it("records an outage the provider reported as something other than an Error", async () => {
    // A client that rejects with a string, which several HTTP wrappers do. The
    // log line has to survive it: an outage nobody wrote down is an outage
    // nobody has a first entry for.
    const { service, provider, users, logger } = harness();
    provider.verify.mockRejectedValue("socket hang up");
    users.findByEmail.mockResolvedValue(linked);

    await failedLogin(service, signIn);

    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: "socket hang up" })
    );
  });

  it("works without a logger at all", async () => {
    const provider = { verify: jest.fn().mockRejectedValue(new Error("down")) };
    const users = {
      findByEmail: jest.fn(async () => null),
      findByExternalKey: jest.fn(async () => null),
      provision: jest.fn(),
      link: jest.fn(),
    } as unknown as IExternalUserProvider;
    const hasher = {
      hash: jest.fn(async () => "h"),
      verify: jest.fn(async () => false),
    } as unknown as IPasswordHasher;
    const tokens = { sign: jest.fn(), verify: jest.fn() } as unknown as ITokenBLL;

    const service = new ExternalAuthBLL(
      provider as unknown as IIdentityProvider,
      users,
      hasher,
      tokens
    );

    await expect(service.login(signIn)).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("with the local password fallback turned off", () => {
  it("never touches the hasher", async () => {
    // The provider is the only authority, so there is nothing to hash — and
    // burning a scrypt derivation per rejected login would hand an attacker a
    // way to spend this process's CPU for nothing.
    const { service, provider, users, hasher } = harness({ localPasswordFallback: false });
    provider.verify.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue({ ...linked, passwordHash: "stored-hash" });

    const error = await failedLogin(service, signIn);

    expect(hasher.verify).not.toHaveBeenCalled();
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(error).toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
  });

  it("still answers an outage with a 503", async () => {
    const { service, provider, users } = harness({ localPasswordFallback: false });
    provider.verify.mockRejectedValue(new Error("ECONNREFUSED"));
    users.findByEmail.mockResolvedValue({ ...linked, passwordHash: "stored-hash" });

    const error = await failedLogin(service, signIn);

    expect(error).toMatchObject({ statusCode: 503 });
  });
});

/**
 * The suspension that undoes itself.
 *
 * A provider answering `null` for a disabled account would send the next
 * sign-in — which the directory still accepts — straight down the provisioning
 * path, and a brand new account would quietly restore the access somebody had
 * just taken away. `ExternalAuthUser.disabled` is how the account says so out
 * loud, and the answer is the ordinary 401 so that nobody can learn from the
 * outside which addresses exist but are suspended.
 */
describe("a disabled local account", () => {
  it("is refused even though the provider vouched for it", async () => {
    const { service, provider, users, tokens } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue({ ...linked, disabled: true });

    const error = await failedLogin(service, signIn);

    expect(error).toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
    expect(tokens.sign).not.toHaveBeenCalled();
  });

  it("is not provisioned again", async () => {
    const { service, provider, users } = harness();
    provider.verify.mockResolvedValue(identity);
    users.findByEmail.mockResolvedValue({ ...linked, disabled: true });

    await failedLogin(service, signIn);

    expect(users.provision).not.toHaveBeenCalled();
  });

  it("is refused with a local password too", async () => {
    const { service, provider, users, hasher } = harness();
    provider.verify.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue({
      ...linked,
      passwordHash: "stored-hash",
      disabled: true,
    });
    hasher.verify.mockResolvedValue(true);

    const error = await failedLogin(service, signIn);

    expect(error).toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
  });
});
