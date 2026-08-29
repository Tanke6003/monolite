import { randomBytes } from "node:crypto";
import { AppError } from "monolite-core";
import type { ILogger } from "monolite-core";
import type {
  AuthResult,
  Credentials,
  ExternalAuthUser,
  ExternalIdentity,
  IAuthBLL,
  IExternalUserProvider,
  IIdentityProvider,
  IPasswordHasher,
  ITokenBLL,
} from "./contracts.js";
import { invalidCredentials, publicUser } from "./login.js";

export interface ExternalAuthBLLOptions {
  /** Lifetime of the issued token. Falls back to the token BLL's default. */
  expiresIn?: string | number;

  /**
   * Create the local account the first time an identity the provider vouches
   * for signs in. On by default, because the alternative is an administrator
   * retyping into this application every name that already exists over there.
   *
   * Turn it off where accounts are provisioned deliberately. A verified
   * identity with no local account then gets the ordinary 401 — the same one a
   * wrong password gets, on purpose: answering "your password is right but you
   * have no account here" confirms the credential to whoever was guessing it.
   */
  autoProvision?: boolean;

  /**
   * Accept the locally stored hash when the provider rejects or cannot be
   * reached. On by default, and it is what the emergency account is for: a
   * directory that is down must not leave everybody unable to so much as look
   * at their own data.
   *
   * Turned off, the provider becomes the only authority and nothing here ever
   * calls the hasher — a rejection is a 401 immediately, and an outage is a 503.
   */
  localPasswordFallback?: boolean;

  /**
   * Where an unreachable provider gets reported.
   *
   * Optional, and the one option worth passing anyway. An outage that falls
   * back to local passwords looks, from the outside, like an ordinary week
   * where a few people happen to be signing in with an old password — and the
   * day it stops looking like that is the day it becomes an incident nobody has
   * a first entry for.
   */
  logger?: ILogger;

  /**
   * Hash to check the password against when there is nothing to check it
   * against. See `AuthBLLOptions.dummyPasswordHash`; the reasoning is the same.
   */
  dummyPasswordHash?: string;
}

/** The three things `IIdentityProvider.verify` can mean, told apart. */
type Verdict =
  | { kind: "identified"; identity: ExternalIdentity }
  | { kind: "rejected" }
  | { kind: "unreachable" };

/**
 * The provider is down, and no local password got this request in.
 *
 * A 503 and not a 401, which is the whole reason `IIdentityProvider.verify`
 * distinguishes a rejection from a failure to answer. During an outage every
 * single sign-in fails; telling all of those people that their password is
 * wrong sends the entire organisation to reset a password that was fine, and
 * buries the one fact an operator needed.
 *
 * It leaks nothing about any account: that the directory is unreachable is a
 * fact about the deployment, identical for an address that exists and one that
 * does not.
 */
function providerUnavailable(): AppError {
  return new AppError("The identity provider is unavailable", 503, true, {
    code: "IDENTITY_PROVIDER_UNAVAILABLE",
  });
}

/**
 * Signing in against an identity that lives somewhere else.
 *
 * `AuthBLL` compares a password against a hash this application stores, which
 * is the only thing an `IUserProvider` can offer — it hands back a hash. No
 * external directory ever will: LDAP, Nextcloud and every OIDC provider check
 * the password themselves and answer yes or no. So the seam for them cannot be
 * the user provider, however often that gets suggested; it has to be here,
 * where the comparison happens. This class is that seam, and it keeps
 * everything around the comparison — the token, the single error, the timing
 * defence, the disabled account — instead of making every application rewrite
 * it.
 *
 * Four decisions worth reading before changing anything:
 *
 *  - **The roles are this application's.** The provider says who you are; what
 *    you may do is decided here. Mapping directory groups onto roles reads as a
 *    convenience right up until somebody is added to a group called `admin` for
 *    an unrelated reason and inherits this application with it. `groups`
 *    travels on the identity for an application that wants to decide something
 *    with it deliberately; nothing in this class reads it.
 *  - **The token's `sub` is the local id**, never the external key. That claim
 *    fills the audit columns and is what every rule about *who* is asking
 *    resolves against. The external key identifies the person to the provider,
 *    not to this application.
 *  - **Provisioning is minimal.** First sign-in creates an account with
 *    whatever least privilege the application's `provision` grants it.
 *  - **An outage is not a wrong password.** See `providerUnavailable`.
 */
export class ExternalAuthBLL implements IAuthBLL {
  /** Memoised; see `dummyHash`. */
  private dummy?: Promise<string>;

