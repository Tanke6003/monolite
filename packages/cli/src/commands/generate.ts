import path from "node:path";
import { parseArgs } from "node:util";

import { ENGINES, type EngineId } from "../config/engines.js";
import { printGenerateHelp } from "../help.js";
import { findProject, type MonoliteProject } from "../project.js";
import {
  entityVars,
  isSchematic,
  NEEDS_OVER,
  RENAMED_SCHEMATICS,
  renderSchematic,
  SCHEMATICS,
  type Schematic,
} from "../schematics.js";
import { color } from "../util/colors.js";
import { FileWriter } from "../util/files.js";
import { created, fail, hint, info, line, title, warn } from "../util/log.js";
import type { RenderContext } from "../util/render.js";
import { wireBinding, wireModule } from "../util/wiring.js";

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
  /**
   * The entity a query reads.
   *
   * The one thing a generator cannot derive from the name typed: `generate
   * module invoice` knows its table is `INVOICES`, but `generate query
   * revenue` could be reading any of them.
   */
  over: { type: "string" },
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

  const renamed = RENAMED_SCHEMATICS[schematicName];

  if (renamed) {
    // A redirect rather than a failure: the schematic did not go away, it was
    // renamed with the layer, and telling somebody their command is unknown
    // when the thing it asks for still exists is the worse answer.
    info(`"${schematicName}" is now "${renamed}"; generating that`);
    line();
  }

  const schematic = renamed ?? schematicName;

  if (!isSchematic(schematic)) {
    fail(`unknown schematic "${schematic}"`);
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

  const over = parsed.values.over;

  if (NEEDS_OVER.includes(schematic) && !over) {
    fail(`the "${schematic}" schematic needs the entity it reads`);
    hint(`usage: monolite generate ${schematic} ${entityName} --over <entity>`);
    hint("a query owns no table; --over names the one whose store it injects");
    return 1;
  }

  return emit(project, schematic, entityName, {
    force: Boolean(parsed.values.force),
    wire: !parsed.values["no-wire"],
    over,
  });
}

interface EmitOptions {
  force: boolean;
  /** Whether the module may be inserted into the list; see `wireModule`. */
  wire: boolean;
  /** The entity a query reads; see the `over` flag. */
  over?: string;
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
    renderSchematic({
      schematic,
      name,
      over: options.over,
      project: contextFor(project),
      writer,
      sourceRoot,
    });
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

  // Both write a module descriptor, so both belong in the one list. What
  // differs is only that a query's carries no registration.
  if (schematic === "module" || schematic === "query") {
    reportWiring(project.root, project.sourceRoot, name, options.wire, schematic);
  }

  // A repository is not a module; it is one binding inside one that already
  // exists, which is why it goes through a marker of its own.
  if (schematic === "repository") {
    reportBinding(project.root, project.sourceRoot, name, options.wire);
  }

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
function reportWiring(
  root: string,
  sourceRoot: string,
  name: string,
  wire: boolean,
  schematic: Schematic
): void {
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

  if (schematic === "query") {
    // Nothing to warn about a table it does not own; what is worth saying is
    // that the aggregate is a placeholder.
    hint("the aggregate in the repository is a starting point — replace it with your own");
    return;
  }

  warn("the table has to exist in the database too; the generic repository does not create it");
  // It used to end there, which left the reader to write the DDL by hand from
  // the mapping they had just generated — two descriptions of one schema, kept
  // in agreement by nobody.
  hint("`db:sql` writes it from the entity you just generated; `db:migration` writes the change");
}

/**
 * Registers a generated repository in the module it belongs to.
 *
 * Unlike a module, this one is written into a file the developer already owns
 * and has probably edited — which is the situation a generator has to be
 * careful in, and exactly what the marker makes safe. No marker, no edit: the
 * two lines are printed instead, which is what the command did before any of
 * this was automated.
 */
function reportBinding(root: string, sourceRoot: string, name: string, wire: boolean): void {
  const vars = entityVars(name);
  const constant = `${vars.entityPlural}Repository`;

  const binding = {
    constant,
    importLine:
      `import { ${constant} } from ` +
      `"../../infrastructure/persistence/${vars.entityKebab}.repository";`,
    register:
      `  container.register(${vars.entityUpper}_TOKENS.repository, ` +
      `{ useClass: ${constant} });`,
  };

  const wiring = wire ? wireBinding(root, sourceRoot, vars.entityKebab, binding) : null;

  if (wiring?.wired) {
    info(`Registered in ${color.bold(wiring.file)}:`);
    for (const inserted of wiring.lines) line(`    ${inserted}`);
  } else {
    const reason = wiring?.reason ? ` (${wiring.reason})` : "";
    const file =
      wiring?.file ??
      path.join(sourceRoot, "composition", "modules", `${vars.entityKebab}.module.ts`);

    info(`Two lines left, in ${color.bold(file)}${reason}:`);
    for (const inserted of [binding.importLine, binding.register.trim()]) line(`    ${inserted}`);
  }

  line();
  hint(
    "inject it in the BLL with `@inject(TOKENS.repository)` where the plain store is today"
  );
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
