import { spawnSync } from "node:child_process";
import { color } from "./colors.js";
import { fail, step } from "./log.js";

/**
 * Runs an external command inside the freshly generated project.
 *
 * `shell: true` on Windows is not a shortcut, it is the only way `npm` and `git`
 * resolve: both ship as `.cmd` shims there, and `spawn` without a shell looks
 * for an extensionless executable and fails with ENOENT. The arguments are ours
 * —a package manager name from a closed list and fixed subcommands— so the
 * usual injection objection does not apply here.
 */
export function run(command: string, args: string[], cwd: string): boolean {
  step(`${command} ${args.join(" ")}`);

  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

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
