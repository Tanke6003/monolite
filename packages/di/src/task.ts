//
// Tasks: the thing a timer, a cron entry or a Kubernetes CronJob invokes.
//
// A backend is not only a server. It has the job that advances overdue charges
// at 3am, the one that sends the reminders, the one that checks a mailbox —
// and every project used to write the same forty lines around each of them:
// build the container, resolve what it needs, run, close the pool, exit. The
// forty lines are identical and the details are easy to get wrong, so they
// live here once.
//
// Scheduling stays outside, deliberately. Owning a scheduler would mean owning
// a process that has to stay up, and systemd, cron and Kubernetes already do
// that correctly. What the toolkit owns is the thing being scheduled: a task
// that is safe to invoke.
//
// It is in `monolite-di` because what a task receives is the container and
// what surrounds it is the composition root's warm-up and shutdown — both of
// which already live here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ILogger } from "monolite-core";
import type { DependencyContainer } from "tsyringe";

import type { CompositionRoot } from "./container.js";

/**
 * The exit codes a task run ends with.
 *
 * Distinct on purpose, and borrowed from `sysexits.h` where there is a
 * convention to borrow: a supervisor treats every non-zero code as a failure,
 * but the person reading `systemctl status` at 9am wants to tell "the job
 * broke" from "the job was still running from last night" without opening the
 * log. `ALREADY_RUNNING` is `EX_TEMPFAIL` — try again later — because that is
 * exactly what it means.
 */
export const TASK_EXIT = {
  /** The body resolved and the connections closed cleanly. */
  OK: 0,
  /** The body threw, the database could not be reached, or shutdown failed. */
  FAILED: 1,
  /** No task by that name, or no name at all. `EX_USAGE`. */
  USAGE: 64,
  /** A previous run still holds the lock, so this one did not start. `EX_TEMPFAIL`. */
  ALREADY_RUNNING: 75,
} as const;

export type TaskExitCode = (typeof TASK_EXIT)[keyof typeof TASK_EXIT];

/** What a task's body is handed. */
export interface TaskContext {
  /** The application's container, fully registered and warmed up. */
  container: DependencyContainer;
  /** The application's logger, the same one the server writes to. */
  logger: ILogger;
  /** The task's own name, for a body that logs or reports about itself. */
  name: string;
}

export interface TaskDefinition {
  /**
   * What the task is invoked by: `npm run task advance-charges`. Also the name
   * of its lock and the `task` field of every line the runner logs.
   */
  name: string;
  /** One line, printed beside the name when the runner lists the tasks. */
  description?: string;
  /**
   * The job itself.
   *
   * Returning is success and throwing is failure — including a rejected
   * promise, which is the case a hand-written script gets wrong most often: an
   * `async main()` called without a `.catch` can leave the process with an
   * unhandled rejection and, depending on the runtime and its flags, exit 0.
   * Here the runner awaits it, so the only way out is through the exit code.
   */
  run(context: TaskContext): Promise<void> | void;
}

/**
 * Declares a task.
 *
 * An identity function with a check, which is all it needs to be: the type is
 * what makes the body's context typed without an annotation, and the check is
 * what turns a name nobody could type at a shell into an error at import
 * instead of a task nobody can invoke.
 *
 * ```ts
 * export default defineTask({
 *   name: "advance-charges",
 *   async run({ container, logger }) {
 *     const charges = container.resolve<ChargeBLL>(CHARGE_TOKENS.bll);
 *     logger.info(`${await charges.advanceDue()} charges advanced`);
 *   },
 * });
 * ```
 */
export function defineTask(definition: TaskDefinition): TaskDefinition {
  if (!TASK_NAME.test(definition.name)) {
    throw new Error(
      `[task] "${definition.name}" is not a usable task name: ` +
        "lower-case letters, digits and dashes, starting with a letter"
    );
  }

  return definition;
}

/**
 * Kebab case, and nothing else: the name is typed at a shell, written into a
 * systemd unit and used as a file name for the lock, and this is the spelling
 * that is safe in all three.
 */
