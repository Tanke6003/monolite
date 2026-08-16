import { AppError } from "monolite-core";
import { parseId } from "monolite-http";

describe("parseId", () => {
  it("accepts positive integers", () => {
    expect(parseId("1", "branch")).toBe(1);
    expect(parseId("42", "branch")).toBe(42);
  });

  // `Number("")` is 0 and `Number(" 3 ")` is 3, so `isNaN` on its own is not
  // enough: without demanding a positive integer, `/branches/` would query for
  // id 0 and `/branches/ 3 ` would quietly work.
  it.each([undefined, "", "   ", "abc", "0", "-1", "1.5", "1e3abc"])(
    "rejects %p with a 400",
    (raw) => {
      expect(() => parseId(raw as string | undefined, "branch")).toThrow(/Invalid branch ID/);
    }
  );

  it("names the resource in the message", () => {
    expect(() => parseId("x", "appointment")).toThrow("Invalid appointment ID");
  });

  // It fails as an application error, not as a bare `Error`, so the global
  // handler answers 400 instead of turning a mistyped URL into a 500.
  it("fails with an AppError carrying a 400", () => {
    expect(() => parseId("abc", "branch")).toThrow(AppError);

    try {
      parseId("abc", "branch");
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400 });
    }
  });
});
