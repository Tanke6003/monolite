import type { TaskDefinition } from "monolite-di";

/**
 * Every task this application can run, by name: `__pmRun__ task <name>`.
 *
 * A task is what a timer, a cron entry or a Kubernetes CronJob invokes — the
 * nightly job, the reminder mailer, the seed that runs after every deploy. The
 * schedule is the deployment's business and lives there; what lives here is the
 * thing being scheduled, and `src/scripts/task.ts` is what runs it: container
 * built, database checked, the run timed and logged, a non-zero exit when it
 * fails, and a refusal to start while the previous run is still going.
 *
 * One list for the same reason `composition/modules.ts` is one list: a task
 * file that nothing references is a task nobody can invoke, and finding that
 * out from a timer that has been failing quietly for a week is the expensive
 * way.
 *
 * The marker below is where `monolite generate task` inserts. Move it or delete
 * it and the command goes back to telling you the line to add.
 */
export const TASKS: readonly TaskDefinition[] = [
  // monolite:tasks
];
