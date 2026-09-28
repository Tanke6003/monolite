/**
 * Runs one task from `src/tasks/`, by name.
 *
 *     __pmRun__ task advance-charges            # in development, through tsx
 *     node dist/scripts/task.js advance-charges # after a build: what a timer runs
 *
 * Every task goes through here, which is the point: the parts a hand-written
 * script forgets are written once, in `runTaskByName` from `monolite-di`.
 *
 * - **The exit code.** 0 when the task resolved, 1 when it threw or rejected —
 *   an `async main()` nobody awaited is how a failed job reports success.
 * - **The overlap guard.** A run that finds the previous one still going does
 *   not start, and exits 75 with a line saying who holds the lock and since
 *   when. A nightly job that takes longer than a night stops running twice.
 * - **The log.** One line when the task starts and one when it ends, with its
 *   name and how long it took, through the same logger the server uses.
 * - **The connections.** Checked before the body runs and closed after it,
 *   whichever way it ended.
 *
 * An unknown name exits 64 and lists the tasks there are.
 *
 * Scheduling stays outside. A systemd timer, a cron entry or a CronJob is the
 * deployment's business; each of them already knows how to run a command at
 * 3am, retry it and report a non-zero exit. What they cannot know is whether
 * the command is safe to run — and that is what this file is for.
 */
// Before the container, which reads the environment while it registers itself.
import "dotenv/config";

import type { ILogger } from "monolite-core";
import { runTaskByName } from "monolite-di";

import { container, root, TOKENS } from "../composition/container";
import { readEnv } from "../config/env";
import { TASKS } from "../tasks";

/**
 * Exported, and not only run, so a test can drive it and read the exit code it
 * would have ended with — without the process ending under the test runner.
 */
export function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return runTaskByName(argv[0], {
    tasks: TASKS,
    root,
    logger: container.resolve<ILogger>(TOKENS.ILogger),
    lockDir: readEnv("TASK_LOCK_DIR") || undefined,
    // Two applications on one host, each with a task called `notify`, must not
    // stop each other.
    namespace: readEnv("SERVICE_NAME", "__serviceName__"),
  });
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      // Only reachable if the runner itself broke; every failure of a task is
      // already an exit code. Still a non-zero one, never a silent 0.
      console.error("The task runner failed", error);
      process.exit(1);
    }
  );
}
