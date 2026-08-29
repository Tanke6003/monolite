/**
 * The environment the tests run in, applied before a single module is loaded.
 *
 * It has to be a `setupFiles` entry and not a `beforeAll`: the composition root
 * registers itself at *import* time and reads the environment while it does, so
 * anything set later arrives after the container has already been built.
 *
 * `.env` is deliberately not loaded. A suite whose result depends on a file
 * that is git-ignored is a suite that passes on the machine it was written on.
 */

process.env.NODE_ENV = "test";

/**
 * In memory, whichever engine this project was scaffolded for.
 *
 * The entity metadata is the same for every driver, so the in-memory one gives
 * the tests the real repository, the real unit of work and the real BLL —
 * everything except a socket. An end-to-end suite that needs a container first
 * is a suite that stops being run.
 *
 * Point it at a real engine to run the same tests against one: nothing below
 * this line knows the difference.
 */
process.env.DATA_SOURCE = "memory";

/** The prefix the tests build their URLs from. */
process.env.API_PREFIX = "__apiPrefix__";

/** The document is what several of these tests are about. */
process.env.DOCS_ENABLED = "true";

/**
 * No quota. The limiter counts per address and every request here arrives from
 * the same one, so leaving it on would make a long suite fail at whichever test
 * happened to be the hundred-and-twenty-first.
 */
process.env.RATE_LIMIT_MAX = "0";
#if auth

/**
 * A secret for the tests, and only for them. The application refuses to start
 * without one, which is the point of that check — but a suite cannot ask a
 * developer to set it before `npm test` will run at all.
 */
process.env.JWT_SECRET = "test-only-secret-not-used-anywhere-else";

/**
 * And the seeded account's password, for the same reason. It is set here and
 * not read from `.env` on purpose: a suite whose credentials come from a
 * git-ignored file is a suite that only passes on one machine.
 */
process.env.SEED_PASSWORD = "test-only-seed-password";
#endif
