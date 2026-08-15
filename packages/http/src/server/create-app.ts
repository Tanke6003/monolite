import path from "node:path";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Application, type RequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import type { IHealthProbe, ILogger, IRequestContext } from "@monolite/core";

import { resolveApiPrefix, resolveLegacyPrefix } from "../config/api.config.js";
import { processEnv, type EnvSource } from "../config/env-source.js";
import {
  buildCorsOptions,
  buildHelmetOptions,
  buildRateLimiter,
  resolveBodyLimit,
  resolveTrustProxy,
} from "../config/security.config.js";
import { errorHandler, notFoundHandler } from "../middlewares/error-handler.js";
import { httpLogger } from "../middlewares/http-logger.js";
import { requestContext } from "../middlewares/request-context.js";
import { registerControllers, type ControllerRegistration } from "../routing/router.builder.js";
import { healthRoutes } from "./health.routes.js";

export interface CreateAppOptions {
  /**
   * Where the configuration is read from. Defaults to `process.env`; a
   * different source is passed in when the application loads its own (dotenv, a
   * secrets client, a fixture in a test).
   */
  envs?: EnvSource;
  /** Where the access log and the failures are recorded. */
  logger: ILogger;
  /** The ambient request context this layer opens on every request. */
  context: IRequestContext;
  /**
   * Authentication middleware, applied to every route not marked `public`.
   *
   * It is mandatory and has no default, deliberately: the decorators close
   * every route unless it opts out, so a missing guard would silently open the
   * whole API. An API that really is public passes a pass-through here — and
   * then that decision is written down somewhere.
   */
  guard: RequestHandler;
  /**
   * Controllers to mount and who serves each one. Build it from the decorator
   * registry with `controllersFromRegistry(resolve)`, or hand over the list
   * explicitly in a test.
   */
  controllers?: ControllerRegistration[];
  /** Readiness probe. Without it only `/health/live` is published. */
  healthProbe?: IHealthProbe;
  /**
   * Directory served as static files, resolved against the working directory
   * when relative. Nothing is served if it is omitted.
   */
  staticDir?: string;
  /**
   * Content-Security-Policy directives, when `CSP_ENABLED=true` turns the
   * policy on. Defaults to the package's conservative set.
   */
  cspDirectives?: Record<string, string[]>;
  /**
   * Runs after the middleware chain and before the controllers. The place for
   * anything that must see every request but is not part of this layer.
   */
  beforeRoutes?: (app: Application) => void | Promise<void>;
  /**
   * Runs after the controllers and the health routes, and before the 404 and
   * the error handler. This is where the documentation goes — Swagger, Scalar,
   * `openapi.json` — because a 404 registered earlier would swallow it.
   */
  afterRoutes?: (app: Application) => void | Promise<void>;
}

export interface HttpApp {
  /** The Express application, for anything this factory does not cover. */
  readonly app: Application;
  /** Starts listening and resolves with the address it actually bound to. */
  listen(port: number): Promise<AddressInfo>;
  /** Stops accepting connections and waits for the in-flight requests. */
  close(): Promise<void>;
  /** The address it is listening on, or `null` if it is not listening. */
  readonly address: AddressInfo | null;
}

/**
 * Assembles the Express application: middleware chain, controllers, health and
 * error handling.
 *
 * The order of the chain is half the work: each piece assumes the previous ones
 * already ran, and moving them around leaves them without effect. The concrete
 * policy — quotas, origins, limits — lives in `security.config`; this function
 * only decides what goes where.
 *
 * Everything specific to an application arrives through the options. There is
 * no container here and no list of modules: which controllers exist, who serves
 * them and where the configuration comes from are the caller's to say.
 */
