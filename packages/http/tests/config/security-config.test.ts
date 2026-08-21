/**
 * The hardening policy, tested apart from the server that mounts it.
 *
 * These are configuration decisions, not wiring, and the defaults are the point:
 * with no variable defined at all the toolkit has to come up secure, so that
 * whoever deploys raises what they need instead of lowering what they forgot.
 */
import type { NextFunction, Request, Response } from "express";
import { AppError, type ILogger } from "monolite-core";
import {
  DEFAULT_CSP_DIRECTIVES,
  REQUEST_ID_HEADER,
  SECURITY_DEFAULTS,
  areDocsEnabled,
  buildAuthRateLimiter,
  buildCorsOptions,
  buildHelmetOptions,
  buildRateLimiter,
  docsCspDirectives,
  SCALAR_CDN_ORIGIN,
  resolveAllowedOrigins,
  resolveBodyLimit,
  resolveTrustProxy,
  type EnvSource,
} from "monolite-http";

/** A fake environment: anything not declared answers "", as a real one does. */
const envsOf = (values: Record<string, string> = {}): EnvSource => ({
  getEnv: (key: string) => values[key] ?? "",
});

/** Runs the `origin` function of the CORS policy and settles its callback. */
const checkOrigin = (
  options: ReturnType<typeof buildCorsOptions>,
  origin: string | undefined
): Promise<{ error: Error | null; allowed?: boolean }> =>
  new Promise((resolve) => {
    const check = options.origin as (
      origin: string | undefined,
      callback: (error: Error | null, allowed?: boolean) => void
    ) => void;
    check(origin, (error, allowed) => resolve({ error, allowed }));
  });

describe("resolveBodyLimit", () => {
  it("falls back to 1mb when no variable is set", () => {
    // Express's own default, and plenty: JSON bodies stay under a kilobyte and
    // uploads do not go through this parser at all.
    expect(resolveBodyLimit(envsOf())).toBe(SECURITY_DEFAULTS.bodyLimit);
  });

  it("respects the configured value", () => {
    expect(resolveBodyLimit(envsOf({ BODY_LIMIT: "256kb" }))).toBe("256kb");
  });
});

describe("resolveTrustProxy", () => {
  it("trusts no proxy by default", () => {
    expect(resolveTrustProxy(envsOf())).toBe(0);
  });

  it("accepts an explicit zero", () => {
    expect(resolveTrustProxy(envsOf({ TRUST_PROXY_HOPS: "0" }))).toBe(0);
  });

  it("reads the number of hops", () => {
    expect(resolveTrustProxy(envsOf({ TRUST_PROXY_HOPS: "2" }))).toBe(2);
  });

  /**
   * It is a number and never `true`. With `true` Express believes any
   * `X-Forwarded-For`, so the limiter counts against an address the client picks
   * itself and varying it walks straight past the quota.
   */
  it("ignores a value that is not an integer, rather than trusting everything", () => {
    expect(resolveTrustProxy(envsOf({ TRUST_PROXY_HOPS: "true" }))).toBe(0);
    expect(resolveTrustProxy(envsOf({ TRUST_PROXY_HOPS: "1.5" }))).toBe(0);
    expect(resolveTrustProxy(envsOf({ TRUST_PROXY_HOPS: "-1" }))).toBe(0);
  });
});

describe("resolveAllowedOrigins", () => {
  it("returns an empty list when nothing is configured", () => {
    expect(resolveAllowedOrigins(envsOf())).toEqual([]);
  });

  it("takes several origins separated by commas", () => {
    // As many as needed: the production domain and, at the same time, the
    // localhost a front end is being debugged from against that very server.
    expect(
      resolveAllowedOrigins(
        envsOf({
          CORS_ORIGINS: "https://app.mydomain.com,http://localhost:5173,http://localhost:3000",
        })
      )
    ).toEqual(["https://app.mydomain.com", "http://localhost:5173", "http://localhost:3000"]);
  });

  it("normalises spaces, trailing slashes and case, and drops duplicates", () => {
    expect(
      resolveAllowedOrigins(envsOf({ CORS_ORIGINS: " https://App.com/ , https://app.com , , " }))
    ).toEqual(["https://app.com"]);
  });
});

