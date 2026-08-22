import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { ROOT } from "./apply.mjs";

/**
 * What the seven tarballs have to contain, checked from the manifests.
 *
 * None of this is exercised by anything else: a package can be published for
 * months missing its licence or shipping source maps that resolve nowhere, and
 * every test still passes because nothing installs the tarball. The way it
 * surfaces is somebody opening the npm page and finding a link that is not
 * there, which is not a way to find out.
 *
 * It reads the manifests rather than running `npm pack` seven times, because
 * the manifest is where the mistake is made and the check should take a
 * millisecond.
 */

const PACKAGES = ["core", "data", "http", "crud", "di", "auth", "cli"];

const manifestOf = (name) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, "packages", name, "package.json"), "utf8"));

const fileIn = (name, file) => fs.existsSync(path.join(ROOT, "packages", name, file));

describe("every published package", () => {
  it("says who may use it, in a file the tarball carries", () => {
    for (const name of PACKAGES) {
      const manifest = manifestOf(name);

      assert.equal(manifest.license, "MIT", `${name} declares no licence`);
      // npm only picks a LICENSE up from the package's own folder. One at the
      // repository root is not in the tarball, and a licence you have to leave
      // the tarball to read is not one the tarball grants.
      assert.ok(fileIn(name, "LICENSE"), `${name} declares MIT and ships no LICENSE`);
    }
  });

  it("carries its own README, which is the npm page", () => {
    for (const name of PACKAGES) {
      assert.ok(fileIn(name, "README.md"), `${name} has no README`);
    }
  });

  it("points npm at the right folder of the repository", () => {
    for (const name of PACKAGES) {
      const manifest = manifestOf(name);

      // Without `directory`, every package's "source" link lands on the root of
      // the monorepo and the reader has to go looking.
      assert.equal(
        manifest.repository?.directory,
        `packages/${name}`,
        `${name} does not tell npm which directory it comes from`
      );
      assert.ok(manifest.bugs?.url, `${name} has nowhere to report a bug`);
      assert.ok(manifest.homepage, `${name} has no homepage`);
      assert.ok(manifest.keywords?.length, `${name} has no keywords, so nobody finds it`);
    }
  });

  /**
   * The build emits `.js.map` and `.d.ts.map`, and both point at `../src`.
   *
   * Shipping the maps without the sources is the worst of the three options: an
   * editor asked to go to a definition follows the map, finds nothing, and
   * falls back — while the tarball carries the weight anyway. Either both go or
   * neither does, and here both go, because the reasoning in this codebase
   * lives in the comments and landing on them is the point.
   */
  it("ships the sources its maps point at", () => {
    for (const name of PACKAGES) {
      const manifest = manifestOf(name);

      assert.ok(
        manifest.files.includes("dist"),
        `${name} does not ship the build`
      );
      assert.ok(
        manifest.files.includes("src"),
        `${name} ships source maps pointing at a src/ it does not include`
      );
    }
  });

  it("declares the Node it needs and publishes publicly", () => {
    for (const name of PACKAGES) {
      const manifest = manifestOf(name);

      assert.ok(manifest.engines?.node, `${name} does not say which Node it runs on`);
      assert.equal(manifest.publishConfig?.access, "public");
    }
  });
});

describe("monolite-cli", () => {
  it("ships the templates, which are the whole product", () => {
    const manifest = manifestOf("cli");

    // `monolite new` copies these. A tarball without them installs, runs, and
    // fails on the first command with a missing-path error.
    assert.ok(manifest.files.includes("templates"));
    assert.ok(fs.existsSync(path.join(ROOT, "packages", "cli", "templates")));
  });

  it("has no runtime dependencies, which is a promise it makes out loud", () => {
    const manifest = manifestOf("cli");

    assert.deepEqual(
      manifest.dependencies ?? {},
      {},
      "the CLI's zero-dependency claim is in its README and in the docs"
    );
  });
});

describe("monolite-data's optional drivers", () => {
  it("are optional, so installing one engine does not pull six", () => {
    const manifest = manifestOf("data");

    for (const driver of Object.keys(manifest.peerDependencies)) {
      assert.equal(
        manifest.peerDependenciesMeta?.[driver]?.optional,
        true,
        `${driver} is a peer but not an optional one`
      );
    }
  });

  /**
   * A range narrower than what is verified warns people off a combination that
   * is known to work.
   *
   * `tedious` said `^18` while the integration suite tested SQL Server against
   * 20 — found by running that suite, like most of what it found.
   */
  it("accept the versions the integration suite runs against", () => {
    const manifest = manifestOf("data");
    const root = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

    for (const [driver, range] of Object.entries(manifest.peerDependencies)) {
      const tested = root.devDependencies?.[driver];
      if (!tested) continue;

      const major = tested.replace(/^[^\d]*/, "").split(".")[0];
      assert.ok(
        range.includes(`^${major}`) || range.includes(`>=${major}`),
        `${driver} is tested against ${tested} and its peer range is "${range}"`
      );
    }
  });
});
