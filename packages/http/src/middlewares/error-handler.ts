import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import {
  AppError,
  causeChain,
  normalizeError,
  type ILogger,
  type IRequestContext,
} from "monolite-core";
import { REQUEST_ID_HEADER } from "./request-context.js";

export interface ErrorHandlerOptions {
  /**
   * Where the failure is recorded. Optional because the handler must keep
   * answering even when there is no logger wired — a test that mounts the
   * middleware on its own, a boot that failed before the logger existed. A
   * request that fails silently is worse than one that fails unlogged.
   */
  logger?: ILogger;
  /** Used to enrich the record with the request id and the user behind it. */
  context?: IRequestContext;
  /**
   * Whether the stack trace and the cause chain travel in the response body.
   * Defaults to `false`: they are the most useful information for debugging
   * and the most dangerous to publish, so they are shown only to whoever asked
   * for them. `createApp` sets it from `EXPOSE_ERROR_DETAILS`
   * (`resolveExposeErrorDetails`). The log is not affected by it, and the
   * `requestId` in the response is what leads to its line.
   */
  exposeDebugInfo?: boolean;
}

/** The request id: from the context when it is active, otherwise from the header. */
function resolveRequestId(req: Request, context: IRequestContext | undefined): string | undefined {
  const fromContext = context?.getRequestId();
  if (fromContext) return fromContext;

  const header = req.headers?.[REQUEST_ID_HEADER];
  return typeof header === "string" ? header : undefined;
}

/** The flattened cause chain, which is where the real reason usually is. */
function describeCauses(error: unknown): string[] {
  return causeChain(error)
    .slice(1)
    .map((link) => (link instanceof Error ? `${link.name}: ${link.message}` : String(link)));
}

/**
 * Global error handler. It is the last middleware: every `next(err)` and every
 * exception thrown by a controller ends up here.
 *
 * Three responsibilities:
 *  1. Translate the error into a coherent HTTP response (`normalizeError`).
 *  2. Record it with all the context — request id, user, route, causes — so
 *     what happened can be reconstructed. The stack is recorded only for an
 *     unexpected failure; a rejection is logged without it.
 *  3. Leak no internal detail: an unexpected 5xx answers with a generic
 *     message, and the stack reaches the client only when `exposeDebugInfo`
 *     asks for it.
 */
export function errorHandler(options: ErrorHandlerOptions = {}): ErrorRequestHandler {
  const { logger, context, exposeDebugInfo = false } = options;

  return (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    const normalized = normalizeError(err);
    const requestId = resolveRequestId(req, context);
    const user = context?.getCurrentUser() ?? null;

    // Only a failure nobody meant carries its stack into the log. A 4xx is an
    // AppError created on purpose — by the 404, a validation, a BLL — and its
    // stack points into the router, saying nothing `code`, `path` and
    // `requestId` do not. The causes stay on every line: they are short, and
    // on a 409 the driver error behind it is what names the constraint.
    const unexpected = normalized.statusCode >= 500 || !normalized.isOperational;

    const logPayload = {
      requestId,
      method: req.method,
      path: req.originalUrl ?? req.url,
      statusCode: normalized.statusCode,
      code: normalized.code,
      userId: user?.id ?? null,
      userName: user?.name ?? null,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      causes: describeCauses(err),
      ...(unexpected ? { stack: err instanceof Error ? err.stack : undefined } : {}),
    };

    // A 4xx is part of normal operation: it is recorded, but not as an alarm.
    if (unexpected) {
      logger?.error("Request failed", logPayload);
    } else {
      logger?.warn("Request rejected", logPayload);
    }

    // An unexpected 5xx must not describe the internal failure to the client.
    const exposeMessage = normalized.isOperational || normalized.statusCode < 500;

    const body: Record<string, unknown> = {
      status: "error",
      code: normalized.code,
      message: exposeMessage ? normalized.message : "Internal server error",
      requestId,
      timestamp: new Date().toISOString(),
      path: req.originalUrl ?? req.url,
      method: req.method,
    };

    if (normalized.errors?.length) body.errors = normalized.errors;

    if (exposeDebugInfo) {
      body.stack = err instanceof Error ? err.stack?.split("\n").map((line) => line.trim()) : undefined;
      const causes = describeCauses(err);
      if (causes.length > 0) body.causes = causes;
    }

    res.status(normalized.statusCode).json(body);
  };
}

/**
 * 404 for any unregistered route. It is mounted after every route and before
 * the error handler, so that a mistyped endpoint returns the same error shape
 * as the rest of the API instead of Express's HTML page.
 */
export const notFoundHandler: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  next(
    new AppError(`Cannot ${req.method} ${req.originalUrl ?? req.url}`, 404, true, {
      code: "ROUTE_NOT_FOUND",
    })
  );
};
