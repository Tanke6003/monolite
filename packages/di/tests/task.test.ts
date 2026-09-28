import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createCompositionRoot,
  createContainer,
  defineTask,
  runTask,
  runTaskByName,
  TASK_EXIT,
} from "monolite-di";
import type { IManagedConnection, TaskDefinition } from "monolite-di";

/**
 * The runner a scheduled job goes through.
 *
 * Everything here is about the three things a hand-written script forgets and
 * a supervisor depends on: the exit code, the overlap guard, and a log line
 * that says which task ran and how long it took.
 */

const logger = () => ({
  log: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

/** A resource that records what the root did with it. */
function connection(overrides: Partial<IManagedConnection> = {}) {
  return {
    authenticate: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    ...overrides,
  };
}

function rootWith(resource: IManagedConnection = connection()) {
  return createCompositionRoot((root) => root.manage(resource), createContainer());
}

/** A promise and the function that settles it, for a body that waits on the test. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** Resolves once the child has been spawned, so its pid is real. */
function nodeProcess(script: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

const exited = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", () => resolve()));

describe("runTask", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "monolite-task-"));
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("runs the body with the container and the logger, and answers 0", async () => {
    const root = rootWith();
    root.container.register("IGreeting", { useValue: "hello" });
    const log = logger();
    let seen: unknown;

    const task = defineTask({
      name: "greet",
      run: ({ container, name }) => {
        seen = [container.resolve("IGreeting"), name];
      },
    });

    await expect(runTask(task, { root, logger: log, lockDir })).resolves.toBe(TASK_EXIT.OK);
    expect(seen).toEqual(["hello", "greet"]);
  });

  /**
   * The line an operator greps for at 9am: which task, and how long. Written
   * whichever way the run ended, so a slow failure is as visible as a slow
   * success.
   */
  it("logs which task ran and how long it took", async () => {
    const log = logger();

    await runTask(defineTask({ name: "tick", run: () => undefined }), {
      root: rootWith(),
      logger: log,
      lockDir,
    });

    expect(log.info).toHaveBeenCalledWith('Task "tick" started', { task: "tick" });
    expect(log.info).toHaveBeenCalledWith('Task "tick" finished', {
      task: "tick",
      durationMs: expect.any(Number),
    });
  });

  /**
   * The behaviour a hand-written script most often gets wrong: an `async
   * main()` whose rejection nobody awaited. Here a throw and a rejection are
   * the same thing — a non-zero exit and a line saying so.
   */
  it.each([
    ["throws", () => {
      throw new Error("boom");
    }],
    ["rejects", async () => {
      await Promise.resolve();
      throw new Error("boom");
    }],
  ])("answers 1 when the body %s, and logs the error with the duration", async (_how, body) => {
    const log = logger();

    const code = await runTask(defineTask({ name: "broken", run: body }), {
      root: rootWith(),
      logger: log,
      lockDir,
    });

    expect(code).toBe(TASK_EXIT.FAILED);
    expect(log.error).toHaveBeenCalledWith('Task "broken" failed', {
      task: "broken",
      durationMs: expect.any(Number),
      error: expect.objectContaining({ message: "boom" }),
    });
  });

  /**
   * A failed job must not leave the pool open: the process would hang on its
   * sockets and the timer would see a run that never ends.
   */
  it("closes the connections whichever way the body ended", async () => {
    const resource = connection();

    await runTask(
      defineTask({
        name: "broken",
        run: () => {
          throw new Error("boom");
        },
      }),
      { root: rootWith(resource), logger: logger(), lockDir }
    );

    expect(resource.close).toHaveBeenCalledTimes(1);
  });

  it("does not run the body when the database cannot be reached", async () => {
    const run = jest.fn();
    const log = logger();
    const resource = connection({ authenticate: jest.fn(async () => Promise.reject(new Error("ECONNREFUSED"))) });

    const code = await runTask(defineTask({ name: "sync", run }), {
      root: rootWith(resource),
      logger: log,
      lockDir,
    });

    expect(code).toBe(TASK_EXIT.FAILED);
    expect(run).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'Task "sync" could not reach the database',
      expect.objectContaining({ task: "sync" })
    );
  });

  /**
   * A body that succeeded but whose shutdown failed is not a clean run: the
   * next one may find the pool in a state nobody chose. The supervisor hears
   * about it.
   */
  it("answers 1 when the body succeeded but the connections would not close", async () => {
    const resource = connection({ close: jest.fn(async () => Promise.reject(new Error("socket"))) });

    const code = await runTask(defineTask({ name: "tick", run: () => undefined }), {
      root: rootWith(resource),
      logger: logger(),
      lockDir,
    });

    expect(code).toBe(TASK_EXIT.FAILED);
  });

  describe("the overlap guard", () => {
    /**
     * The check from the issue: a second invocation while the first holds the
     * lock exits with a distinct code and a clear message rather than running.
     * The case it exists for is the nightly job that took longer than a night.
     */
    it("refuses a second run while the first holds the lock, with its own exit code", async () => {
      const inside = gate();
      const release = gate();
      const secondBody = jest.fn();

      const first = runTask(
        defineTask({
          name: "advance-charges",
          run: async () => {
            inside.open();
            await release.opened;
          },
        }),
        { root: rootWith(), logger: logger(), lockDir }
      );
      await inside.opened;

      const log = logger();
      const second = await runTask(defineTask({ name: "advance-charges", run: secondBody }), {
        root: rootWith(),
        logger: log,
        lockDir,
      });

      expect(second).toBe(TASK_EXIT.ALREADY_RUNNING);
      expect(TASK_EXIT.ALREADY_RUNNING).not.toBe(TASK_EXIT.FAILED);
      expect(secondBody).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        'Task "advance-charges" is already running; this run did not start',
        expect.objectContaining({ heldBy: process.pid, since: expect.any(String) })
      );

      release.open();
      await expect(first).resolves.toBe(TASK_EXIT.OK);
    });

    /** Released on the way out, or the guard would block every run after the first. */
    it("releases the lock when the run ends, success or failure", async () => {
      const options = { root: rootWith(), logger: logger(), lockDir };
      const failing = defineTask({
        name: "nightly",
        run: () => {
          throw new Error("boom");
        },
      });

      await expect(runTask(failing, options)).resolves.toBe(TASK_EXIT.FAILED);
      await expect(runTask(defineTask({ name: "nightly", run: () => undefined }), options)).resolves.toBe(
        TASK_EXIT.OK
      );
      expect(fs.readdirSync(lockDir)).toEqual([]);
    });

    it("guards each task on its own, and each application on its own", async () => {
      const inside = gate();
      const release = gate();

      const first = runTask(
        defineTask({
          name: "notify",
          run: async () => {
            inside.open();
            await release.opened;
          },
        }),
        { root: rootWith(), logger: logger(), lockDir, namespace: "billing" }
      );
      await inside.opened;

      const tick = defineTask({ name: "tick", run: () => undefined });
      const otherNotify = defineTask({ name: "notify", run: () => undefined });

      await expect(
        runTask(tick, { root: rootWith(), logger: logger(), lockDir, namespace: "billing" })
      ).resolves.toBe(TASK_EXIT.OK);
      await expect(
        runTask(otherNotify, { root: rootWith(), logger: logger(), lockDir, namespace: "crm" })
      ).resolves.toBe(TASK_EXIT.OK);

      release.open();
      await first;
    });

    /**
     * The same guard across processes, which is what a timer firing while a
     * manual run is still going actually looks like. The lock names a live
     * process that is not this one; the run must not start.
     */
    it("respects a lock held by another live process", async () => {
      const holder = await nodeProcess("setTimeout(() => {}, 30000)");

      try {
        fs.writeFileSync(
          path.join(lockDir, "mail-check.task.lock"),
          JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString(), token: "other" })
        );

        const code = await runTask(defineTask({ name: "mail-check", run: () => undefined }), {
          root: rootWith(),
          logger: logger(),
          lockDir,
        });

        expect(code).toBe(TASK_EXIT.ALREADY_RUNNING);
        // Not ours, so not ours to delete.
        expect(fs.existsSync(path.join(lockDir, "mail-check.task.lock"))).toBe(true);
      } finally {
        holder.kill();
        await exited(holder);
      }
    });

    /**
     * A run killed by `SIGKILL`, the OOM killer or a power cut cannot delete
     * its lock. If that blocked the task until somebody found the file by hand,
     * the guard would cause more missed runs than it prevents double ones.
     */
    it("takes over a lock whose process no longer exists", async () => {
      const gone = await nodeProcess("");
      await exited(gone);

      fs.writeFileSync(
        path.join(lockDir, "mail-check.task.lock"),
        JSON.stringify({ pid: gone.pid, startedAt: "2026-01-01T03:00:00.000Z", token: "dead" })
      );

      const code = await runTask(defineTask({ name: "mail-check", run: () => undefined }), {
        root: rootWith(),
        logger: logger(),
        lockDir,
      });

      expect(code).toBe(TASK_EXIT.OK);
      expect(fs.readdirSync(lockDir)).toEqual([]);
    });

    /**
     * In a container the runner is PID 1 every time it starts, so a lock left
     * on a persistent volume by a killed run names the new run's own pid. That
     * pid is alive — it is this process — but this process never took the
     * lock; trusting the pid alone would block the task on that host forever.
     */
    it("takes over a lock naming its own pid that this process never took", async () => {
      fs.writeFileSync(
        path.join(lockDir, "mail-check.task.lock"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T03:00:00.000Z",
          token: "previous-container",
        })
      );

      const code = await runTask(defineTask({ name: "mail-check", run: () => undefined }), {
        root: rootWith(),
        logger: logger(),
        lockDir,
      });

      expect(code).toBe(TASK_EXIT.OK);
      expect(fs.readdirSync(lockDir)).toEqual([]);
    });
  });
});

