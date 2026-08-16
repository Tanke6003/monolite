import path from "node:path";
import { parseArgs } from "node:util";

import { ENGINES, type EngineId } from "../config/engines.js";
import { printGenerateHelp } from "../help.js";
import { findProject, type MonoliteProject } from "../project.js";
import { isSchematic, renderSchematic, SCHEMATICS, type Schematic } from "../schematics.js";
import { color } from "../util/colors.js";
import { FileWriter } from "../util/files.js";
import { created, fail, hint, info, line, title, warn } from "../util/log.js";
import type { RenderContext } from "../util/render.js";

const OPTIONS = {
  force: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "no-color": { type: "boolean" },
} as const;

export function generateCommand(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    fail((error as Error).message);
    hint("run `monolite generate --help` for the list of schematics");
    return 1;
  }

  if (parsed.values.help) {
    printGenerateHelp();
    return 0;
  }

  const [schematicName, entityName] = parsed.positionals;

  if (!schematicName || !entityName) {
    fail("usage: monolite generate <schematic> <name>");
    hint(`schematics: ${SCHEMATICS.join(", ")}`);
    return 1;
  }

  if (!isSchematic(schematicName)) {
    fail(`unknown schematic "${schematicName}"`);
    hint(`schematics: ${SCHEMATICS.join(", ")}`);
    return 1;
  }

  const project = findProject();
  if (!project) {
    // The marker check is the whole reason this command can be trusted: without
    // it, a typo'd `cd` turns `generate module` into files scattered over an
    // unrelated repository.
    fail("this is not a monolite project");
    hint(
      "`generate` looks for a `monolite` key in package.json, walking up from the current directory"
    );
    hint("run it inside a project created by `monolite new`, or create one first");
    return 1;
  }

  return emit(project, schematicName, entityName, Boolean(parsed.values.force));
}

function emit(
  project: MonoliteProject,
  schematic: Schematic,
  name: string,
  force: boolean
): number {
  const writer = new FileWriter(project.root, force);
  const sourceRoot = path.relative(project.root, project.sourceRoot) || ".";

  try {
    renderSchematic({ schematic, name, project: contextFor(project), writer, sourceRoot });
  } catch (error) {
    fail((error as Error).message);
    return 1;
  }

  if (writer.written.length === 0) {
    fail("every file already exists; nothing was written");
    hint("pass --force to overwrite them");
    return 1;
  }

  title(`Generated ${color.bold(schematic)} ${color.bold(name)} in ${project.name}`);
  line();
  for (const relative of [...writer.written].sort()) created(relative);
  line();

  if (schematic === "module") wiringReminder(name, sourceRoot);
  return 0;
}

/**
 * A generated module still needs three lines nobody can write for it: its
 * entity in the list the persistence layer is built from, the call in the
 * composition root, and the import that makes the controller's decorators run.
 * Editing the user's own files to add them is how a generator starts mangling
 * code it did not write, so the CLI prints them instead.
 */
function wiringReminder(name: string, sourceRoot: string): void {
  const registerName = `register${capitalizePlural(name)}`;
  const moduleImport = `./modules/${kebab(name)}.module`;
  const registration = `${upperSnakePlural(name)}_ENTITY_REGISTRATION`;

  info("Three lines left, in your own files:");
  line(`  ${color.dim(path.join(sourceRoot, "composition", "entities.ts"))}`);
  line(`    import { ${registration} } from "${moduleImport}";`);
  line(`    ${color.dim("// ...and the same name inside the ENTITIES array")}`);
  line(`  ${color.dim(path.join(sourceRoot, "composition", "container.ts"))}`);
  line(`    import { ${registerName} } from "${moduleImport}";`);
  line(`    ${registerName}(root.container);`);
  line(`  ${color.dim(path.join(sourceRoot, "presentation", "routes.ts"))}`);
  line(`    import "./controllers/${kebab(name)}.controller";`);
  line();
  warn("the table has to exist in the database too; the generic repository does not create it");
}

/** Local, tiny copies so the reminder text does not import the whole naming module twice. */
function kebab(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase();
}

function capitalizePlural(raw: string): string {
  const pascal = kebab(raw)
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  return /[^aeiou]y$/i.test(pascal) ? `${pascal.slice(0, -1)}ies` : `${pascal}s`;
}

/** `invoice` -> `INVOICES`, the spelling the entity registration is named with. */
function upperSnakePlural(raw: string): string {
  return kebab(capitalizePlural(raw)).replace(/-/g, "_").toUpperCase();
}

/**
 * Flags a schematic can test, rebuilt from the marker rather than from the
 * answers: the project may have been edited since it was created, and its
 * `package.json` is the only record of what it actually is.
 */
function contextFor(project: MonoliteProject): RenderContext {
  const flags = new Set<string>();
  const engineId = (project.marker.database ?? "memory") as EngineId;
  const engine = ENGINES[engineId] ?? ENGINES.memory;

  if (project.marker.auth) flags.add("auth");
  if (engine.id === "memory") flags.add("memory");
  else {
    flags.add("db");
    flags.add(engine.id);
    flags.add(engine.family);
  }

  return {
    flags,
    vars: {
      projectName: project.name,
      apiPrefix: project.marker.apiPrefix ?? "/api/v1",
      dataSource: engine.dataSource,
      engineId: engine.id,
      engineLabel: engine.label,
    },
  };
}
