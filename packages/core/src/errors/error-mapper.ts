import { AppError, type ErrorDetail } from "./app-error.js";

/**
 * The normalised shape of any error that reaches the global handler: the HTTP
 * layer does not have to know whether it came from a schema validator, from the
 * Oracle driver or from a loose `throw`.
 */
export interface NormalizedError {
  statusCode: number;
  /** Stable code, meant for the client to branch on. */
  code: string;
  message: string;
  errors?: ErrorDetail[];
  /** `false` marks the failures we did not expect and that deserve an alarm in the log. */
  isOperational: boolean;
}

/**
 * Walks the `cause` chain. Repositories wrap their errors so that driver details
 * do not leak upwards, which means the real reason sits several levels in.
 */
export function causeChain(error: unknown, maxDepth = 10): unknown[] {
  const chain: unknown[] = [];
  let current = error;

  for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth++) {
    chain.push(current);
    current = current instanceof Error ? (current.cause as unknown) : undefined;
  }

  return chain;
}

// ===========================================================  engines  ======
//
// A failure the caller provoked —a duplicate, a reference that does not exist—
// has to be answered the same way no matter which engine raised it: if Oracle
// gives back a 409 and PostgreSQL a 500, the promise that a module behaves
// identically on top of any engine breaks precisely where it is most visible.
//
// That is why the mapping is not "one case per driver code" but six shared
// outcomes, with every engine translating its own codes into them.

interface DriverFailure {
  statusCode: number;
  code: string;
  message: string;
}

const UNIQUE: DriverFailure = {
  statusCode: 409,
  code: "DB_UNIQUE_VIOLATION",
  message: "A record with those values already exists.",
};
const NOT_NULL: DriverFailure = {
  statusCode: 400,
  code: "DB_NOT_NULL_VIOLATION",
  message: "A required field is missing.",
};
const CHECK: DriverFailure = {
  statusCode: 400,
  code: "DB_CHECK_VIOLATION",
  message: "The data does not satisfy a table constraint.",
};
const REFERENCE_NOT_FOUND: DriverFailure = {
  statusCode: 400,
  code: "DB_REFERENCE_NOT_FOUND",
  message: "The referenced record does not exist.",
};
const REFERENCE_IN_USE: DriverFailure = {
  statusCode: 409,
  code: "DB_REFERENCE_IN_USE",
  message: "Cannot delete: other records depend on this one.",
};
const VALUE_TOO_LARGE: DriverFailure = {
  statusCode: 400,
  code: "DB_VALUE_TOO_LARGE",
  message: "A value exceeds the allowed length.",
};

const UNAVAILABLE: DriverFailure = {
  statusCode: 503,
  code: "DB_UNAVAILABLE",
  message: "The database is not available at the moment.",
};

/** What is not the caller's fault: schema, permissions, malformed SQL. */
const OUR_FAULT: NormalizedError = {
  statusCode: 500,
  code: "DB_ERROR",
  message: "Error while accessing the database.",
  isOperational: false,
};

/** Oracle, by ORA number. */
const ORACLE_ERRORS: Record<string, DriverFailure> = {
  "00001": UNIQUE,
  "01400": NOT_NULL,
  "02290": CHECK,
  "02291": REFERENCE_NOT_FOUND,
  "02292": REFERENCE_IN_USE,
  "12899": VALUE_TOO_LARGE,
};

/** Codes that mean "the database is not available", not "the caller got it wrong". */
const ORACLE_UNAVAILABLE = new Set([
  "01033",
  "03113",
  "03114",
  "12154",
  "12170",
  "12514",
  "12541",
]);

/** PostgreSQL, by SQLSTATE. */
const POSTGRES_ERRORS: Record<string, DriverFailure> = {
  "23505": UNIQUE,
  "23502": NOT_NULL,
  "23514": CHECK,
  "22001": VALUE_TOO_LARGE,
  "57P03": UNAVAILABLE,
  "08000": UNAVAILABLE,
  "08001": UNAVAILABLE,
  "08003": UNAVAILABLE,
  "08004": UNAVAILABLE,
  "08006": UNAVAILABLE,
};

/** MySQL / MariaDB, by `errno`. Unlike PostgreSQL it does tell apart the
 *  direction of a foreign key violation, the same way Oracle does. */
const MYSQL_ERRORS: Record<number, DriverFailure> = {
  1062: UNIQUE,
  1169: UNIQUE,
  1048: NOT_NULL,
  1364: NOT_NULL,
  3819: CHECK,
  1452: REFERENCE_NOT_FOUND,
  1451: REFERENCE_IN_USE,
  1406: VALUE_TOO_LARGE,
  1042: UNAVAILABLE,
  1043: UNAVAILABLE,
};

