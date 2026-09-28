import { defineTask } from "monolite-di";

/**
 *     npm run task __entityKebab__
 *     node dist/scripts/task.js __entityKebab__   # after a build
 *
 * The container is already built and the database already checked when `run`
 * is called, and the connections are closed after it returns. Throwing — or
 * rejecting — is how the task fails: the runner logs the error and exits 1, so
 * whatever scheduled it sees the failure. There is no need to catch here just to
 * log; catch only what the task can genuinely recover from.
 *
 * A run refuses to start while the previous one is still going, so a job that
 * takes longer than its interval does not overlap itself.
 */
export default defineTask({
  name: "__entityKebab__",
  description: "Describe what __entityKebab__ does, in one line",
  async run({ logger }) {
    // Resolve what the job needs from the container, the same way a
    // controller would have it injected:
    //
    //   async run({ container, logger }) {
    //     const invoices = container.resolve<IInvoicesBLL>(INVOICE_TOKENS.bll);
    //     const sent = await invoices.sendReminders();
    //     logger.info(`${sent} reminders sent`);
    //   }
    logger.info("__entityKebab__: nothing to do yet");
  },
});
