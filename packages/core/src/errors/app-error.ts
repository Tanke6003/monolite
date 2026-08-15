/** Field-by-field validation detail. */
export interface ErrorDetail {
  field: string;
  message: string;
}

export interface AppErrorOptions {
  /** Stable code for the client, e.g. `APPOINTMENT_OVERLAP`. */
  code?: string;
  errors?: ErrorDetail[];
  /** The original error; kept so the root cause can still be diagnosed. */
  cause?: unknown;
}

export class AppError extends Error {
  public readonly code?: string;
  public readonly errors?: ErrorDetail[];

  constructor(
    public override readonly message: string,
    public readonly statusCode: number = 500,
    public readonly isOperational = true,
    options: AppErrorOptions = {}
  ) {
    // `cause` is standard as of ES2022: it chains the original error instead of
    // discarding it, which is what lets the global handler still recognise an
    // ORA-00001 even when two layers of repository have wrapped it.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.errors = options.errors;
    Error.captureStackTrace(this, this.constructor);
  }
}