  constructor(
    private readonly identity: IIdentityProvider,
    private readonly users: IExternalUserProvider,
    private readonly hasher: IPasswordHasher,
    private readonly tokens: ITokenBLL,
    private readonly options: ExternalAuthBLLOptions = {}
  ) {}

  async login(credentials: Credentials): Promise<AuthResult> {
    // Normalised here rather than in the route schema, for the same reason
    // `AuthBLL` does it: it has to hold however the BLL is called.
    const email = credentials.email.trim().toLowerCase();
    const known = await this.users.findByEmail(email);

    // Asked for by external key once there is one, and by the typed address the
    // first time. Providers accept both, and the key is the one that still
    // works after somebody changes their address over there.
    const verdict = await this.ask(known?.externalKey || email, credentials.password);

    let user = known;

    if (verdict.kind === "identified") {
      user = await this.settle(known, verdict.identity, email);
    } else if (!(await this.acceptsLocalPassword(known, credentials.password))) {
      throw verdict.kind === "unreachable" ? providerUnavailable() : invalidCredentials();
    }

    // Checked after the credentials and answered like a wrong password, so that
    // somebody working through a list of addresses cannot learn which of them
    // exist but are suspended.
    if (!user || user.disabled) throw invalidCredentials();

    const { token, expiresIn } = this.tokens.sign(
      { sub: user.id, name: user.name, email: user.email, roles: user.roles },
      this.options.expiresIn
    );

    return { token, expiresIn, user: publicUser(user) };
  }

  /**
   * Asks the provider, and turns "it said no" and "it said nothing" into two
   * different answers instead of one.
   *
   * The throw is caught here and nowhere else. Letting it out would produce a
   * 500 for every sign-in during an outage — accurate, and useless: the
   * emergency account exists precisely so that some people can still get in,
   * and it never gets its turn if the request has already ended.
   */
  private async ask(login: string, password: string): Promise<Verdict> {
    try {
      const identity = await this.identity.verify(login, password);
      return identity ? { kind: "identified", identity } : { kind: "rejected" };
    } catch (error) {
      this.options.logger?.error("[auth] the identity provider did not answer", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "unreachable" };
    }
  }

  /**
   * Finds the local account for a verified identity, or creates it.
   *
   * The lookup by key is what makes a rename survivable: the address changed
   * over there, the lookup by email found nothing, and provisioning again would
   * leave a second account and orphan everything the first one signed.
   */
  private async settle(
    known: ExternalAuthUser | null,
    identity: ExternalIdentity,
    typedEmail: string
  ): Promise<ExternalAuthUser | null> {
    const user = known ?? (await this.users.findByExternalKey(identity.key));
    if (user) return this.users.link(user, identity);

    if (this.options.autoProvision === false) {
      this.options.logger?.warn("[auth] no local account for a verified identity", {
        key: identity.key,
      });
      return null;
    }

    this.options.logger?.info("[auth] provisioning from the identity provider", {
      key: identity.key,
    });
    return this.users.provision(identity, typedEmail);
  }

  /** The way back in: the hash this application does store, if it stores one. */
  private async acceptsLocalPassword(
    user: ExternalAuthUser | null,
    password: string
  ): Promise<boolean> {
    // Nothing is hashed when the fallback is off — not even for the timing,
    // which is already levelled by the call to the provider that every one of
    // these requests just made, existing address or not. Burning a scrypt
    // derivation per rejected login would only hand an attacker a way to spend
    // this process's CPU.
    if (this.options.localPasswordFallback === false) return false;

    // Verified even when there is no user and no hash, against a throwaway one,
    // so that the three answers cost the same. Skipping it would make "no such
    // address" come back in a millisecond and "wrong password" in the hundred
    // that scrypt deliberately costs, and that difference is measurable over a
    // network. The silence has to be as convincing as the message.
    const stored = user?.passwordHash || (await this.dummyHash());
    const matches = await this.hasher.verify(password, stored);
    return Boolean(user?.passwordHash) && matches;
  }

  /**
   * A hash of a password nobody knows. Produced by the injected hasher rather
   * than written as a constant, for the reason spelled out in `AuthBLL`: a
   * constant would be in one algorithm's format and would fail to parse — in
   * microseconds — under any other, which is exactly the timing signal it is
   * here to remove.
   */
  private dummyHash(): Promise<string> {
    const configured = this.options.dummyPasswordHash;
    if (configured) return Promise.resolve(configured);

    this.dummy ??= this.hasher.hash(randomBytes(32).toString("hex"));
    return this.dummy;
  }
}