/** SQL Server, by T-SQL error number. */
const SQLSERVER_ERRORS: Record<number, DriverFailure> = {
  2627: UNIQUE,
  2601: UNIQUE,
  515: NOT_NULL,
  547: CHECK, // refined below: 547 covers CHECK and both directions of the FK
  8152: VALUE_TOO_LARGE,
  2628: VALUE_TOO_LARGE,
  4060: UNAVAILABLE,
  40613: UNAVAILABLE,
};

/** MongoDB, by server code. */
const MONGO_ERRORS: Record<number, DriverFailure> = {
  11000: UNIQUE,
  11001: UNIQUE,
  121: CHECK, // the $jsonSchema validator rejected the document
};

/**
 * PostgreSQL and SQL Server reuse a single code for both directions of a
 * foreign key, while Oracle and MySQL keep them apart. Inserting a row that
 * points at a parent which does not exist is a 400 —what the client sent is
 * invalid— and deleting a parent that still has children is a 409. Without this
 * distinction the same situation would answer differently depending on the
 * engine, which is exactly what we are trying to avoid.
 */
function referenceDirection(text: string): DriverFailure {
  return /still referenced|DELETE statement conflicted|REFERENCE constraint/i.test(text)
    ? REFERENCE_IN_USE
    : REFERENCE_NOT_FOUND;
}

/** Connection errors from Sequelize and from the Mongo driver, by class name. */
const UNAVAILABLE_NAMES =
  /^(SequelizeConnection|SequelizeHostNotFound|SequelizeAccessDenied|MongoNetwork|MongoServerSelection|MongoNotConnected)/;

/** System codes: the process never even got to talk to the database. */
const UNAVAILABLE_SYSTEM = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"]);

interface DriverErrorShape {
  name?: string;
  code?: unknown;
  errno?: unknown;
  number?: unknown;
}

/**
 * Identifies a link of the chain by what it carries, not by the configured
 * engine: every driver leaves a distinct, recognisable fingerprint.
 */
function fromDriverLink(link: unknown): NormalizedError | null {
  if (!(link instanceof Error)) return null;

  const { name, code, errno, number: tsqlNumber } = link as unknown as DriverErrorShape;
  const text = link.message ?? "";

  if (name && UNAVAILABLE_NAMES.test(name)) return { ...UNAVAILABLE, isOperational: true };
  if (typeof code === "string" && UNAVAILABLE_SYSTEM.has(code)) {
    return { ...UNAVAILABLE, isOperational: true };
  }

  // Oracle: the code travels in `code` ("ORA-00001") and also in the message.
  const oracle = /ORA-(\d{5})/.exec(typeof code === "string" ? code : "") ?? /ORA-(\d{5})/.exec(text);
  if (oracle) {
    const known = ORACLE_ERRORS[oracle[1]];
    if (known) return { ...known, isOperational: true };
    if (ORACLE_UNAVAILABLE.has(oracle[1])) return { ...UNAVAILABLE, isOperational: true };
    return OUR_FAULT;
  }

  // SQL Server (tedious): a generic `code` with the real number in `number`.
  if (code === "EREQUEST" && typeof tsqlNumber === "number") {
    const known = SQLSERVER_ERRORS[tsqlNumber];
    if (!known) return OUR_FAULT;
    return { ...(tsqlNumber === 547 ? referenceDirection(text) : known), isOperational: true };
  }

  // MySQL / MariaDB (mysql2): a numeric `errno` plus a `code` starting with ER_.
  if (typeof errno === "number" && typeof code === "string" && code.startsWith("ER_")) {
    const known = MYSQL_ERRORS[errno];
    return known ? { ...known, isOperational: true } : OUR_FAULT;
  }

  // PostgreSQL (pg): `code` is the five-character SQLSTATE.
  if (typeof code === "string" && /^\d{2}[0-9A-Z]{3}$/.test(code)) {
    if (code === "23503") return { ...referenceDirection(text), isOperational: true };
    const known = POSTGRES_ERRORS[code];
    return known ? { ...known, isOperational: true } : OUR_FAULT;
  }

  // MongoDB: the driver uses numeric codes and its own class names.
  if (typeof name === "string" && name.startsWith("Mongo") && typeof code === "number") {
    const known = MONGO_ERRORS[code];
    return known ? { ...known, isOperational: true } : OUR_FAULT;
  }

  return null;
}

