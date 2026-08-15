/**
 * Reading configuration is the one thing the factories in this package need
 * from the outside world, and this is the whole contract for it.
 *
 * It is deliberately this small. The container package does not care where a
 * value comes from —`process.env`, a `.env` file loaded by dotenv, a secrets
 * manager, a plain object in a test— only that it can be asked for by name.
 * Any implementation registered under `TOKENS.IEnvs` satisfies it structurally,
 * so an application that already has its own environment plugin passes it
 * straight in without adapting anything.
 *
 * `getEnv` returns a string rather than `string | undefined` because that is
 * how the original plugin behaves: a variable that is not set reads as an empty
 * string, and every caller here treats the empty string as "not configured" and
 * falls back to its default.
 */
export interface IEnvs {
  getEnv(key: string): string;
}
