import path from "node:path";

import { targetDirectory } from "../src/commands/new";

/**
 * Where `monolite new` decides to put the project.
 *
 * The case in the middle came out of a real run: every question answered, the
 * project named `monolite-app` at the prompt, and then `x E:\ is not empty` —
 * because the directory had been fixed to the one the command was run from
 * before the name was ever asked for, and the answer never reached it.
 */
describe("targetDirectory", () => {
  const cwd = path.resolve("/work");

  it("uses the directory named on the command line", () => {
    expect(targetDirectory(cwd, "billing-api", "billing-api", false)).toBe(
      path.resolve(cwd, "billing-api")
    );
  });

  it("reads `.` as the plain instruction it is", () => {
    expect(targetDirectory(cwd, ".", "anything", false)).toBe(path.resolve(cwd));
  });

  it("puts a project named at the prompt into a folder of its own", () => {
    expect(targetDirectory(cwd, undefined, "monolite-app", true)).toBe(
      path.resolve(cwd, "monolite-app")
    );
  });

  /** `--yes` asked nobody anything, so the only directory it can mean is this one. */
  it("scaffolds in place when nobody was asked", () => {
    expect(targetDirectory(cwd, undefined, "work", false)).toBe(path.resolve(cwd));
  });

  it("still lets --directory win over a name given at the prompt", () => {
    expect(targetDirectory(cwd, "somewhere-else", "monolite-app", true)).toBe(
      path.resolve(cwd, "somewhere-else")
    );
  });
});