/**
 * Sequelize wraps the driver error and leaves it in `parent` and `original`,
 * not in `cause`, so walking the cause chain alone never reaches it.
 */
function driverChain(error: unknown): unknown[] {
  const seen = new Set<unknown>();
  const pending = [...causeChain(error)];
  const chain: unknown[] = [];

  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);

    if (current instanceof Error) {
      const raw = current as unknown as Record<string, unknown>;
      pending.push(raw.cause, raw.parent, raw.original);
    }
  }

  return chain;
}

/**
 * Walks the whole chain and returns the first link that is recognised. It
 * starts from the outside, but the most specific link is the one that wins: the
 * Sequelize wrapper only says "there is a connection error" or nothing at all,
 * while the driver's own error says exactly which one.
 */
function fromDriver(error: unknown): NormalizedError | null {
  let generic: NormalizedError | null = null;

  for (const link of driverChain(error)) {
    const identified = fromDriverLink(link);
    if (!identified) continue;
    if (identified.code === "DB_ERROR") {
      generic ??= identified;
      continue;
    }
    return identified;
  }

  return generic;
}

/**
 * The shape of a Zod validation failure, described structurally.
 *
 * The kernel stays dependency-free, so it cannot do `instanceof ZodError`.
 * Matching on the shape keeps the mapping working whichever Zod version the
 * package that validates happens to install, and it costs nothing: no other
 * error in the system calls itself `ZodError` and carries an `issues` array.
 */
interface ZodLikeError {
  name: string;
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}

function isZodLikeError(error: unknown): error is ZodLikeError {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    Array.isArray((error as unknown as { issues?: unknown }).issues)
  );
}

function fromZodLike(error: ZodLikeError): NormalizedError {
  return {
    statusCode: 400,
    code: "VALIDATION_ERROR",
    message: "Validation failed",
    errors: error.issues.map((issue) => ({
      // The path is empty when the failure is about the payload as a whole —a
      // body that is not an object at all— and the client still needs something
      // to attach the message to.
      field: issue.path.map((segment) => String(segment)).join(".") || "(body)",
      message: issue.message,
    })),
    isOperational: true,
  };
}

/**
 * Errors that HTTP body parsers (body-parser, and therefore Express) tag with
 * `type` and `status`. Recognising them by those two fields keeps the kernel
 * free of any framework import.
 */
function fromBodyParser(error: Error & { type?: string; status?: number }): NormalizedError | null {
  if (error.type === "entity.parse.failed") {
    return {
      statusCode: 400,
      code: "MALFORMED_JSON",
      message: "The request body is not valid JSON.",
      isOperational: true,
    };
  }

  if (error.type === "entity.too.large") {
    return {
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body exceeds the allowed size.",
      isOperational: true,
    };
  }

  return null;
}

function fromJwt(error: Error): NormalizedError | null {
  if (error.name === "TokenExpiredError") {
    return {
      statusCode: 401,
      code: "TOKEN_EXPIRED",
      message: "The token has expired.",
      isOperational: true,
    };
  }

  if (error.name === "JsonWebTokenError" || error.name === "NotBeforeError") {
    return {
      statusCode: 401,
      code: "INVALID_TOKEN",
      message: "The token is not valid.",
      isOperational: true,
    };
  }

  return null;
}

/** Default code derived from the status, so the client always gets one. */
function codeForStatus(statusCode: number): string {
  const byStatus: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    422: "UNPROCESSABLE_ENTITY",
    429: "TOO_MANY_REQUESTS",
    503: "SERVICE_UNAVAILABLE",
  };

  if (byStatus[statusCode]) return byStatus[statusCode];
  return statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR";
}

/**
 * Turns anything thrown inside the application into a coherent HTTP response.
 * The order matters: most specific first.
 */
export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code ?? codeForStatus(error.statusCode),
      message: error.message,
      errors: error.errors,
      isOperational: error.isOperational,
    };
  }

  if (isZodLikeError(error)) return fromZodLike(error);

  if (error instanceof Error) {
    const jwtError = fromJwt(error);
    if (jwtError) return jwtError;

    const bodyParserError = fromBodyParser(error);
    if (bodyParserError) return bodyParserError;

    // The whole chain is searched: the driver error arrives wrapped by the
    // repository and, on the engines that go through Sequelize, by it as well.
    const driverError = fromDriver(error);
    if (driverError) return driverError;
  }

  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "Internal server error",
    isOperational: false,
  };
}
