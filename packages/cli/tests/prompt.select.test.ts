import { PassThrough } from "node:stream";

import { Prompter } from "../src/util/prompt";

/**
 * The arrow-driven list, driven.
 *
 * Its sibling file tests the key handling as pure functions and says the
 * plumbing around it is not worth faking. That was true right up until the
 * plumbing shipped broken: the list rendered perfectly, and then ignored every
 * key — because the interface was paused to keep it off the stream, and a
 * paused stream emits no data, so no `keypress` ever arrived. Every pure test
 * in this package passed while `monolite new` could not get past its first
 * question.
 *
 * So this file fakes a terminal after all. Not to assert on cursor codes, but
 * to answer the one question those tests could not: does pressing a key do
 * anything at all.
 */

function fakeTerminal() {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;

  const written: string[] = [];
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  output.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream["write"];

  return { input, output, written };
}

/**
 * Built from the char code the way the source does it: a literal ESC byte does
 * not survive editors, patches and copy/paste reliably.
 */
const ESC = String.fromCharCode(27);

/** Lets the prompt render and attach its listener before a key is sent. */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const CHOICES = [
  { value: "sql", label: "SQL" },
  { value: "nosql", label: "NoSQL" },
  { value: "none", label: "None" },
];

describe("Prompter.select over a terminal", () => {
  it("answers Enter rather than hanging on it", async () => {
    const { input, output } = fakeTerminal();
    const prompter = new Prompter(input, output);

    const answer = prompter.select("Database family", CHOICES, 2);
    await settled();
    input.write("\r");

    await expect(answer).resolves.toBe("none");
    prompter.close();
  });

  it("moves the highlight with the arrows before accepting", async () => {
    const { input, output } = fakeTerminal();
    const prompter = new Prompter(input, output);

    const answer = prompter.select("Database family", CHOICES, 2);
    await settled();

    // Up from the last row lands on NoSQL.
    input.write(`${ESC}[A`);
    await settled();
    input.write("\r");

    await expect(answer).resolves.toBe("nosql");
    prompter.close();
  });

  it("takes j and k as well, for the people who type them without thinking", async () => {
    const { input, output } = fakeTerminal();
    const prompter = new Prompter(input, output);

    const answer = prompter.select("Database family", CHOICES, 0);
    await settled();
    input.write("j");
    await settled();
    input.write("\r");

    await expect(answer).resolves.toBe("nosql");
    prompter.close();
  });

  it("keeps working for the question after it", async () => {
    // The list borrows the stream from the readline interface and has to give
    // it back. If it does not, the next question is the one that hangs, and
    // the bug simply moves down the wizard by one.
    const { input, output } = fakeTerminal();
    const prompter = new Prompter(input, output);

    const family = prompter.select("Database family", CHOICES, 2);
    await settled();
    input.write("\r");
    await family;

    const after = prompter.text("Author", { default: "" });
    await settled();
    input.write("tanke6003\r");

    await expect(after).resolves.toBe("tanke6003");
    prompter.close();
  });

  it("draws every choice and its hint", async () => {
    const { input, output, written } = fakeTerminal();
    const prompter = new Prompter(input, output);

    const answer = prompter.select(
      "Database family",
      [{ value: "none", label: "None (in-memory)", hint: "no driver, no container" }],
      0
    );
    await settled();
    input.write("\r");
    await answer;

    const screen = written.join("");
    expect(screen).toContain("Database family");
    expect(screen).toContain("None (in-memory)");
    expect(screen).toContain("no driver, no container");
    prompter.close();
  });
});

/**
 * Pressing Enter through the whole wizard has to give a project, not an error.
 * Every question offers a default for exactly that reason, and the licence is
 * the one where taking it silently is most likely to be what was meant.
 */
describe("Prompter.text on an empty answer", () => {
  it("takes the default, so Enter through the wizard works", async () => {
    const { input, output } = fakeTerminal();
    const prompter = new Prompter(input, output);

    const answer = prompter.text("License", { default: "MIT" });
    await settled();
    input.write("\r");

    await expect(answer).resolves.toBe("MIT");
    prompter.close();
  });

  it("asks again instead of accepting an answer that fails validation", async () => {
    const { input, output, written } = fakeTerminal();
    const prompter = new Prompter(input, output);

    const answer = prompter.text("License", {
      default: "MIT",
      validate: (value) => (value === "yes" ? "which license, not whether" : null),
    });

    await settled();
    input.write("yes\r");
    await settled();
    input.write("Apache-2.0\r");

    await expect(answer).resolves.toBe("Apache-2.0");
    expect(written.join("")).toContain("which license, not whether");
    prompter.close();
  });
});
