/**
 * The port of the old `JwtPlugin`, minus its two other jobs.
 *
 * That plugin also owned an Express middleware and reached into the request
 * context, which meant the one class that knows how to sign a token could not
 * be constructed without a web framework around it. Signing and verifying are
 * all that is left here — guarding a route is `requireAuth`'s business — and
 * the secret arrives as a constructor option instead of being read out of the
 * environment, so the class no longer decides where configuration comes from.
 */
import jwt from "jsonwebtoken";
import { JwtTokenService } from "monolite-auth";

const SECRET = "unit-test-secret";

describe("JwtTokenService", () => {
  let tokens: JwtTokenService;

  beforeEach(() => {
    tokens = new JwtTokenService({ secret: SECRET });
  });

  it("refuses to be built without a secret", () => {
    // A default secret is a secret everybody knows, and the day it reaches
    // production every token in the world is forgeable. Failing here is louder.
    expect(() => new JwtTokenService({ secret: "" })).toThrow(/No secret was provided/);
  });

  it("signs a token", () => {
    const { token } = tokens.sign({ userId: 1 });

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("gives back the claims it was handed", () => {
    const { token } = tokens.sign({ userId: 123, role: "admin" });

    expect(tokens.verify<{ userId: number; role: string; exp: number }>(token)).toMatchObject({
      userId: 123,
      role: "admin",
      exp: expect.any(Number),
    });
  });

  describe("expiresIn", () => {
    /**
     * The lifetime is read back off the token that was just signed rather than
     * derived from the option. `jsonwebtoken` accepts durations as strings
     * ("1h", "7d"), and parsing those here would mean keeping a second
     * implementation of its grammar in step with it forever — the two would
     * disagree eventually, and the client would be told a lifetime the token
     * does not have.
     */
    it("reports the lifetime in seconds, taken from the token itself", () => {
      expect(tokens.sign({ userId: 1 }).expiresIn).toBe(3600);
    });

    it("defaults to an hour", () => {
      expect(new JwtTokenService({ secret: SECRET }).sign({ a: 1 }).expiresIn).toBe(3600);
    });

    it("honours the service's configured default", () => {
      expect(new JwtTokenService({ secret: SECRET, expiresIn: "15m" }).sign({ a: 1 }).expiresIn).toBe(
        900
      );
    });

    it("lets a single call override it", () => {
      expect(tokens.sign({ a: 1 }, 60).expiresIn).toBe(60);
    });

    it("reports zero for a token that is already past its expiry", () => {
      expect(tokens.sign({ a: 1 }, "-1s").expiresIn).toBe(0);
    });
  });

  describe("verify", () => {
    it("throws for a token that is not one", () => {
      // It never returns null, so a caller cannot forget to check.
      expect(() => tokens.verify("not-a-token")).toThrow(
        expect.objectContaining({ name: "JsonWebTokenError" })
      );
    });

    it("throws for a token signed with another secret", () => {
      const foreign = new JwtTokenService({ secret: "someone-elses-secret" }).sign({ a: 1 }).token;

      expect(() => tokens.verify(foreign)).toThrow(/invalid signature/);
    });

    it("throws TokenExpiredError for an expired one, which is a different answer", () => {
      // Clients branch on it: expired means "renew", invalid means "sign in
      // again".
      const { token } = tokens.sign({ a: 1 }, "-1s");

      expect(() => tokens.verify(token)).toThrow(
        expect.objectContaining({ name: "TokenExpiredError" })
      );
    });

    it("rejects a token whose payload is not an object", () => {
      // Nothing in this package signs a bare string, so such a token came from
      // somewhere else and cannot be trusted to carry claims. It is refused
      // with the library's own error type, so it lands on the same 401.
      const overAString = jwt.sign("just-a-string", SECRET);

      expect(() => tokens.verify(overAString)).toThrow(/payload is not an object/);
    });
  });

  describe("issuer and audience", () => {
    const issued = () =>
      new JwtTokenService({
        secret: SECRET,
        issuer: "monolite",
        audience: ["web"],
      });

    it("writes them when signing", () => {
      const { token } = issued().sign({ a: 1 });

      expect(jwt.decode(token)).toMatchObject({ iss: "monolite", aud: ["web"] });
    });

    /**
     * They are demanded when verifying as well. An audience that is stamped and
     * never checked buys nothing: the attacker's token is precisely the one that
     * would carry the wrong value.
     */
    it("demands them when verifying", () => {
      const fromElsewhere = new JwtTokenService({
        secret: SECRET,
        issuer: "another-service",
        audience: ["web"],
      }).sign({ a: 1 }).token;

      expect(() => issued().verify(fromElsewhere)).toThrow(/jwt issuer invalid/);
    });

    it("refuses a token that carries neither", () => {
      // Signed with the right secret and still refused: the claims are part of
      // what makes the token this service's, not decoration.
      const plain = new JwtTokenService({ secret: SECRET }).sign({ a: 1 }).token;

      expect(() => issued().verify(plain)).toThrow(/jwt (issuer|audience) invalid/);
    });

    it("accepts its own", () => {
      const service = issued();

      expect(service.verify(service.sign({ a: 1 }).token)).toMatchObject({ a: 1 });
    });
  });
});
