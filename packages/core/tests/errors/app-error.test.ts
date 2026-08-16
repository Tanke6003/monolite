import { AppError } from "monolite-core";

describe("AppError", () => {
  it("should create an error with the given message and statusCode", () => {
    const err = new AppError("Not found", 404);

    expect(err.message).toBe("Not found");
    expect(err.statusCode).toBe(404);
    expect(err.isOperational).toBe(true);
    expect(err.name).toBe("AppError");
    expect(err).toBeInstanceOf(Error);
  });

  it("should default statusCode to 500 when not provided", () => {
    const err = new AppError("Something failed");

    expect(err.statusCode).toBe(500);
  });

  it("should default isOperational to true", () => {
    const err = new AppError("Oops");
    expect(err.isOperational).toBe(true);
  });

  it("should accept a custom isOperational flag", () => {
    const err = new AppError("Critical failure", 500, false);
    expect(err.isOperational).toBe(false);
  });

  it("carries the stable code and the per-field detail through the options", () => {
    const err = new AppError("Validation failed", 400, true, {
      code: "APPOINTMENT_OVERLAP",
      errors: [{ field: "startsAt", message: "The slot is already taken." }],
    });

    expect(err.code).toBe("APPOINTMENT_OVERLAP");
    expect(err.errors).toEqual([{ field: "startsAt", message: "The slot is already taken." }]);
  });

  // `cause` is what lets the global handler still recognise an ORA-00001 after
  // two layers of repository have wrapped the driver error.
  it("chains the original error instead of discarding it", () => {
    const original = new Error("ORA-00001: unique constraint violated");
    const err = new AppError("Could not save the branch", 409, true, { cause: original });

    expect(err.cause).toBe(original);
  });

  it("leaves `cause` absent when none was supplied", () => {
    expect(new AppError("Oops").cause).toBeUndefined();
  });
});
