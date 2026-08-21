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
import { wireModule } from "../util/wiring.js";

const OPTIONS = {
  force: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "no-color": { type: "boolean" },
  /**
   * Leaves `composition/modules.ts` alone.
   *
   * For anyone whose list is not where the scaffold put it, and for the person
   * who would simply rather a generator did not touch their files. The line to
   * add is printed either way.
   */
  "no-wire": { type: "boolean" },
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

  return emit(project, schematicName, entityName, {
    force: Boolean(parsed.values.force),
    wire: !parsed.values["no-wire"],
  });
}

interface EmitOptions {
  force: boolean;
  /** Whether the module may be inserted into the list; see `wireModule`. */
  wire: boolean;
}

function emit(
  project: MonoliteProject,
  schematic: Schematic,
  name: string,
  options: EmitOptions
): number {
  const writer = new FileWriter(project.root, options.force);
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

  if (schematic === "module") reportWiring(project.root, project.sourceRoot, name, options.wire);
  return 0;
}

/**
 * Puts the module in the one list it belongs in, and says what it did.
 *
 * It used to print three lines for the developer to type, because editing
 * somebody's own files is how a generator starts mangling code it did not
 * write. What changed is not the caution — it is that the target is now a
 * single line above a marker the scaffold put there, which is small enough to
 * insert and to check. When the marker is gone, so is the licence: the command
 * falls back to printing, which is exactly what it always did.
 */
function reportWiring(root: string, sourceRoot: string, name: string, wire: boolean): void {
  const wiring = wire ? wireModule(root, sourceRoot, name) : null;

  if (wiring?.wired) {
    info(`Wired into ${color.bold(wiring.file)}:`);
    for (const inserted of wiring.lines) line(`    ${inserted}`);
  } else {
    const reason = wiring?.reason ? ` (${wiring.reason})` : "";
    const file = wiring?.file ?? path.join(sourceRoot, "composition", "modules.ts");

    info(`One line left, in ${color.bold(file)}${reason}:`);
    for (const inserted of wiring?.lines ?? []) line(`    ${inserted}`);
  }

  line();
  warn("the table has to exist in the database too; the generic repository does not create it");
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
