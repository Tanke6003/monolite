/**
 * Jest runs from the repository root over every workspace, rather than one
 * configuration per package. A single run means a single coverage report, which
 * is what actually tells us whether the framework as a whole is tested — six
 * separate reports each looking healthy can still hide a package nobody covers.
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/packages"],
  testMatch: ["**/tests/**/*.test.ts"],

  /**
   * Packages import each other by name (`@monolite/core`), not by relative path,
   * so the tests must resolve those names to the *sources*. Pointing at `dist`
   * would mean every test run depends on a prior build, and a stale build would
   * silently test yesterday's code.
   */
  moduleNameMapper: {
    "^@monolite/([^/]+)$": "<rootDir>/packages/$1/src/index.ts",

    // Relative imports carry a `.js` extension because `moduleResolution:
    // nodenext` demands it in the emitted output. ts-jest resolves as CommonJS,
    // where that extension points at a file that does not exist on disk, so it
    // has to come back off before resolution.
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },

  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          // The packages emit ESM-style `.js` extensions on relative imports for
          // `moduleResolution: nodenext`. ts-jest runs CommonJS, so the extension
          // has to be tolerated rather than resolved literally.
          module: "commonjs",
          moduleResolution: "node",
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          allowImportingTsExtensions: false,
          esModuleInterop: true,
          target: "es2022",
          strict: true,
        },
        isolatedModules: true,
      },
    ],
  },

  moduleFileExtensions: ["ts", "js", "json"],

  /**
   * Coverage is collected from every source file, not only the ones a test
   * happens to import. An untested file that never appears in the report reads
   * as "covered" to anyone skimming the number.
   */
  collectCoverageFrom: [
    "packages/*/src/**/*.ts",
    "!packages/*/src/**/*.d.ts",
    "!packages/cli/templates/**",
  ],
  coverageDirectory: "coverage",
  clearMocks: true,
};
