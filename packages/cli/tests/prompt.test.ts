import { nextIndex, selectAction } from "../src/util/prompt";

/**
 * The arrow-driven list, tested through the part of it that holds the
 * behaviour.
 *
 * Raw mode, cursor movement and redrawing are not tested here: a test for
 * those would have to fake a TTY and would then be asserting on its own fake.
 * What can genuinely be wrong *here* is which key means what and where the
 * highlight lands, and both of those are plain functions.
 *
 * That reasoning went one step too far once. Every test in this file passed
 * while the list ignored every key it was sent, because nothing here ever sent
 * it one. `prompt.select.test.ts` fakes the terminal and does — it covers the
 * wiring, this covers the decisions.
 */
describe("selectAction", () => {
  it("reads the arrow keys and their vim equivalents", () => {
    expect(selectAction({ name: "up" })).toBe("up");
    expect(selectAction({ name: "k" })).toBe("up");
    expect(selectAction({ name: "down" })).toBe("down");
    expect(selectAction({ name: "j" })).toBe("down");
  });

  it("jumps to the ends", () => {
    expect(selectAction({ name: "home" })).toBe("first");
    expect(selectAction({ name: "pageup" })).toBe("first");
    expect(selectAction({ name: "end" })).toBe("last");
    expect(selectAction({ name: "pagedown" })).toBe("last");
  });

  it("accepts on enter and on space", () => {
    expect(selectAction({ name: "return" })).toBe("accept");
    expect(selectAction({ name: "enter" })).toBe("accept");
    expect(selectAction({ name: "space" })).toBe("accept");
  });

  /**
   * Raw mode swallows Ctrl+C, so a prompt that does not read it as an abort is
   * a prompt the user cannot leave. This is the assertion that matters most in
   * the file.
   */
  it("treats Ctrl+C, Ctrl+D and escape as an abort", () => {
    expect(selectAction({ name: "c", ctrl: true })).toBe("abort");
    expect(selectAction({ name: "d", ctrl: true })).toBe("abort");
    expect(selectAction({ name: "escape" })).toBe("abort");
  });

  it("ignores a plain letter, so typing does not move the highlight", () => {
    expect(selectAction({ name: "a" })).toBeNull();
    // `c` on its own is a letter; only with Ctrl is it the abort.
    expect(selectAction({ name: "c" })).toBeNull();
  });
});

describe("nextIndex", () => {
  it("moves within the list", () => {
    expect(nextIndex("down", 0, 4)).toBe(1);
    expect(nextIndex("up", 2, 4)).toBe(1);
  });

  it("wraps at both ends", () => {
    expect(nextIndex("up", 0, 4)).toBe(3);
    expect(nextIndex("down", 3, 4)).toBe(0);
  });

  it("jumps to either end", () => {
    expect(nextIndex("first", 2, 4)).toBe(0);
    expect(nextIndex("last", 1, 4)).toBe(3);
  });

  it("stays put on anything that is not a movement", () => {
    expect(nextIndex("accept", 2, 4)).toBe(2);
    expect(nextIndex(null, 2, 4)).toBe(2);
  });

  it("survives a single-item list, where every move is a no-op", () => {
    expect(nextIndex("up", 0, 1)).toBe(0);
    expect(nextIndex("down", 0, 1)).toBe(0);
  });
});
