import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bumpManifest, bumpMonoliteRange, publishOrder, workspacePackages } from "./apply.mjs";

/**
 * The half of a release that is mechanical and therefore easy to get quietly
 * wrong: writing the same number into every place that records it.
 */

describe("bumpManifest", () => {
  const siblings = new Set(["monolite-core", "monolite-http"]);

  it("moves the version and every sibling range with it", () => {
    const bumped = bumpManifest(
      {
        name: "monolite-crud",
        version: "0.1.0",
        dependencies: { "monolite-core": "^0.1.0", "monolite-http": "^0.1.0", zod: "^4.4.3" },
      },
      "0.2.0",
      siblings
    );

    assert.equal(bumped.version, "0.2.0");
    assert.equal(bumped.dependencies["monolite-core"], "^0.2.0");
    assert.equal(bumped.dependencies["monolite-http"], "^0.2.0");
  });

  /** A third-party range moving with our version would be a broken install. */
  it("leaves third-party ranges exactly as they were", () => {
    const bumped = bumpManifest(
      { name: "monolite-crud", version: "0.1.0", dependencies: { zod: "^4.4.3" } },
      "0.2.0",
      siblings
    );

    assert.equal(bumped.dependencies.zod, "^4.4.3");
  });

  it("covers dev and peer ranges too, and tolerates a manifest with none", () => {
    const bumped = bumpManifest(
      {
        name: "monolite-di",
        version: "0.1.0",
        devDependencies: { "monolite-core": "^0.1.0" },
        peerDependencies: { "monolite-http": "^0.1.0" },
      },
      "1.0.0",
      siblings
    );

    assert.equal(bumped.devDependencies["monolite-core"], "^1.0.0");
    assert.equal(bumped.peerDependencies["monolite-http"], "^1.0.0");
    assert.doesNotThrow(() => bumpManifest({ name: "x", version: "0.1.0" }, "0.2.0", siblings));
  });

  it("keeps the key order npm wrote, so a release commit is one line per file", () => {
    const before = { name: "monolite-core", version: "0.1.0", license: "MIT" };

    assert.deepEqual(Object.keys(bumpManifest(before, "0.2.0", siblings)), [
      "name",
      "version",
      "license",
    ]);
  });
});

describe("bumpMonoliteRange", () => {
  it("rewrites the range the CLI pins a generated project to", () => {
    const source = 'export const MONOLITE_VERSION = "^0.1.0";\n';

    assert.equal(bumpMonoliteRange(source, "0.2.0"), 'export const MONOLITE_VERSION = "^0.2.0";\n');
  });

  /**
   * Silently returning the source unchanged would ship a CLI that scaffolds
   * projects pinned to a version that is no longer current, and the first
   * person to notice would be someone whose `npm install` failed.
   */
  it("refuses to be a no-op when the constant moves", () => {
    assert.throws(() => bumpMonoliteRange("const SOMETHING_ELSE = 1;\n", "0.2.0"), /not found/);
  });
});

describe("publishOrder", () => {
  it("puts a package after everything it depends on", () => {
    const order = publishOrder();
    const at = (name) => order.indexOf(name);

    assert.ok(at("monolite-core") < at("monolite-data"));
    assert.ok(at("monolite-data") < at("monolite-crud"));
    assert.ok(at("monolite-http") < at("monolite-crud"));
    assert.ok(at("monolite-core") < at("monolite-auth"));
  });

  it("covers every public package in the workspace exactly once", () => {
    const order = publishOrder();
    const publicNames = workspacePackages()
      .filter(({ manifest }) => !manifest.private)
      .map(({ manifest }) => manifest.name);

    assert.equal(order.length, publicNames.length);
    assert.equal(new Set(order).size, order.length);
    assert.deepEqual([...order].sort(), [...publicNames].sort());
  });
});