export async function createApp(options: CreateAppOptions): Promise<HttpApp> {
  const {
    envs = processEnv,
    logger,
    context,
    guard,
    controllers = [],
    healthProbe,
    staticDir,
    cspDirectives,
    beforeRoutes,
    afterRoutes,
  } = options;

  const app = express();

  // Saying which framework is underneath adds nothing and does point whoever is
  // looking for a known vulnerability in the right direction.
  app.disable("x-powered-by");

  // How many trusted proxies sit in front. Which IP the limiter sees depends on
  // this: set wrong, it either counts everyone as the load balancer or believes
  // whatever the client claims.
  app.set("trust proxy", resolveTrustProxy(envs));

  // First of all, even before the body is parsed: that way even a malformed
  // JSON is rejected with its request id, and every layer after this one —
  // logs, error handler, audit trail — sees the context.
  app.use(requestContext(context));

  // Before anything that answers, so the headers accompany a 429 or a CORS
  // rejection too.
  app.use(helmet(buildHelmetOptions(envs, cspDirectives)));

  // Before the parsing: a request that is going to be rejected does not get its
  // body read, which is exactly the work an abuse is trying to cause.
  const limiter = buildRateLimiter(envs);
  if (limiter) app.use(limiter);

  // Before the body as well: a preflight carries none.
  app.use(cors(buildCorsOptions(envs, logger)));

  const bodyLimit = resolveBodyLimit(envs);
  app.use(express.json({ limit: bodyLimit }));
  // `extended: false`: the native parser is enough unless the application
  // really sends nested form payloads, and the qs-based one is a larger surface
  // for no gain.
  app.use(express.urlencoded({ limit: bodyLimit, extended: false }));

  app.use(httpLogger(logger));

  if (staticDir) {
    app.use(express.static(path.resolve(process.cwd(), staticDir)));
  }

  await beforeRoutes?.(app);

  // Business routes, under the configured prefix and, while it is still active,
  // under the unversioned alias. When a v2 exists it will not come from
  // configuration: both versions will have to answer at the same time, so they
  // will be two routers mounted here.
  const apiPrefix = resolveApiPrefix(envs);
  const api = express.Router();
  registerControllers(api, controllers, guard);
  app.use(apiPrefix, api);

  const legacyPrefix = resolveLegacyPrefix(envs);
  if (legacyPrefix) app.use(legacyPrefix, api);

  app.use("/health", healthRoutes({ probe: healthProbe, apiPrefix }));

  await afterRoutes?.(app);

  // Registered last of all, after the business routes and after the
  // documentation: an error handler registered before a route does not cover
  // that route, and the 404 would swallow everything mounted after it.
  app.use(notFoundHandler);
  app.use(errorHandler({ logger, context }));

  /**
   * The HTTP server, so it can be closed. Without keeping it, an orderly
   * shutdown has no way to stop accepting connections and the in-flight
   * requests are cut mid-response.
   */
  let httpServer: http.Server | undefined;

  return {
    app,

    get address(): AddressInfo | null {
      const address = httpServer?.address();
      return address && typeof address !== "string" ? address : null;
    },

    listen(port: number): Promise<AddressInfo> {
      return new Promise<AddressInfo>((resolve, reject) => {
        const server = app.listen(port);
        httpServer = server;

        // `listening` and `error` race: binding to a port already in use emits
        // the second and the first never arrives, so waiting only for
        // `listening` would hang forever on the most common startup failure.
        server.once("error", reject);
        server.once("listening", () => {
          server.removeListener("error", reject);
          const address = server.address() as AddressInfo;
          logger.info("HTTP server listening", {
            port: address.port,
            api: apiPrefix,
            health: "/health/ready",
          });
          resolve(address);
        });
      });
    },

    /**
     * Stops accepting connections and waits for the in-flight requests to
     * finish.
     *
     * `close()` on its own is not enough: with keep-alive, an idle client holds
     * its connection open and the promise would not settle until it closes it.
     * `closeIdleConnections()` drops exactly those — the ones with no request
     * in progress — and lets the ones that do have one finish.
     */
    async close(): Promise<void> {
      const server = httpServer;
      if (!server) return;

      httpServer = undefined;

      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    },
  };
}
