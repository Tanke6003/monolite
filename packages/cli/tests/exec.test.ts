import { shellCommandLine } from "../src/util/exec";

/**
 * The command line handed to `cmd.exe` on Windows, where `npm` and `git` are
 * `.cmd` shims that cannot be spawned without a shell.
 *
 * Node deprecated passing an argument array alongside `shell: true` (DEP0190)
 * because those arguments are concatenated rather than escaped — the warning
 * showed up on every scaffold that installed its dependencies. The answer here
 * is to build the line and refuse anything that would need quoting, so the
 * concatenation is provably harmless rather than argued to be.
 */
describe("shellCommandLine", () => {
  it("builds the line the two commands this CLI runs actually need", () => {
    expect(shellCommandLine("git", ["init", "--quiet"])).toBe("git init --quiet");
    expect(shellCommandLine("npm", ["install"])).toBe("npm install");
    expect(shellCommandLine("yarn", [])).toBe("yarn");
  });

  it("allows a plain path, which has no meaning to a shell", () => {
    expect(shellCommandLine("npm", ["install", "./local-package"])).toBe(
      "npm install ./local-package"
    );
  });

  /**
   * Refusing beats escaping. Quoting for `cmd.exe` is a well-known source of
   * subtle holes, and nothing this CLI runs has ever needed it.
   */
  it("refuses anything a shell would read as more than one word", () => {
    for (const argument of [
      "a b",
      "x&&whoami",
      "x|y",
      "x>out.txt",
      '"quoted"',
      "%PATH%",
      "$(id)",
      "a^b",
      "`id`",
    ]) {
      expect(() => shellCommandLine("npm", [argument])).toThrow(/refusing to pass/);
    }
  });

  it("holds the command itself to the same rule", () => {
    expect(() => shellCommandLine("npm && whoami", ["install"])).toThrow(/refusing to pass/);
  });
});
