module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",

  testMatch: ["**/tests/**/*.test.ts"],

  // Both of these run before a single module is imported, and both have to:
  // tsyringe reads the metadata the compiler emits and needs the polyfill in
  // place before the first decorated class loads, and the composition root
  // reads the environment while it registers itself, which also happens at
  // import time. A `beforeAll` would be too late for either.
  setupFiles: ["reflect-metadata", "<rootDir>/tests/setup/test-env.ts"],

  // Off by default. Coverage instruments every file under `src`, including the
  // composition root, so `--coverage` needs the whole dependency tree to be
  // installed and importable. It is a deliberate opt-in, not the default run.
  collectCoverage: false,
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  coverageDirectory: "reports/coverage",
  coverageReporters: ["text-summary", "lcov", "html"],
};