const TASK_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface RunTaskOptions {
  /** The composition root the task's container belongs to; warmed up and shut down here. */
  root: CompositionRoot;
  logger: ILogger;
  /**
   * Where the lock files go. Defaults to the system's temporary directory.
   *
   * The lock guards one host. Two instances of the application on two machines
   * each hold their own — which is why a Kubernetes CronJob wants
   * `concurrencyPolicy: Forbid` on top, and why a job that must never run twice
   * *anywhere* needs a lock in the database it writes to.
   */
  lockDir?: string;
  /**
   * Prefixed to every lock file, so two applications on one host with a task
   * each called `notify` do not stop each other. The service name is the
   * natural value.
   */
  namespace?: string;
}

/**
 * Runs one task, and answers with the exit code the process should end with.
 *
 * Returns rather than calling `process.exit` so it can be tested, and so the
 * entry point stays the one place that decides to leave. In order:
 *
 *  1. **The lock.** A run that finds the previous one still going does not
 *     start: it logs who holds the lock and since when, and answers
 *     `ALREADY_RUNNING`. A nightly job that takes longer than a night is the
 *     case this exists for — without it, two runs advance the same charges.
 *  2. **Warm-up**, so an unreachable database fails here, with its own message,
 *     rather than half way through the body.
 *  3. **The body**, timed. One line when it starts and one when it ends, with
 *     the task's name and how long it took, whichever way it ended.
 *  4. **Shutdown** of the composition root and release of the lock, whatever
 *     happened before — a job that failed must not leave the pool open and the
 *     process hanging on its sockets.
 */
export async function runTask(task: TaskDefinition, options: RunTaskOptions): Promise<TaskExitCode> {
  const { root, logger } = options;
  const lock = acquireLock(task.name, options);

  if (!lock.acquired) {
    logger.error(`Task "${task.name}" is already running; this run did not start`, {
      task: task.name,
      heldBy: lock.holder?.pid,
      since: lock.holder?.startedAt,
      lock: lock.file,
    });
    return TASK_EXIT.ALREADY_RUNNING;
  }

  let code: TaskExitCode = TASK_EXIT.FAILED;

  try {
    code = await warmUpAndRun(task, options);
  } finally {
    try {
      await root.shutdown();
    } catch (error) {
      logger.error(`Task "${task.name}" could not close its connections`, {
        task: task.name,
        error,
      });
      code = TASK_EXIT.FAILED;
    }

    lock.release();
  }

  return code;
}

/** Steps 2 and 3 of `runTask`. Never throws: every failure is an exit code. */
async function warmUpAndRun(task: TaskDefinition, options: RunTaskOptions): Promise<TaskExitCode> {
  const { root, logger } = options;

  try {
    await root.warmUp();
  } catch (error) {
    logger.error(`Task "${task.name}" could not reach the database`, { task: task.name, error });
    return TASK_EXIT.FAILED;
  }

  logger.info(`Task "${task.name}" started`, { task: task.name });
  const startedAt = Date.now();

  try {
    await task.run({ container: root.container, logger, name: task.name });
  } catch (error) {
    logger.error(`Task "${task.name}" failed`, {
      task: task.name,
      durationMs: Date.now() - startedAt,
      error,
    });
    return TASK_EXIT.FAILED;
  }

  logger.info(`Task "${task.name}" finished`, {
    task: task.name,
    durationMs: Date.now() - startedAt,
  });
  return TASK_EXIT.OK;
}

export interface RunTaskByNameOptions extends RunTaskOptions {
  tasks: readonly TaskDefinition[];
}

/**
 * The entry point's whole job: find the task named on the command line and run
 * it.
 *
 * A missing or unknown name answers `USAGE` with the list of what there is,
 * rather than a stack trace — the person reading it typed a name at a shell and
 * wants to know which ones exist.
 */
