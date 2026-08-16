import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { AppError } from "monolite-core";
import { validateBody, validateQuery } from "monolite-http";

const schema = z.object({ name: z.string().min(1) });

 
let req: any;
 
let res: any;
let next: jest.Mock;

beforeEach(() => {
  res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  next = jest.fn();
});

const run = (middleware: ReturnType<typeof validateBody>) =>
  middleware(req as Request, res as Response, next as NextFunction);

describe("validateBody", () => {
  it("calls next when the body is valid", () => {
    req = { body: { name: "Alice" } };
    run(validateBody(schema));

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("replaces the body with what the schema parsed", () => {
    // Whatever the schema did not declare does not reach the handler, so an
    // unexpected field cannot be written by accident further down.
    req = { body: { name: "Alice", extra: "ignored" } };
    run(validateBody(schema));

    expect(req.body).toEqual({ name: "Alice" });
  });

  it("applies the schema's transformations, not just its checks", () => {
    req = { body: { name: " Alice " } };
    run(validateBody(z.object({ name: z.string().transform((value) => value.trim()) })));

    expect(req.body).toEqual({ name: "Alice" });
  });

  // It never answers on its own: it defers to the global handler so the shape of
  // a validation error is the shape of every other error in the API.
  it("hands an AppError 400 to the global handler when the body is invalid", () => {
    req = { body: {} };
    run(validateBody(schema));

    expect(res.status).not.toHaveBeenCalled();

    const error = next.mock.calls[0][0] as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
    });
  });

  it("names the offending field in the detail", () => {
    req = { body: {} };
    run(validateBody(schema));

    const error = next.mock.calls[0][0] as AppError;

    expect(error.errors?.[0]).toMatchObject({ field: "name", message: expect.any(String) });
  });

  it("joins a nested path with dots", () => {
    req = { body: { profile: {} } };
    run(validateBody(z.object({ profile: z.object({ city: z.string() }) })));

    expect((next.mock.calls[0][0] as AppError).errors?.[0].field).toBe("profile.city");
  });

  it("attributes a failure about the payload as a whole to `(body)`", () => {
    // A body that is not an object at all produces an issue with an empty path,
    // and the client still needs something to attach the message to.
    req = { body: "not an object" };
    run(validateBody(schema));

    expect((next.mock.calls[0][0] as AppError).errors?.[0].field).toBe("(body)");
  });
});

describe("validateQuery", () => {
  it("sets validatedQuery and calls next when the query is valid", () => {
    req = { query: { name: "Bob" } };
    run(validateQuery(schema));

    expect(next).toHaveBeenCalledWith();
    expect(req.validatedQuery).toEqual({ name: "Bob" });
  });

  /**
   * The parsed value goes to a property of its own rather than back into
   * `req.query`, because in Express 5 `req.query` is a getter with no setter and
   * assigning to it throws.
   */
  it("leaves req.query untouched", () => {
    req = { query: { page: "2" } };
    run(validateQuery(z.object({ page: z.coerce.number() })));

    expect(req.query).toEqual({ page: "2" });
    expect(req.validatedQuery).toEqual({ page: 2 });
  });

  it("hands an AppError 400 to the global handler when the query is invalid", () => {
    req = { query: {} };
    run(validateQuery(schema));

    expect(res.status).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
  });

  it("does not set validatedQuery when the query was rejected", () => {
    req = { query: {} };
    run(validateQuery(schema));

    expect(req.validatedQuery).toBeUndefined();
  });
});
