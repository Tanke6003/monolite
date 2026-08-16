import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ILogger } from "monolite-core";
import { REQUEST_ID_HEADER } from "./request-context.js";

export interface HttpLoggerOptions {
  /**
   * Level used for a request that ended well. Failures do not use it: a 5xx is
   * logged as an error and a 4xx as a warning, whatever this says.
   */
  successLevel?: "info" | "debug";
  /** Message the record carries. Everything else travels as structured metadata. */
  message?: string;
}

/**
 * Access log, one record per finished request.
 *
 * It lives in this package and not behind the logging contract on purpose. The
 * original `ILogger` also exposed an `http()` factory that returned an Express
 * `RequestHandler`, and that single method dragged a whole HTTP framework into
 * the one contract every other package depends on. Request logging is a
 * transport concern, so only the levels stayed in the kernel and the middleware
 * came here.
 *
 * It logs on `finish` rather than on the way in, because that is the only
 * moment the status code — the single most useful field in an access log — is
 * known. The cost is that a request that never finishes leaves no record; the
 * error handler covers that case, since anything thrown still ends in a
 * response.
 *
 * The level is picked from the status so that grepping for errors finds them:
 * with a fixed level, a wall of 500s reads exactly like a wall of 200s. It also
 * avoids assuming the backend has a custom `http` level — pino does not.
 */
export function httpLogger(logger: ILogger, options: HttpLoggerOptions = {}): RequestHandler {
  const successLevel = options.successLevel ?? "info";
  const message = options.message ?? "http_access";

  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const { statusCode } = res;

      const payload = {
        type: "request",
        // Read from the response and not from the request: the context
        // middleware sets the header there, so this is the same id the error
        // response and the audit trail carry, even when the client sent none.
        requestId: res.getHeader(REQUEST_ID_HEADER),
        method: req.method,
        endpoint: req.originalUrl ?? req.url,
        status: statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      };

      if (statusCode >= 500) logger.error(message, payload);
      else if (statusCode >= 400) logger.warn(message, payload);
      else logger[successLevel](message, payload);
    });

    next();
  };
}
