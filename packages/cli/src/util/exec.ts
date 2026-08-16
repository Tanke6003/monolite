import { spawnSync } from "node:child_process";
import { color } from "./colors.js";
import { fail, step } from "./log.js";

/**
 * What a command line may contain before this refuses to build one.
 *
 * Deliberately narrow: letters, digits, and the punctuation a subcommand, a
 * flag or a plain path needs. No spaces, no quotes, no `&`, `|`, `^`, `>` or
 * `%` — nothing that means something to `cmd.exe`.
 */
const SHELL_SAFE = /^[A-Za-z0-9._:=/\\-]+$/;

/**
 * The single string a shell is handed.
 *
 * Node deprecated passing an argument array alongside `shell: true` (DEP0190)
 * for the good reason that the arguments are concatenated, not escaped — so a
 * command line is built here instead, and anything that would need escaping is
 * refused rather than escaped. Quoting for `cmd.exe` is a well-known source of
 * subtle holes, and this CLI never needs it: every argument it passes is a
 * subcommand or a flag it chose itself.
 *
 * The working directory is not part of this. It travels as `cwd`, which the
 * shell never sees, so a project in a path with spaces in it is unaffected.
 */
export function shellCommandLine(command: string, args: string[]): string {
  for (const part of [command, ...args]) {
    if (!SHELL_SAFE.test(part)) {
      throw new Error(`refusing to pass ${JSON.stringify(part)} through a shell`);
    }
  }

  return [command, ...args].join(" ");
}

/**
 * Runs an external command inside the freshly generated project.
 *
 * `shell: true` on Windows is not a shortcut, it is the only way `npm` and
 * `git` resolve: both ship as `.cmd` shims there, and since Node closed the
 * BatBadBut hole a `.cmd` cannot be spawned without one. Everywhere else the
 * arguments go straight to `execvp` with no shell in the middle, which is both
 * safer and what the deprecation asks for.
 */
export function run(command: string, args: string[], cwd: string): boolean {
  step(`${command} ${args.join(" ")}`);

  const options = { cwd, stdio: "inherit" } as const;

  let result;
  try {
    result =
      process.platform === "win32"
        ? spawnSync(shellCommandLine(command, args), { ...options, shell: true })
        : spawnSync(command, args, options);
  } catch (error) {
    fail(`could not run ${color.bold(command)}: ${(error as Error).message}`);
    return false;
  }

  if (result.error) {
    fail(`could not run ${color.bold(command)}: ${result.error.message}`);
    return false;
  }

  if (result.status !== 0) {
    fail(`${command} exited with code ${result.status}`);
    return false;
  }

  return true;
}
