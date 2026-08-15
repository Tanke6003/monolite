// Registering on import is deliberate: `main.ts`, the router and the tests all
// assume that importing this file is enough to have a working container.
import "reflect-metadata";
import { container } from "tsyringe";
import { AsyncRequestContext, HealthProbe } from "@monolite/core";
import type { IHealthProbe, ILogger, IRequestContext } from "@monolite/core";
// #if auth
import { registerAuth } from "@monolite/auth";
import { SeedUserProvider } from "../auth/seed-user.provider";
// #endif
import { ConsoleLogger } from "../infrastructure/logger";
import { createDataSource, type DataSource } from "../infrastructure/persistence/data-source";
import { TOKENS } from "./tokens";
// #if example
import { registerProducts } from "./modules/product.module";
// #endif

/**
 * Composition root.
 *
 * The order in the first half is not stylistic: the logger and the request
 * context are what the persistence layer is built with, and the request context
 * is what the generic repository reads to fill the audit columns. From the
 * feature modules downwards order stops mattering — tsyringe resolves a
 * dependency when someone asks for it, not when it is registered.
 */

const logger: ILogger = new ConsoleLogger();
container.register<ILogger>(TOKENS.ILogger, { useValue: logger });

// A singleton is not a preference here: the AsyncLocalStorage that the request
// middleware opens has to be the very same one the repository reads from.
const requestContext: IRequestContext = new AsyncRequestContext();
container.register<IRequestContext>(TOKENS.IRequestContext, { useValue: requestContext });

const dataSource = createDataSource(logger, requestContext);
container.register<DataSource>(TOKENS.DataSource, { useValue: dataSource });

// The probe is built here because this is where the connection is. The
// connection itself is not registered: it is a resource of the process, not a
// dependency anybody injects.
container.register<IHealthProbe>(TOKENS.IHealthProbe, {
  useValue: new HealthProbe({
    connection: dataSource.connection,
    dataSource: dataSource.driver,
  }),
});

// #if auth
// The package brings the login route, the token service and the password
// hasher; the application brings the one thing a framework cannot know, which
// is where its users live.
export const auth = registerAuth(container, { userProvider: SeedUserProvider });
// #endif

// #if example
registerProducts();
// #endif

/**
 * Checks the database before the process accepts traffic, so a wrong password
 * or an unreachable host shows up in the startup log instead of in the first
 * user's request. In memory there is nothing to open and this does nothing.
 */
export async function warmUpConnections(): Promise<void> {
  await dataSource.connection?.authenticate();
}

/** Returns the pool during an orderly shutdown. */
export async function shutdownConnections(): Promise<void> {
  await dataSource.connection?.close();
}

export { container, dataSource };
export { TOKENS } from "./tokens";
