import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";
import { AppError } from "@monolite/core";

/**
 * Translates a Zod failure into the application error and hands it to the
 * global handler. That way a validation answers with the same shape — code,
 * request id, timestamp — as any other error in the API.
 */
function validationError(issues: { path: PropertyKey[]; message: string }[]): AppError {
  return new AppError("Validation failed", 400, true, {
    code: "VALIDATION_ERROR",
    errors: issues.map((issue) => ({
      field: issue.path.map(String).join(".") || "(body)",
      message: issue.message,
    })),
  });
}

export function validateBody(schema: ZodType): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(validationError(result.error.issues));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodType): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(validationError(result.error.issues));
      return;
    }
    // The parsed value goes to `validatedQuery` and not back into `req.query`
    // because in Express 5 `req.query` is a getter with no setter: assigning to
    // it throws. The concrete type depends on the schema that was handed in, so
    // the controller that consumes it is the one that asserts it (see
    // `src/types/express.d.ts`).
    req.validatedQuery = result.data;
    next();
  };
}
