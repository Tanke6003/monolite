// The toolkit's promise is that a module behaves the same way on top of any
// engine. The place where it used to break was exactly here: only Oracle errors
// were translated, so a duplicate came back as a 409 on Oracle and as a 500
// everywhere else.
//
// The doubles in this suite are not made up: they reproduce the exact shape each
// driver hands the error over in —checked against the five real engines—,
// including the wrapper Sequelize puts in `parent`/`original` and the one the
// repository puts in `cause`.
import { AppError, causeChain, normalizeError } from "@monolite/core";

/** Oracle driver error: the code travels in `code` and in the message. */
const oracle = (code: string, message = "") =>
  Object.assign(new Error(`ORA-${code}: ${message}`), { code: `ORA-${code}` });

/** tedious error: a generic `code` and the T-SQL number in `number`. */
const sqlServer = (number: number, message = "") =>
  Object.assign(new Error(message), { code: "EREQUEST", number });

/** pg error: `code` is the SQLSTATE. */
const postgres = (sqlstate: string, message = "") =>
  Object.assign(new Error(message), { code: sqlstate });

/** mysql2 error: a numeric `errno` and a symbolic `code`. */
const mysql = (errno: number, code: string, message = "") =>
  Object.assign(new Error(message), { code, errno, sqlState: "23000" });

/** Mongo driver error: its own class name and a numeric code. */
const mongo = (code: number, message = "") =>
  Object.assign(new Error(message), { name: "MongoServerError", code });

/** How it really arrives: the repository wraps it, and Sequelize wrapped it first. */
const asItArrives = (driver: Error, sequelizeClass = "SequelizeDatabaseError") => {
  const sequelizeWrapper = Object.assign(new Error(driver.message), {
    name: sequelizeClass,
    parent: driver,
    original: driver,
  });
  return new Error("BranchesRepository.insert failed.", { cause: sequelizeWrapper });
};