describe("runTaskByName", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "monolite-task-"));
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  const tasks: TaskDefinition[] = [
    defineTask({ name: "notify", description: "Sends the reminders", run: () => undefined }),
    defineTask({ name: "mail-check", run: () => undefined }),
  ];

  it("runs the task it was named", async () => {
    await expect(
      runTaskByName("mail-check", { tasks, root: rootWith(), logger: logger(), lockDir })
    ).resolves.toBe(TASK_EXIT.OK);
  });

  /**
   * Somebody typed a name at a shell. What helps them is the list of names
   * that exist, and an exit code a supervisor can tell from a failed run.
   */
  it.each([
    ["an unknown name", "notfy", 'There is no task called "notfy"'],
    ["no name at all", undefined, "Which task? None was named"],
  ])("answers the usage code for %s, listing what there is", async (_case, name, message) => {
    const log = logger();

    const code = await runTaskByName(name, { tasks, root: rootWith(), logger: log, lockDir });

    expect(code).toBe(TASK_EXIT.USAGE);
    expect(log.error).toHaveBeenCalledWith(message, {
      available: ["notify — Sends the reminders", "mail-check"],
    });
  });
});

describe("defineTask", () => {
  /**
   * The name is typed at a shell, written into a systemd unit and used as the
   * lock's file name. Refusing anything else at import beats a task nobody can
   * invoke.
   */
  it("refuses a name that is not kebab case", () => {
    for (const name of ["Advance Charges", "advance_charges", "../etc", "", "-x"]) {
      expect(() => defineTask({ name, run: () => undefined })).toThrow("is not a usable task name");
    }

    expect(defineTask({ name: "advance-charges2", run: () => undefined }).name).toBe(
      "advance-charges2"
    );
  });
});
