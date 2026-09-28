import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { ROOT } from "./examples.mjs";

/**
 * `monolite-http`'s README lists what the package exports, and the list had
 * already fallen two names behind `src/index.ts` (#52) — one of them imported
 * by the example right above the table. A list nobody checks is a list that
 * drifts, so this reads both and names whatever the table is missing.
 */

/** Every name `export { … }` / `export type { … }` makes public. */
function exportedNames(indexFile) {
  const source = fs.readFileSync(indexFile, "utf8");
  const names = new Set();

  for (const [, block] of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of block.split(",")) {
      const name = raw.replace(/\btype\s+/, "").split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }

  return [...names];
}

describe("monolite-http's README", () => {
  it("has a row for every name the package exports", () => {
    const readme = fs.readFileSync(path.join(ROOT, "packages", "http", "README.md"), "utf8");
    const start = readme.indexOf("## What it exports");
    const table = readme.slice(start, readme.indexOf("\n## ", start + 1));

    const missing = exportedNames(path.join(ROOT, "packages", "http", "src", "index.ts")).filter(
      (name) => !table.includes(`\`${name}\``)
    );

    assert.deepEqual(missing, [], `add a row under "What it exports" for: ${missing.join(", ")}`);
  });
});
