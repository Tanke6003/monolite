// dotenv first of all: the container is built at import time and reads the
// environment while it does, so a `.env` loaded afterwards would arrive too
// late for half of it.
import "dotenv/config";

import type { IHealthProbe, ILogger } from "monolite-core";
import { container, root, TOKENS } from "./composition/container";
import { readEnv, toInt } from "./config/env";
import { Server } from "./server";

const logger = container.resolve<ILogger>(TOKENS.ILogger);

const port = toInt(readEnv("PORT"), 3000, 1);

/**
 * Gap between reporting "not ready" and closing the socket.
 *
 * This is the step that actually removes the 502s from a rolling deploy: the
 * load balancer takes a moment to notice this instance is going away, and if
 * the port disappears first, whatever it routed in the meantime is lost.
 */
const shutdownDelayMs = toInt(readEnv("SHUTDOWN_DELAY_MS"), 0);

/** Budget for the whole shutdown. Keep it under the orchestrator's grace period. */
const shutdownTimeoutMs = toInt(readEnv("SHUTDOWN_TIMEOUT_MS"), 10_000, 1);

const server = new Server(port);

void (async () => {
  // Check the database before accepting traffic, so a credentials or network
  // problem shows up here and not in the first user's request.
  try {
    await root.warmUp();
  } catch (error) {
    logger.error("Could not reach the database", { error });
    process.exit(1);
  }

  await server.run();
})().catch((error: unknown) => {
  // Without this, a failure to bind the port surfaces as an unhandled rejection
  // and the process dies without one line of log explaining why.
  logger.error("The server failed to start", { error });
  process.exit(1);
});

// ------------------------------------------------------- graceful shutdown --

let shuttingDown = false;

const wait = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Four steps, in this order:
 *
 *  1. Stop being ready, so the load balancer stops sending traffic.
 *  2. Wait for it to notice.
 *  3. Stop listening and let the in-flight requests finish.
 *  4. Return the database pool.
 *
 * With a watchdog over the top: if something hangs, the process leaves anyway,
 * but with code 1 so it shows up in the orchestrator's log as a failure instead
 * of passing for a clean exit.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    logger.warn("Repeated shutdown signal; already draining", { signal });
    return;
  }
  shuttingDown = true;

  logger.info("Shutting down", { signal, shutdownDelayMs, shutdownTimeoutMs });

  const watchdog = setTimeout(() => {
    logger.error("Shutdown exceeded its budget; forcing the exit", { shutdownTimeoutMs });
    process.exit(1);
  }, shutdownTimeoutMs);
  // The timer must not be the only thing keeping the process alive.
  watchdog.unref();

  try {
    container.resolve<IHealthProbe>(TOKENS.IHealthProbe).beginShutdown();
    await wait(shutdownDelayMs);

    await server.close();
    logger.info("Server closed, no requests in flight");

    await root.shutdown();
    logger.info("Connections returned. Goodbye");

    clearTimeout(watchdog);
    process.exit(0);
  } catch (error) {
    logger.error("Failure during shutdown", { error });
    clearTimeout(watchdog);
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
