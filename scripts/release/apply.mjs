/**
 * Writing one version everywhere it is recorded.
 *
 * The packages are released together —`MONOLITE_VERSION` in the CLI says so in
 * as many words— so the risk here is not picking the number, it is missing one
 * of the places it lives. A manifest left behind publishes a package that
 * depends on a sibling version that does not exist yet, and a stale
 * `MONOLITE_VERSION` ships a CLI that scaffolds projects pinned to last
 * month's framework. Both are only visible after the release.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Where the range the CLI writes into a generated project is declared. */
const CLI_RANGE_FILE = "packages/cli/src/config/answers.ts";
const CLI_RANGE = /(export const MONOLITE_VERSION = ")[^"]+(";)/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  // npm writes manifests with two spaces and a trailing newline; matching that
  // keeps a release commit to the lines that actually changed.
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Every workspace package, discovered rather than listed, so adding one is free. */
export function workspacePackages(root = ROOT) {
  const dir = path.join(root, "packages");

  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name, "package.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, manifest: readJson(file) }));
}

/**
 * A manifest's own version, and every range that points at a sibling.
 *
 * Third-party ranges are copied through untouched: this knows which names are
 * ours because it is told, not by guessing at a prefix.
 */
export function bumpManifest(manifest, version, siblings) {
  const next = { ...manifest, version };

  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (!next[field]) continue;

    next[field] = Object.fromEntries(
      Object.entries(next[field]).map(([name, range]) => [
        name,
        siblings.has(name) ? `^${version}` : range,
      ])
    );
  }

  return next;
}

/**
 * Throws rather than returning the source unchanged: a rename of the constant
 * would otherwise turn this into a silent no-op, and the failure it causes
 * only shows up in someone else's `npm install`.
 */
export function bumpMonoliteRange(source, version) {
  if (!CLI_RANGE.test(source)) {
    throw new Error(`MONOLITE_VERSION not found in ${CLI_RANGE_FILE}`);
  }

  return source.replace(CLI_RANGE, `$1^${version}$2`);
}

/** Applies `version` across the repository. Returns the files it rewrote. */
export function applyVersion(version, root = ROOT) {
  const packages = workspacePackages(root);
  const siblings = new Set(packages.map(({ manifest }) => manifest.name));
  const written = [];

  for (const { file, manifest } of packages) {
    writeJson(file, bumpManifest(manifest, version, siblings));
    written.push(path.relative(root, file));
  }

  const rootManifestFile = path.join(root, "package.json");
  writeJson(rootManifestFile, { ...readJson(rootManifestFile), version });
  written.push("package.json");

  const rangeFile = path.join(root, CLI_RANGE_FILE);
  fs.writeFileSync(rangeFile, bumpMonoliteRange(fs.readFileSync(rangeFile, "utf8"), version));
  written.push(CLI_RANGE_FILE);

  return written;
}

/** The version the repository currently claims. */
export function currentVersion(root = ROOT) {
  return readJson(path.join(root, "package.json")).version;
}

/** Publishable packages, in the order their dependencies require. */
export function publishOrder(root = ROOT) {
  const packages = workspacePackages(root).filter(({ manifest }) => !manifest.private);
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  const done = new Set();
  const ordered = [];

  // A plain topological walk. Seven packages two levels deep does not need
  // anything cleverer, and a cycle here would be a design problem, not a
  // scheduling one — so it is reported rather than worked around.
  const visit = ({ manifest }, seen) => {
    if (done.has(manifest.name)) return;
    if (seen.has(manifest.name)) {
      throw new Error(`dependency cycle through ${manifest.name}`);
    }

    seen.add(manifest.name);

    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!names.has(dependency)) continue;
      visit(
        packages.find(({ manifest: other }) => other.name === dependency),
        seen
      );
    }

    done.add(manifest.name);
    ordered.push(manifest.name);
  };

  for (const entry of packages) visit(entry, new Set());

  return ordered;
}