describe("buildCorsOptions", () => {
  const options = () =>
    buildCorsOptions(envsOf({ CORS_ORIGINS: "https://app.mydomain.com,http://localhost:5173" }));

  it("accepts any origin on the list", async () => {
    expect(await checkOrigin(options(), "https://app.mydomain.com")).toEqual({
      error: null,
      allowed: true,
    });
    expect(await checkOrigin(options(), "http://localhost:5173")).toEqual({
      error: null,
      allowed: true,
    });
  });

  it("accepts a request with no Origin header (curl, Postman, health probes)", async () => {
    // Those are not cross-origin browser requests; CORS does not protect against
    // them and refusing them would only break the tooling.
    expect(await checkOrigin(options(), undefined)).toEqual({ error: null, allowed: true });
  });

  it("rejects a foreign origin with an AppError 403", async () => {
    // The rejection travels to the global handler, so a blocked origin answers
    // with the same shape — code, request id — as every other error.
    const { error } = await checkOrigin(options(), "http://evil.test");

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 403, code: "CORS_ORIGIN_NOT_ALLOWED" });
  });

  it("logs the blocked origin, which is what the browser will not tell you", async () => {
    // "Blocked by CORS" in the console does not say which origin arrived, and it
    // is almost always a trailing slash or a port.
    const logger = { warn: jest.fn() } as unknown as ILogger;
    const withLogger = buildCorsOptions(envsOf({ CORS_ORIGINS: "https://app.com" }), logger);

    await checkOrigin(withLogger, "https://app.com.evil.test");

    expect(logger.warn).toHaveBeenCalledWith(
      "Origin blocked by CORS",
      expect.objectContaining({ origin: "https://app.com.evil.test" })
    );
  });

  it("accepts any origin when the list holds `*`", async () => {
    const any = buildCorsOptions(envsOf({ CORS_ORIGINS: "*" }));

    expect(await checkOrigin(any, "http://anything.test")).toEqual({ error: null, allowed: true });
  });

  it("with no list, lets through only what carries no Origin", async () => {
    const strict = buildCorsOptions(envsOf());

    expect(await checkOrigin(strict, undefined)).toEqual({ error: null, allowed: true });
    expect((await checkOrigin(strict, "https://app.com")).error).toBeInstanceOf(AppError);
  });

  it("ignores a trailing slash or the case of the incoming origin", async () => {
    expect(await checkOrigin(options(), "https://APP.mydomain.com/")).toEqual({
      error: null,
      allowed: true,
    });
  });

  it("exposes the request-id header so the front end can read it", () => {
    // Without exposing it the browser hides the header from JavaScript, and the
    // id shown on an error page would have to be guessed.
    expect(options().exposedHeaders).toContain(REQUEST_ID_HEADER);
  });
});

