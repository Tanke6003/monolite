import http from "node:http";
import type { AddressInfo } from "node:net";
import cors from "cors";
import express, { type Application, type Request, type Response } from "express";
import helmet from "helmet";
import type { IHealthProbe, ILogger, IRequestContext } from "@monolite/core";
import {
  buildOpenApiDocument,
  errorHandler,
  notFoundHandler,
  requestContext,
} from "@monolite/http";
import { container, TOKENS } from "./composition/container";
import { areDocsEnabled, readEnv, resolveApiPrefix, resolveCorsOrigins, toInt } from "./config/env";
import { registerRoutes } from "./presentation/routes";

/**
 * The HTTP surface, and it is yours.
 *
 * The toolkit deliberately does not own this file: which middleware runs, in
 * which order, and what the health endpoints answer are decisions that change
 * per deployment, and a framework that hid them would have to grow a
 * configuration option for each. What comes from `@monolite/http` is the part
 * that is genuinely the same everywhere — turning decorated controllers into
 * routes, and turning a thrown `AppError` into a response.
 */
export class Server {
  public readonly app: Application = express();
  private httpServer?: http.Server;

  constructor(private readonly port: number) {}

  /**
   * Middleware order is half the work here. Every piece assumes the ones before
   * it already ran, and moving one leaves it with nothing to do.
   */
  private configureMiddleware(): void {
    const logger = container.resolve<ILogger>(TOKENS.ILogger);
    const context = container.resolve<IRequestContext>(TOKENS.IRequestContext);

    // Naming the framework underneath adds nothing and points anyone looking
    // for a known vulnerability in the right direction.
    this.app.disable("x-powered-by");

    // How many trusted proxies sit in front. Get it wrong and anything that
    // works per client IP either sees only the load balancer or believes an
    // address the client chose for itself.
    this.app.set("trust proxy", toInt(readEnv("TRUST_PROXY_HOPS"), 0));

    // First of all, before the body is even parsed: this way a malformed JSON
    // is rejected with its own request id, and every layer after it —logs,
    // error handler, audit columns— sees the context.
    this.app.use(requestContext(context));

    // Before anything that answers, so the headers also travel with a rejected
    // CORS preflight.
    this.app.use(helmet());

    // Before the body parsers: a preflight carries no body.
    this.app.use(cors({ origin: resolveCorsOrigins(readEnv("CORS_ORIGINS")), credentials: true }));

    const bodyLimit = readEnv("BODY_LIMIT", "1mb");
    this.app.use(express.json({ limit: bodyLimit }));
    this.app.use(express.urlencoded({ limit: bodyLimit, extended: false }));

    this.app.use((req, _res, next) => {
      logger.debug("request", { method: req.method, url: req.originalUrl });
      next();
    });
  }

  /**
   * Business routes plus the two health questions.
   *
   * They are two questions and not one because an orchestrator does opposite
   * things with each: a process that is not *alive* gets restarted, a process
   * that is not *ready* gets taken out of rotation. With the database down the
   * second is the correct answer — restarting fixes nothing, and moving the
   * traffic sends it to a replica that can actually serve it.
   */
  private configureRoutes(): void {
    const probe = container.resolve<IHealthProbe>(TOKENS.IHealthProbe);
    const prefix = resolveApiPrefix(readEnv("API_PREFIX"));

    /** Liveness: says the process answers. It never touches the database. */
    this.app.get("/health/live", (_req: Request, res: Response) => {
      res.status(200).json({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
      });
    });

    /** Readiness: 503 while the database is down or the process is draining. */
    this.app.get("/health/ready", async (_req: Request, res: Response) => {
      const report = await probe.report();

      res.status(report.ready ? 200 : 503).json({
        status: report.ready ? "ok" : report.shuttingDown ? "shutting_down" : "degraded",
        dataSource: report.dataSource,
        database: report.database,
        // Published rather than assumed: `API_PREFIX` is configurable, so a
        // client can discover where this instance actually serves.
        apiPrefix: prefix,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
      });
    });

    this.app.use(prefix, registerRoutes());

    if (areDocsEnabled(readEnv("DOCS_ENABLED"), readEnv("NODE_ENV", "development"))) {
      // One document, generated from the same decorator metadata that produced
      // the routes, so the description cannot drift from the implementation.
      // Point Swagger UI or Scalar at this URL.
      this.app.get("/openapi.json", (_req: Request, res: Response) => {
        res.json(
          buildOpenApiDocument({
            title: "__serviceName__",
            version: "__projectVersion__",
            description: "__projectDescription__",
            // Published as the server rather than baked into every path, so
            // moving `API_PREFIX` keeps "Try it out" pointing at this instance.
            apiPrefix: prefix,
          })
        );
      });
    }
  }

  /**
   * Registered last, after the routes and the document: an error handler
   * mounted before a route does not cover that route, and the 404 would
   * swallow everything declared after it.
   */
  private configureErrorHandling(): void {
    this.app.use(notFoundHandler);

    // `errorHandler` is a factory and has to be called: handing Express the
    // factory itself registers a one-argument function, which it reads as
    // ordinary middleware rather than as an error handler — and every failure
    // then falls through to its default page, stack trace included.
    //
    // The logger and the context are what make a failure traceable: the log
    // line carries the same request id the client was given, and the user it
    // happened to.
    this.app.use(
      errorHandler({
        logger: container.resolve<ILogger>(TOKENS.ILogger),
        context: container.resolve<IRequestContext>(TOKENS.IRequestContext),
      })
    );
  }

  async run(): Promise<void> {
    this.configureMiddleware();
    this.configureRoutes();
    this.configureErrorHandling();

    const logger = container.resolve<ILogger>(TOKENS.ILogger);
    const prefix = resolveApiPrefix(readEnv("API_PREFIX"));

    await new Promise<void>((resolve) => {
      this.httpServer = this.app.listen(this.port, () => {
        const base = `http://localhost:${this.port}`;
        logger.info("Server listening", {
          port: this.port,
          api: `${base}${prefix}`,
          health: `${base}/health/ready`,
        });
        resolve();
      });
    });
  }

  /** Where it ended up listening, or `null` if it is not listening. */
  get address(): AddressInfo | null {
    const address = this.httpServer?.address();
    return address && typeof address !== "string" ? address : null;
  }

  /**
   * Stops accepting connections and waits for the in-flight requests.
   *
   * `close()` alone is not enough: with keep-alive, an idle client holds its
   * connection open and the promise would not settle until it decides to leave.
   * `closeIdleConnections()` drops exactly those and lets the busy ones finish.
   */
  async close(): Promise<void> {
    const server = this.httpServer;
    if (!server) return;

    this.httpServer = undefined;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
  }
}
