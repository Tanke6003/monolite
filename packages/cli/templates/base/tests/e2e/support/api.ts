import request from "supertest";
import { Server } from "../../../src/server";

/**
 * The application under test: the real one, configured exactly as `main.ts`
 * configures it, and never listening.
 *
 * Supertest takes the Express instance and drives it in memory, so the suite
 * binds no port — no clash with a `npm run dev` already running, and no
 * teardown to forget. What it exercises is everything above the socket: the
 * middleware chain in its real order, the routes the decorators produced, the
 * validation, the error handler and the document.
 *
 * Configured once for the whole run. Building it per test would rebuild the
 * container, and with the in-memory driver that also means reseeding the
 * tables — which sounds like isolation and is really a way to hide a test that
 * depends on the order it runs in.
 */
let configuring: Promise<Server> | undefined;

export async function api() {
  configuring ??= (async () => {
    // Port 0 is never bound; the constructor only records it.
    const server = new Server(0);
    await server.configure();
    return server;
  })();

  return request((await configuring).app);
}

/** The agent's type, so a `beforeAll` can hold one without naming supertest. */
export type Api = Awaited<ReturnType<typeof api>>;

/**
 * Where the API is mounted. The health routes and the document sit outside it,
 * which is why the tests spell it out rather than assuming a common root.
 *
 * The trailing slash is stripped so a prefix of `/` composes to `/products`
 * rather than to `//products`.
 */
export const API = "__apiPrefix__".replace(/\/$/, "");
#if auth

/**
 * The account `SeedUserProvider` serves. Development only, and the first thing
 * to replace along with the provider itself.
 *
 * The password is read rather than written down, because the provider reads it
 * too — from `tests/setup/test-env.ts` during a run, from `.env` otherwise. Two
 * copies of a password in two files is how a suite starts failing for a reason
 * that has nothing to do with the code.
 */
export const SEED_CREDENTIALS = {
  email: "admin@example.com",
  password: process.env.SEED_PASSWORD ?? "",
};
#endif

/**
 * Headers every request in this suite carries.
 *
 * In a project with authentication that is a bearer token for the seeded
 * account, obtained through the real login route rather than signed here: a
 * token minted by the test would prove the guard accepts tokens the test can
 * make, which is not the question.
 *
 * Cached, because hashing a password is deliberately expensive and doing it
 * once per request would make the suite slower than the thing it tests.
 */
let cached: Record<string, string> | undefined;

export async function headers(): Promise<Record<string, string>> {
#if auth
  if (cached) return cached;

  const response = await (await api()).post(`${API}/auth/login`).send(SEED_CREDENTIALS);

  if (response.status !== 200) {
    throw new Error(`[tests] login answered ${response.status}: ${JSON.stringify(response.body)}`);
  }

  cached = { Authorization: `Bearer ${(response.body as { token: string }).token}` };
  return cached;
#else
  // Nothing to send: this project has no authentication, and the router mounts
  // every route behind a guard that lets everyone through. The function stays
  // so that adding authentication later is a change here and nowhere else.
  cached ??= {};
  return cached;
#endif
}