export async function runTaskByName(
  name: string | undefined,
  options: RunTaskByNameOptions
): Promise<TaskExitCode> {
  const { tasks, logger } = options;
  const task = name ? tasks.find((candidate) => candidate.name === name) : undefined;

  if (!task) {
    const available = tasks.map((one) =>
      one.description ? `${one.name} — ${one.description}` : one.name
    );

    logger.error(name ? `There is no task called "${name}"` : "Which task? None was named", {
      available,
    });
    return TASK_EXIT.USAGE;
  }

  return runTask(task, options);
}

// ------------------------------------------------------------------ lock ---

interface LockHolder {
  pid: number;
  startedAt: string;
  /** Identifies this acquisition, so a release never removes somebody else's lock. */
  token: string;
}

interface Lock {
  acquired: boolean;
  file: string;
  holder?: LockHolder;
  release(): void;
}

/**
 * How long an unreadable lock file is trusted.
 *
 * The file is created and then written, so for an instant another run can see
 * it empty. That is a lock being taken, not a stale one; an empty file that
 * stays empty for this long is the remains of a crash between the two steps.
 */
const UNREADABLE_GRACE_MS = 10_000;

/**
 * The tokens of the locks this process holds right now.
 *
 * A pid only says a process is alive, not that it is the one that wrote the
 * lock. The case that matters is a container: the runner is PID 1 in every
 * container it starts in, so a lock left on a persistent `lockDir` by a killed
 * run names pid 1 — and the next run, also pid 1, would find that pid alive and
 * refuse to start, forever. A lock naming this process's own pid is therefore
 * live only if this process actually took it, which is what this set records.
 */
const heldHere = new Set<string>();

/**
 * A file, created exclusively, holding the pid of the run that owns it.
 *
 * `wx` is the whole mechanism: the operating system guarantees that exactly one
 * of two concurrent creates succeeds. What makes it usable is the pid inside —
 * a run killed by `SIGKILL` or a power cut cannot delete its lock, so a lock
 * whose process no longer exists is recognised as stale and taken over, rather
 * than blocking the task until somebody finds the file by hand.
 */
function acquireLock(taskName: string, options: RunTaskOptions): Lock {
  const directory = options.lockDir ?? os.tmpdir();
  const prefix = options.namespace ? `${sanitize(options.namespace)}.` : "";
  const file = path.join(directory, `${prefix}${taskName}.task.lock`);

  const mine: LockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };

  const release = (): void => {
    // Only if it is still ours: had this run been declared stale and its lock
    // taken over, deleting the file now would free the *new* run's lock.
    if (readHolder(file)?.token !== mine.token) return;
    heldHere.delete(mine.token);
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone; nothing is left to release.
    }
  };

  fs.mkdirSync(directory, { recursive: true });

  // Twice at most: once, and once more after clearing a stale lock. A second
  // `EEXIST` means another run cleared it first and won the race, which is a
  // held lock like any other.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(mine), { flag: "wx" });
      heldHere.add(mine.token);
      return { acquired: true, file, holder: mine, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const holder = readHolder(file);

    if (holder ? isHeld(holder) : isFresh(file)) {
      return { acquired: false, file, holder: holder ?? undefined, release: () => undefined };
    }

    try {
      fs.unlinkSync(file);
    } catch {
      // Somebody else removed it first; the next attempt settles who gets it.
    }
  }

  return { acquired: false, file, holder: readHolder(file) ?? undefined, release: () => undefined };
}

function readHolder(file: string): LockHolder | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockHolder>;
    return typeof parsed.pid === "number" && typeof parsed.token === "string"
      ? (parsed as LockHolder)
      : null;
  } catch {
    return null;
  }
}

/** Whether the run a lock names is still going; see `heldHere` for the own-pid case. */
function isHeld(holder: LockHolder): boolean {
  return holder.pid === process.pid ? heldHere.has(holder.token) : isAlive(holder.pid);
}

/**
 * Whether a process exists, without touching it: signal 0 is the documented
 * way to ask. `EPERM` means it exists and belongs to somebody else — which is
 * still a live run holding the lock.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isFresh(file: string): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < UNREADABLE_GRACE_MS;
  } catch {
    return false;
  }
}

/** A namespace is free text; a file name is not. */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}
