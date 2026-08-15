import jwt, { JsonWebTokenError, type JwtPayload, type SignOptions } from "jsonwebtoken";
import type { ITokenService, SignedToken, TokenClaims } from "./contracts.js";

export interface JwtTokenServiceOptions {
  /**
   * The signing secret. There is no default on purpose: a default secret is a
   * secret everybody knows, and the day it reaches production every token in
   * the world is forgeable. Failing at construction is louder than that.
   */
  secret: string;
  /** Default lifetime of a signed token. Anything `jsonwebtoken` accepts. */
  expiresIn?: SignOptions["expiresIn"];
  /**
   * `iss` / `aud` claims. They are written when signing **and** demanded when
   * verifying: an audience that is only stamped and never checked buys nothing,
   * because the attacker's token is the one that would carry the wrong value.
   *
   * The list form is a non-empty tuple rather than `string[]` because that is
   * what `jsonwebtoken` demands on the verifying side, and the two sides have
   * to agree here or the check silently stops happening.
   */
  issuer?: string;
  audience?: string | [string, ...string[]];
}

/**
 * How long a token will be accepted, in seconds.
 *
 * It is read back off the token that was just signed instead of being derived
 * from the `expiresIn` option. `jsonwebtoken` accepts durations as strings
 * ("1h", "7d", "30m"), and parsing those here would mean keeping a second
 * implementation of its duration grammar in step with it forever — the two
 * would eventually disagree, and the client would be told a lifetime the token
 * does not have. The `exp` claim is the answer the verifier itself will use.
 */
function lifetimeOf(token: string): number {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded !== "object") return 0;

  const { exp, iat } = decoded as JwtPayload;
  // No `exp` means the caller asked for a token that never expires; zero is the
  // honest answer to "how many seconds until it stops working".
  if (typeof exp !== "number") return 0;

  const issuedAt = typeof iat === "number" ? iat : Math.floor(Date.now() / 1000);
  return Math.max(0, exp - issuedAt);
}

/**
 * JWT-backed token service.
 *
 * This is the port of the old `JwtPlugin`, minus its two extra jobs. The plugin
 * also owned an Express middleware and reached into the request context, which
 * meant the one class that knows how to sign a token could not be constructed
 * without a web framework around it. Here signing and verifying are all that is
 * left; guarding a route is `requireAuth`'s business, and it takes this service
 * as a parameter.
 */
export class JwtTokenService implements ITokenService {
  private readonly secret: string;
  private readonly defaultExpiresIn: SignOptions["expiresIn"];
  private readonly issuer?: string;
  private readonly audience?: string | [string, ...string[]];

  constructor(options: JwtTokenServiceOptions) {
    if (!options.secret) {
      throw new Error(
        "[JwtTokenService] No secret was provided. Refusing to sign tokens with an insecure " +
          "default."
      );
    }

    this.secret = options.secret;
    this.defaultExpiresIn = options.expiresIn ?? "1h";
    this.issuer = options.issuer;
    this.audience = options.audience;
  }

  sign<TPayload extends object>(payload: TPayload, expiresIn?: string | number): SignedToken {
    const options: SignOptions = {
      expiresIn: (expiresIn ?? this.defaultExpiresIn) as SignOptions["expiresIn"],
      ...(this.issuer ? { issuer: this.issuer } : {}),
      ...(this.audience ? { audience: this.audience } : {}),
    };

    const token = jwt.sign(payload, this.secret, options);
    return { token, expiresIn: lifetimeOf(token) };
  }

  verify<TPayload extends object = TokenClaims>(token: string): TPayload {
    const payload = jwt.verify(token, this.secret, {
      ...(this.issuer ? { issuer: this.issuer } : {}),
      ...(this.audience ? { audience: this.audience } : {}),
    });

    // `jsonwebtoken` hands back a plain string when the token was signed over
    // one. Nothing in this package signs strings, so such a token came from
    // somewhere else and cannot be trusted to carry claims. It is rejected with
    // the library's own error type so that it lands on the same 401 as any
    // other unusable token.
    if (typeof payload !== "object" || payload === null) {
      throw new JsonWebTokenError("The token payload is not an object");
    }

    return payload as TPayload;
  }
}
