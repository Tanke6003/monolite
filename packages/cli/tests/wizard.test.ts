import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";

import { newCommand } from "../src/commands/new";
import { Prompter } from "../src/util/prompt";

/**
 * `monolite new` with no flags: the wizard, answered one question at a time.
 *
 * This is the route two shipped bugs took. A choice list that answered no key
 * left the command unusable from its first question; a project written to the
 * directory the command was run from rather than the one it was named after
 * ended a completed wizard on "not empty". Neither was reachable by any test
 * in this package, because every one of them went through `--yes` and a full
 * set of flags — a different path through the same function.
 *
 * So this drives the questions themselves, and asserts on the one thing the
 * user is actually after: a project, in the folder they named.
 */

const SCRATCH = path.resolve(__dirname, "..", "..", "..", ".wizard-tests");

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

/**
 * A terminal that answers questions as they are asked.
 *
 * Driven by what is written rather than by a timer, so the test does not race
 * the prompt. A question is identified by its text up to the colon, which is
 * what makes it stable while readline redraws the same line with the answer
 * being typed into it — otherwise every keystroke would look like a new
 * question and get an answer of its own.
 */
function scriptedTerminal(answers: Record<string, string>) {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;

  const asked: string[] = [];
  let last = "";

  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  output.write = ((chunk: string) => {
    const plain = String(chunk).replace(ANSI, "");
    const marker = plain.indexOf("?");
    if (marker === -1) return true;

    const question = plain.slice(marker).split("\n")[0].split(":")[0].trim();
    if (question.length < 2 || question === last) return true;

    last = question;
    asked.push(question);

    const scripted = Object.entries(answers).find(([key]) => question.includes(key));
    const answer = scripted ? scripted[1] : "\r";

    setImmediate(() => input.write(answer));
    return true;
  }) as NodeJS.WriteStream["write"];

  return { input, output, asked };
}

describe("monolite new, answered at the prompts", () => {
  jest.setTimeout(60_000);

  const previousCwd = process.cwd();
  let exitCode: number;
  let asked: string[];

  beforeAll(async () => {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH, { recursive: true });
    process.chdir(SCRATCH);

    const terminal = scriptedTerminal({
      "Project name": "testapi\r",
      Author: "tanke6003\r",
    });
    asked = terminal.asked;

    const prompter = new Prompter(terminal.input, terminal.output);

    // The command reports to stdout, which here is only noise around the
    // assertions.
    const write = jest.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      exitCode = await newCommand(["--skip-install", "--skip-git"], prompter);
    } finally {
      write.mockRestore();
      prompter.close();
    }
  });

  afterAll(() => {
    process.chdir(previousCwd);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  });

  it("finishes rather than failing", () => {
    expect(exitCode).toBe(0);
  });

  /** The whole wizard, not just the questions before the first list. */
  it("gets past the choice list to the questions after it", () => {
    expect(asked).toEqual(expect.arrayContaining([expect.stringContaining("Database family")]));
    expect(asked).toEqual(expect.arrayContaining([expect.stringContaining("Package manager")]));
  });

  it("writes the project into a folder named after the answer", () => {
    expect(fs.existsSync(path.join(SCRATCH, "testapi", "package.json"))).toBe(true);
  });

  it("does not scatter the project across the directory it was run from", () => {
    expect(fs.existsSync(path.join(SCRATCH, "package.json"))).toBe(false);
    expect(fs.readdirSync(SCRATCH)).toEqual(["testapi"]);
  });

  it("puts the answers in the manifest it wrote", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SCRATCH, "testapi", "package.json"), "utf8")
    );

    expect(manifest.name).toBe("testapi");
    expect(manifest.author).toBe("tanke6003");
    // Enter on the licence question, which is what a default is for.
    expect(manifest.license).toBe("MIT");
  });
});
