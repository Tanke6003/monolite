import path from "node:path";
import { templatePath } from "./templates.js";
import { copyTemplateTree, type FileWriter } from "./util/files.js";
import { pluralize, toCamelCase, toKebabCase, toPascalCase, toUpperSnakeCase } from "./util/naming.js";
import type { RenderContext } from "./util/render.js";

export const SCHEMATICS = ["module", "entity", "service", "controller"] as const;

export type Schematic = (typeof SCHEMATICS)[number];

export function isSchematic(value: string): value is Schematic {
  return (SCHEMATICS as readonly string[]).includes(value);
}

/**
 * A `module` is not a template of its own but the other three plus the file
 * that registers them. Keeping it a composition rather than a fourth copy is
 * what guarantees that `generate module invoice` and `generate entity invoice`
 * produce the very same entity file.
 */
const PARTS: Record<Schematic, string[]> = {
  entity: ["entity"],
  service: ["service"],
  controller: ["controller"],
  module: ["entity", "service", "controller", "module"],
};

/**
 * Every name a module needs, derived from the one word the user typed.
 *
 * They are derived rather than asked because they are not independent choices:
 * a project where the route is `/invoices`, the table is `INVOICE` and the
 * class is `BillController` is a project nobody can navigate. The scaffold
 * picks one convention —the reference project's— and applies it everywhere.
 */
export function entityVars(rawName: string): Record<string, string> {
  const singular = toPascalCase(rawName);
  if (!singular) throw new Error(`"${rawName}" does not contain a usable name`);

  const plural = pluralize(singular);
  const kebab = toKebabCase(rawName);

  return {
    entityName: singular,
    entityCamel: toCamelCase(singular),
    entityKebab: kebab,
    entityUpper: toUpperSnakeCase(singular),
    entityPlural: plural,
    entityPluralCamel: toCamelCase(plural),
    entityPluralKebab: pluralize(kebab),
    entityPluralUpper: toUpperSnakeCase(plural),
    // The reference project names primary keys `pkUser` / `PK_USER`; the
    // generic repository does not care, but a project whose tables disagree
    // with each other does.
    pkProperty: `pk${singular}`,
    pkColumn: `PK_${toUpperSnakeCase(singular)}`,
    routePath: `/${pluralize(kebab)}`,
    entityConst: `${toUpperSnakeCase(plural)}_ENTITY`,
    storeToken: `${plural}Store`,
    serviceToken: `I${plural}Service`,
    controllerToken: `I${plural}Controller`,
    registerFn: `register${plural}`,
    dtoName: `${singular}DTO`,
    mapperName: `${toCamelCase(singular)}Mapper`,
    resourceLabel: `the ${toKebabCase(rawName).replace(/-/g, " ")}`,
  };
}

export interface RenderSchematicOptions {
  schematic: Schematic;
  name: string;
  /** Project-level variables and flags; the entity names are merged on top. */
  project: RenderContext;
  writer: FileWriter;
  /** Source root relative to the project root, e.g. `src`. */
  sourceRoot: string;
}

/**
 * Renders a schematic into a project. Shared by `generate` and by `new`, which
 * builds its example module through exactly this path — so the sample code a
 * user reads on day one is byte-for-byte what the generator will produce for
 * them on day two.
 */
export function renderSchematic({
  schematic,
  name,
  project,
  writer,
  sourceRoot,
}: RenderSchematicOptions): void {
  const context: RenderContext = {
    flags: project.flags,
    vars: { ...project.vars, ...entityVars(name) },
  };

  for (const part of PARTS[schematic]) {
    copyTemplateTree({
      source: templatePath("generate", part),
      context,
      writer,
      into: sourceRoot === "." ? "" : path.normalize(sourceRoot),
    });
  }
}