describe("buildRateLimiter", () => {
  it("is built with the default values", () => {
    expect(buildRateLimiter(envsOf())).toBeInstanceOf(Function);
  });

  it("is switched off with RATE_LIMIT_MAX=0", () => {
    expect(buildRateLimiter(envsOf({ RATE_LIMIT_MAX: "0" }))).toBeNull();
  });

  it("lets the health checks through without spending quota", () => {
    // A load balancer probes every few seconds and would exhaust the quota of
    // its own address, so the instance would be marked down for being healthy.
    const limiter = buildRateLimiter(envsOf({ RATE_LIMIT_MAX: "1" }))!;
    const next = jest.fn();
    const res = { setHeader: jest.fn() } as unknown as Response;

    // More calls than the quota: if they counted, the second would be a 429.
    for (const path of ["/health", "/health/ready", "/health/live"]) {
      limiter({ path } as Request, res, next as NextFunction);
    }

    expect(next).toHaveBeenCalledTimes(3);
    expect(next).not.toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("buildAuthRateLimiter", () => {
  it("is built with the default values", () => {
    expect(buildAuthRateLimiter(envsOf())).toBeInstanceOf(Function);
  });

  it("is switched off with AUTH_RATE_LIMIT_MAX=0", () => {
    expect(buildAuthRateLimiter(envsOf({ AUTH_RATE_LIMIT_MAX: "0" }))).toBeNull();
  });

  it("is far narrower than the general one", () => {
    // A token is the only thing that opens the rest of the API, so it is the
    // first thing anybody will ask for in a loop.
    expect(SECURITY_DEFAULTS.authLimit).toBeLessThan(SECURITY_DEFAULTS.limit);
    expect(SECURITY_DEFAULTS.authWindowMs).toBeGreaterThan(SECURITY_DEFAULTS.windowMs);
  });
});

describe("buildHelmetOptions", () => {
  /**
   * The CSP arrives switched off. Helmet's default policy breaks Swagger UI
   * (inline styles) and Scalar (assets from a CDN) at once, and a freshly cloned
   * project greeting its author with two blank screens is the surest way to get
   * the policy disabled wholesale rather than tuned.
   */
  it("comes with the CSP off by default", () => {
    expect(buildHelmetOptions(envsOf()).contentSecurityPolicy).toBe(false);
  });

  it("turns it on with CSP_ENABLED=true", () => {
    expect(buildHelmetOptions(envsOf({ CSP_ENABLED: "true" })).contentSecurityPolicy).toMatchObject(
      { directives: expect.objectContaining({ "default-src": ["'self'"] }) }
    );
  });

  it("accepts directives of the application's own", () => {
    // The package cannot know which CDN or bucket an application needs, and
    // guessing would widen the policy for everyone.
    const custom = { "default-src": ["'self'", "https://cdn.example.com"] };

    expect(
      buildHelmetOptions(envsOf({ CSP_ENABLED: "true" }), custom).contentSecurityPolicy
    ).toEqual({ directives: custom });
  });

  it("keeps the default set as close to 'self' as a documented API can be", () => {
    expect(DEFAULT_CSP_DIRECTIVES["object-src"]).toEqual(["'none'"]);
    // Swagger UI injects its styles inline and there is no way around it short
    // of not serving Swagger at all.
    expect(DEFAULT_CSP_DIRECTIVES["style-src"]).toContain("'unsafe-inline'");
  });
});

describe("docsCspDirectives", () => {
  it("leaves the defaults alone for Swagger UI, which ships its own assets", () => {
    expect(docsCspDirectives("swagger")).toBe(DEFAULT_CSP_DIRECTIVES);
    expect(docsCspDirectives("none")).toBe(DEFAULT_CSP_DIRECTIVES);
  });

  /**
   * The failure this prevents: Scalar's page is a CDN `<script>` plus an inline
   * one that calls it, so under `script-src 'self'` the reader never loads. The
   * response is a 200 and the page is blank, which reads as "the documentation
   * is broken" and never as "a header blocked it".
   */
  it("lets Scalar's CDN through, script and inline bootstrap alike", () => {
    const directives = docsCspDirectives("scalar");

    expect(directives["script-src"]).toEqual(
      expect.arrayContaining(["'self'", SCALAR_CDN_ORIGIN, "'unsafe-inline'"])
    );
    expect(directives["style-src"]).toContain(SCALAR_CDN_ORIGIN);
    expect(directives["font-src"]).toContain(SCALAR_CDN_ORIGIN);
  });

  it("widens only what the reader needs and leaves the rest shut", () => {
    const directives = docsCspDirectives("scalar");

    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["default-src"]).toEqual(["'self'"]);
    // The document is fetched from the API itself, so nothing outbound.
    expect(directives["connect-src"]).toEqual(["'self'"]);
    // And the source set is not mutated on the way past.
    expect(DEFAULT_CSP_DIRECTIVES["script-src"]).toEqual(["'self'"]);
  });

  it("widens whichever set it was handed, not only the default one", () => {
    const own = { "script-src": ["'self'", "https://analytics.example.com"] };

    expect(docsCspDirectives("scalar", own)["script-src"]).toEqual([
      "'self'",
      "https://analytics.example.com",
      SCALAR_CDN_ORIGIN,
      "'unsafe-inline'",
    ]);
  });
});

describe("areDocsEnabled", () => {
  it("publishes the documentation outside production", () => {
    expect(areDocsEnabled(envsOf({ NODE_ENV: "development" }))).toBe(true);
    expect(areDocsEnabled(envsOf())).toBe(true);
  });

  it("hides it in production", () => {
    // Not to hide the endpoints — anyone can find those — but the input schemas:
    // the document is a map of exactly what to poke at.
    expect(areDocsEnabled(envsOf({ NODE_ENV: "production" }))).toBe(false);
  });

  it("lets DOCS_ENABLED decide in both directions", () => {
    expect(areDocsEnabled(envsOf({ NODE_ENV: "production", DOCS_ENABLED: "true" }))).toBe(true);
    expect(areDocsEnabled(envsOf({ NODE_ENV: "development", DOCS_ENABLED: "false" }))).toBe(false);
  });
});
