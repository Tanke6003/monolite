/**
 * Loading a database driver only if the application actually uses it.
 *
 * The six engines are declared as *optional* peer dependencies, which is the
 * whole promise of the package: a project on PostgreSQL installs `pg` and
 * `sequelize` and nothing else. A static `import` at the top of a connector
 * defeats that completely — the module graph is resolved before a single line
 * runs, so importing `@monolite/data` at all would require Oracle's driver,
 * MongoDB's and Sequelize's to be present, whichever engine is configured.
 *
 * So the drivers are required at the point the connector is built, which only
 * happens for the engine that was chosen. Types are still imported statically:
 * `import type` is erased at compile time and costs nothing at runtime.
 */

/**
 * `true` when the module itself is missing, rather than something inside it.
 *
 * A driver whose own dependency is absent, or whose native build failed, also
 * reports `MODULE_NOT_FOUND`, and answering that with "install oracledb" would
 * send somebody to reinstall a package that is already there. Node names the
 * module it could not find in the message, so that is what gets checked.
 */
function isMissingModule(error: unknown, module: string): boolean {
  return (
    (error as NodeJS.ErrnoException | undefined)?.code === "MODULE_NOT_FOUND" &&
    String((error as Error).message).includes(`'${module}'`)
  );
}

/**
 * Requires an optional driver, or explains what to install.
 *
 * The default failure —`Cannot find module 'oracledb'`, thrown from inside a
 * package the application never mentioned— tells the reader nothing about what
 * they did or what to do next. This one names the engine that asked, the
 * package that is missing and the two ways out of it.
 */
export function loadOptionalDriver<T>(module: string, engine: string): T {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(module) as T;
  } catch (error) {
    if (!isMissingModule(error, module)) throw error;

    throw new Error(
      `[persistence] The ${engine} connector needs "${module}", which is an optional peer ` +
        `dependency and is not installed. Install it with \`npm install ${module}\`, or point ` +
        "DATA_SOURCE at an engine whose driver is present.",
      { cause: error }
    );
  }
}