describe("normalizeError — driver errors", () => {
  // =======================================================  parity  =========
  // The same client mistake has to answer the same way on all five engines.
  describe("the same failure answers the same way whichever engine it came from", () => {
    it("a duplicate is 409 DB_UNIQUE_VIOLATION on every engine", () => {
      const cases = [
        new Error("wrap", { cause: oracle("00001", "unique constraint violated") }),
        asItArrives(
          sqlServer(2627, "Violation of PRIMARY KEY constraint"),
          "SequelizeUniqueConstraintError"
        ),
        asItArrives(
          postgres("23505", "duplicate key value violates unique constraint"),
          "SequelizeUniqueConstraintError"
        ),
        asItArrives(
          mysql(1062, "ER_DUP_ENTRY", "Duplicate entry '1' for key"),
          "SequelizeUniqueConstraintError"
        ),
        new Error("wrap", { cause: mongo(11000, "E11000 duplicate key error collection") }),
      ];

      for (const failure of cases) {
        expect(normalizeError(failure)).toMatchObject({
          statusCode: 409,
          code: "DB_UNIQUE_VIOLATION",
          isOperational: true,
        });
      }
    });

    it("a required field left null is 400 DB_NOT_NULL_VIOLATION on every engine", () => {
      const cases = [
        new Error("wrap", { cause: oracle("01400", "cannot insert NULL") }),
        asItArrives(sqlServer(515, "Cannot insert the value NULL into column 'NAME'")),
        asItArrives(postgres("23502", 'null value in column "name" violates not-null constraint')),
        asItArrives(mysql(1048, "ER_BAD_NULL_ERROR", "Column 'NAME' cannot be null")),
      ];

      for (const failure of cases) {
        expect(normalizeError(failure)).toMatchObject({
          statusCode: 400,
          code: "DB_NOT_NULL_VIOLATION",
        });
      }
    });

    it("a value longer than the column is 400 DB_VALUE_TOO_LARGE on every engine", () => {
      const cases = [
        new Error("wrap", { cause: oracle("12899", "value too large for column") }),
        asItArrives(sqlServer(2628, "String or binary data would be truncated")),
        asItArrives(postgres("22001", "value too long for type character varying(100)")),
        asItArrives(mysql(1406, "ER_DATA_TOO_LONG", "Data too long for column 'NAME'")),
      ];

      for (const failure of cases) {
        expect(normalizeError(failure)).toMatchObject({
          statusCode: 400,
          code: "DB_VALUE_TOO_LARGE",
        });
      }
    });

    it("a value that fails a CHECK constraint is 400 DB_CHECK_VIOLATION on every engine", () => {
      const cases = [
        new Error("wrap", { cause: oracle("02290", "check constraint violated") }),
        asItArrives(postgres("23514", 'new row violates check constraint "CK_QTY"')),
        asItArrives(mysql(3819, "ER_CHECK_CONSTRAINT_VIOLATED", "Check constraint is violated")),
        new Error("wrap", { cause: mongo(121, "Document failed validation") }),
      ];

      for (const failure of cases) {
        expect(normalizeError(failure)).toMatchObject({
          statusCode: 400,
          code: "DB_CHECK_VIOLATION",
        });
      }
    });
  });

  // =============================================  direction of a foreign key ==
  // Oracle and MySQL use one code per direction; PostgreSQL and SQL Server reuse
  // a single one, so the message has to be inspected in order not to hand back
  // the opposite status.
  describe("the direction of a foreign key", () => {
    it("pointing at a parent that does not exist is 400", () => {
      const cases = [
        new Error("wrap", { cause: oracle("02291", "parent key not found") }),
        asItArrives(mysql(1452, "ER_NO_REFERENCED_ROW_2", "Cannot add or update a child row")),
        asItArrives(
          postgres(
            "23503",
            'insert or update on table "appointments" violates foreign key constraint'
          ),
          "SequelizeForeignKeyConstraintError"
        ),
        asItArrives(
          sqlServer(
            547,
            'The INSERT statement conflicted with the FOREIGN KEY constraint "FK_APPT_BRANCH"'
          ),
          "SequelizeForeignKeyConstraintError"
        ),
      ];

      for (const failure of cases) {
        expect(normalizeError(failure)).toMatchObject({
          statusCode: 400,
          code: "DB_REFERENCE_NOT_FOUND",
        });
      }
    });

    it("deleting a parent that still has children is 409", () => {
      const cases = [
        new Error("wrap", { cause: oracle("02292", "child record found") }),
        asItArrives(mysql(1451, "ER_ROW_IS_REFERENCED_2", "Cannot delete or update a parent row")),
        asItArrives(postgres("23503", 'is still referenced from table "appointments"')),
        asItArrives(sqlServer(547, "The DELETE statement conflicted with the REFERENCE constraint")),
      ];

      for (const failure of cases) {
        expect(normalizeError(failure)).toMatchObject({
          statusCode: 409,
          code: "DB_REFERENCE_IN_USE",
        });
      }
    });
  });

  // ========================================================  unavailable  ====
  describe("the database does not answer", () => {
    it("recognises each engine's unavailability codes", () => {
      const cases = [
        new Error("wrap", { cause: oracle("12541", "TNS:no listener") }),
        asItArrives(postgres("57P03", "the database system is starting up")),
        asItArrives(mysql(1042, "ER_GET_HOSTNAME", "Can't get hostname")),
        asItArrives(sqlServer(4060, "Cannot open database")),
      ];

      for (const failure of cases) {
        expect(normalizeError(failure)).toMatchObject({
          statusCode: 503,
          code: "DB_UNAVAILABLE",
          // It is operational: nothing in the code is broken, the database is
          // simply not there.
          isOperational: true,
        });
      }
    });

    it("recognises the connection failure by Sequelize's class name, with no code", () => {
      const withoutCode = Object.assign(new Error("connect ECONNREFUSED"), {
        name: "SequelizeConnectionRefusedError",
      });

      expect(normalizeError(new Error("wrap", { cause: withoutCode }))).toMatchObject({
        statusCode: 503,
        code: "DB_UNAVAILABLE",
      });
    });

    it("recognises the Mongo driver's network failure", () => {
      const network = Object.assign(new Error("connection timed out"), {
        name: "MongoServerSelectionError",
      });

      expect(normalizeError(network)).toMatchObject({ statusCode: 503, code: "DB_UNAVAILABLE" });
    });

    it("recognises a socket that never even opened", () => {
      const socket = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

      expect(normalizeError(socket)).toMatchObject({ statusCode: 503, code: "DB_UNAVAILABLE" });
    });
  });

  // =====================================================  not the client's  ==
  describe("what the client did not cause", () => {
    it("an engine failure that is not in the table is 500 and not operational", () => {
      const cases = [
        new Error("wrap", { cause: oracle("00942", "table or view does not exist") }),
        asItArrives(postgres("42601", "syntax error at or near")),
        asItArrives(mysql(1146, "ER_NO_SUCH_TABLE", "Table 'testdb.NOPE' doesn't exist")),
        asItArrives(sqlServer(208, "Invalid object name 'NOPE'")),
      ];

      for (const failure of cases) {
        expect(normalizeError(failure)).toMatchObject({
          statusCode: 500,
          code: "DB_ERROR",
          isOperational: false,
        });
      }
    });

    // The engine's message must not reach the client: it can name tables,
    // columns and constraints.
    it("does not leak the engine's message", () => {
      const result = normalizeError(asItArrives(postgres("42601", 'syntax error at or near "SLECT"')));

      expect(result.message).toBe("Error while accessing the database.");
    });

    it("an ordinary error is still a generic 500", () => {
      expect(normalizeError(new Error("something broke"))).toMatchObject({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        isOperational: false,
      });
    });

    // A five-letter system code is not a SQLSTATE.
    it("does not mistake a system code for a SQLSTATE", () => {
      const systemError = Object.assign(new Error("argument list too long"), { code: "E2BIG" });

      expect(normalizeError(systemError).code).toBe("INTERNAL_ERROR");
    });
  });

  // ===========================================================  the chain  ===
  describe("the cause chain", () => {
    // Sequelize leaves the driver error in `parent`, not in `cause`, so walking
    // the causes alone would never reach it.
    it("reaches the driver through parent, not only through cause", () => {
      expect(normalizeError(asItArrives(postgres("23505", "duplicate key"))).code).toBe(
        "DB_UNIQUE_VIOLATION"
      );
    });

    it("prefers the specific link over the generic one", () => {
      // Sequelize's wrapper says nothing useful; the inner one does.
      const nested = new Error("layer 1", {
        cause: new Error("layer 2", {
          cause: asItArrives(mysql(1062, "ER_DUP_ENTRY", "Duplicate entry")),
        }),
      });

      expect(normalizeError(nested).code).toBe("DB_UNIQUE_VIOLATION");
    });

    it("does not loop when the chain refers to itself", () => {
      const loop: Error & { parent?: unknown } = new Error("cycle");
      loop.parent = loop;

      expect(normalizeError(loop).statusCode).toBe(500);
    });

    it("causeChain walks the causes outwards-in and stops at the configured depth", () => {
      const innermost = new Error("innermost");
      const middle = new Error("middle", { cause: innermost });
      const outermost = new Error("outermost", { cause: middle });

      expect(causeChain(outermost)).toEqual([outermost, middle, innermost]);
      expect(causeChain(outermost, 2)).toEqual([outermost, middle]);
      expect(causeChain(undefined)).toEqual([]);
    });
  });
});

