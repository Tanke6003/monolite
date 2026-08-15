import fs from "node:fs";
import path from "node:path";

/**
 * The marker that says "this directory is a monolite project".
 *
 * A `monolite` key in `package.json` rather than a `monolite.json` of our own:
 * the information —which engine, which prefix, whether auth is wired— belongs
 * to the project's manifest, and one fewer file at the root is one fewer file
 * to keep in sync. It is also what `generate` reads to decide what a new module
 * should look like, so a project generated against Postgres keeps generating
 * Postgres-shaped modules.
 */
export interface MonoliteMarker {
  /** CLI version that scaffolded the project; informational. */
  version?: string;
  /** Engine id, as `EngineSpec.id` spells it. */
  database?: string;
  apiPrefix?: string;
  auth?: boolean;
  /** Where sources live, relative to the project root. */
  sourceRoot?: string;
}

export interface MonoliteProject {
  root: string;
  packageJsonPath: string;
  name: string;
  marker: MonoliteMarker;
  /** Absolute path of the source root, `<root>/src` unless overridden. */
  sourceRoot: string;
}

/**
 * Walks up from `start` looking for the marker.
 *
 * Walking up rather than requiring the root is what makes `monolite generate`
 * usable from wherever the file being worked on lives, the same way `git` and
 * `npm` behave.
 */
export function findProject(start: string = process.cwd()): MonoliteProject | null {
  let directory = path.resolve(start);

  for (;;) {
    const packageJsonPath = path.join(directory, "package.json");

    if (fs.existsSync(packageJsonPath)) {
      const marker = readMarker(packageJsonPath);
      if (marker) {
        return {
          root: directory,
          packageJsonPath,
          name: marker.name,
          marker: marker.monolite,
          sourceRoot: path.join(directory, marker.monolite.sourceRoot ?? "src"),
        };
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function readMarker(
  packageJsonPath: string
): { name: string; monolite: MonoliteMarker } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      monolite?: MonoliteMarker;
    };

    if (!parsed.monolite || typeof parsed.monolite !== "object") return null;
    return { name: parsed.name ?? path.basename(path.dirname(packageJsonPath)), monolite: parsed.monolite };
  } catch {
    // A malformed package.json is not a monolite project as far as we are
    // concerned; the user has a bigger problem than a missing schematic.
    return null;
  }
}
