module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",

  testMatch: ["**/tests/**/*.test.ts"],

  // tsyringe reads the metadata the compiler emits, and it has to be patched in
  // before the first decorated class is loaded — which happens at import time,
  // so a `beforeAll` would already be too late.
  setupFiles: ["reflect-metadata"],

  // Off by default. Coverage instruments every file under `src`, including the
  // composition root, so `--coverage` needs the whole dependency tree to be
  // installed and importable. It is a deliberate opt-in, not the default run.
  collectCoverage: false,
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  coverageDirectory: "reports/coverage",
  coverageReporters: ["text-summary", "lcov", "html"],
};
