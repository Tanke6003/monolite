/**
 * The integration suite: the same packages, against real engines.
 *
 * A configuration of its own rather than a flag on the main one, because the
 * two answer different questions and are run at different moments. `npm test`
 * must stay runnable with nothing installed — that is what makes it the command
 * anybody runs before a commit — and a suite that needs five containers cannot
 * live inside it without either slowing every run down or being skipped so
 * often that it stops meaning anything.
 *
 *     docker compose -f docker/integration/docker-compose.yml up -d
 *     npm run test:integration
 */
const base = require("./jest.config");

module.exports = {
  ...base,
  testMatch: ["**/tests/**/*.integration.test.ts"],
  // The base config excludes exactly these; here they are the only ones wanted.
  testPathIgnorePatterns: ["/node_modules/"],
  // One engine at a time. They are independent, but five servers on one laptop
  // competing for the same cores turns a slow suite into a flaky one, and the
  // failure looks like a timeout rather than what it is.
  maxWorkers: 1,
  testTimeout: 180_000,
};