describe("normalizeError — everything that is not a driver", () => {
  it("an AppError passes through with its status, its code and its detail", () => {
    const error = new AppError("The slot is already taken", 409, true, {
      code: "APPOINTMENT_OVERLAP",
      errors: [{ field: "startsAt", message: "Already booked." }],
    });

    expect(normalizeError(error)).toEqual({
      statusCode: 409,
      code: "APPOINTMENT_OVERLAP",
      message: "The slot is already taken",
      errors: [{ field: "startsAt", message: "Already booked." }],
      isOperational: true,
    });
  });

  it("an AppError without a code gets one derived from its status", () => {
    expect(normalizeError(new AppError("Nope", 404)).code).toBe("NOT_FOUND");
    expect(normalizeError(new AppError("Nope", 418)).code).toBe("REQUEST_ERROR");
    expect(normalizeError(new AppError("Nope", 502)).code).toBe("INTERNAL_ERROR");
  });

  it("an AppError keeps its `isOperational: false`, which is what deserves an alarm", () => {
    expect(normalizeError(new AppError("Boom", 500, false)).isOperational).toBe(false);
  });

  // The kernel has no zod dependency, so it cannot do `instanceof ZodError`: it
  // recognises the failure by its shape. That keeps the mapping working whichever
  // zod version the package that validates happens to install.
  describe("a validation failure recognised by its shape, not by `instanceof`", () => {
    const zodLike = (issues: { path: PropertyKey[]; message: string }[]) =>
      Object.assign(new Error("Invalid input"), { name: "ZodError", issues });

    it("turns every issue into a per-field detail", () => {
      expect(
        normalizeError(
          zodLike([
            { path: ["branch", "name"], message: "Required" },
            { path: ["qty"], message: "Expected number" },
          ])
        )
      ).toEqual({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        errors: [
          { field: "branch.name", message: "Required" },
          { field: "qty", message: "Expected number" },
        ],
        isOperational: true,
      });
    });

    // An empty path means the failure is about the payload as a whole —a body
    // that is not an object at all— and the client still needs something to
    // attach the message to.
    it("names the whole body when the issue has no path", () => {
      expect(normalizeError(zodLike([{ path: [], message: "Expected object" }])).errors).toEqual([
        { field: "(body)", message: "Expected object" },
      ]);
    });

    it("an array index in the path becomes part of the field name", () => {
      expect(
        normalizeError(zodLike([{ path: ["items", 0, "qty"], message: "Required" }])).errors
      ).toEqual([{ field: "items.0.qty", message: "Required" }]);
    });

    it("something merely named ZodError without issues is not a validation failure", () => {
      const impostor = Object.assign(new Error("nope"), { name: "ZodError" });

      expect(normalizeError(impostor).code).toBe("INTERNAL_ERROR");
    });
  });

  // Recognising the body parser by `type` keeps the kernel free of any framework
  // import.
  describe("body parser failures", () => {
    it("a malformed JSON body is 400 MALFORMED_JSON", () => {
      const error = Object.assign(new SyntaxError("Unexpected token }"), {
        type: "entity.parse.failed",
        status: 400,
      });

      expect(normalizeError(error)).toMatchObject({
        statusCode: 400,
        code: "MALFORMED_JSON",
        isOperational: true,
      });
    });

    it("a body over the limit is 413 PAYLOAD_TOO_LARGE", () => {
      const error = Object.assign(new Error("request entity too large"), {
        type: "entity.too.large",
        status: 413,
      });

      expect(normalizeError(error)).toMatchObject({
        statusCode: 413,
        code: "PAYLOAD_TOO_LARGE",
      });
    });
  });

  describe("token failures", () => {
    it("an expired token is 401 TOKEN_EXPIRED", () => {
      const error = Object.assign(new Error("jwt expired"), { name: "TokenExpiredError" });

      expect(normalizeError(error)).toMatchObject({ statusCode: 401, code: "TOKEN_EXPIRED" });
    });

    it("a malformed or not-yet-valid token is 401 INVALID_TOKEN", () => {
      for (const name of ["JsonWebTokenError", "NotBeforeError"]) {
        const error = Object.assign(new Error("bad token"), { name });

        expect(normalizeError(error)).toMatchObject({ statusCode: 401, code: "INVALID_TOKEN" });
      }
    });
  });

  it("something thrown that is not even an Error is still a generic 500", () => {
    expect(normalizeError("a bare string")).toMatchObject({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      isOperational: false,
    });
  });
});
