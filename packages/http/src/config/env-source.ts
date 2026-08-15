/**
 * The only thing this package needs from configuration: reading a variable by
 * name.
 *
 * It is declared structurally, here, instead of depending on a concrete
 * environment plugin. Anything that answers `getEnv(key)` with a string
 * satisfies it — `process.env` behind a two-line adapter, a dotenv plugin, a
 * secrets client — so the HTTP layer never imposes a particular way of loading
 * configuration on the application that uses it.
 *
 * By convention `getEnv` returns `""` for a variable that is not defined, which
 * is why the helpers that read it have to tell "absent" apart from "set to
 * something empty" by hand rather than trusting `Number("")` or a falsy check.
 */
export interface EnvSource {
  getEnv(key: string): string;
}

/**
 * The trivial adapter over `process.env`, so the package is usable before an
 * application has decided how it wants to load configuration.
 *
 * It normalises `undefined` to `""`, which is the contract the rest of the
 * package reads against.
 */
export const processEnv: EnvSource = {
  getEnv: (key: string): string => process.env[key] ?? "",
};
