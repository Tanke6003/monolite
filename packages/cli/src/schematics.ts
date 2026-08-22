import path from "node:path";
import { templatePath } from "./templates.js";
import { copyTemplateTree, type FileWriter } from "./util/files.js";
import { pluralize, toCamelCase, toKebabCase, toPascalCase, toUpperSnakeCase } from "./util/naming.js";
import type { RenderContext } from "./util/render.js";

export const SCHEMATICS = [
  "module",
  "entity",
  "bll",
  "controller",
  "query",
  "repository",
] as const;

/**
 * Names that used to work, so a script or a habit does not simply fail.
 *
 * `service` was the schematic until the layer was renamed. It still resolves,
 * with a line saying what it resolved to — an unrecognised subcommand is a
 * worse answer than a redirect, and this costs one line and one map.
 */
export const RENAMED_SCHEMATICS: Record<string, Schematic> = { service: "bll" };

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
  bll: ["bll"],
  controller: ["controller"],
  module: ["entity", "bll", "controller", "module"],
  // Its own tree rather than a composition of the others: a query has no
  // entity, its business layer maps rows instead of a mapper, and its controller is
  // written by hand because there is no resource for `@Crud` to describe.
  query: ["query"],
  // Not part of `module`: an entity gets a working repository from
  // `defineEntity` alone, and a class that forwards seventeen methods and adds
  // nothing is a layer for the sake of having one. This is generated the day a
  // module needs a query the generic API does not express.
  repository: ["repository"],
};

/** The schematics that need `--over`; see `overVars`. */
export const NEEDS_OVER: readonly Schematic[] = ["query"];

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
    bllToken: `I${plural}BLL`,
    // Bound only once `generate repository` has run; until then it is a name
    // nobody asks for, which costs a line and saves the generator from having
    // to reopen a file somebody has been editing.
    repositoryToken: `I${plural}Repository`,
    controllerToken: `I${plural}Controller`,
    registerFn: `register${plural}`,
    dtoName: `${singular}DTO`,
    mapperName: `${toCamelCase(singular)}Mapper`,
    // No article: `@Crud` builds its own prose around it —"Create <resource>",
    // "No <resource> found with that id"— and a label that carried one produced
    // "No the product found with that id" in every generated document.
    resourceLabel: toKebabCase(rawName).replace(/-/g, " "),
  };
}

/**
 * The entity a query reads, under its own set of names.
 *
 * A query owns no table, so the one thing a generator cannot derive from the
 * name typed is *what it reads*. One entity, because that is what a flag can
 * carry; a report over three injects three stores the same way, and the
 * generated file says so.
 */
export function overVars(rawName: string): Record<string, string> {
  const entity = entityVars(rawName);

  return {
    overName: entity.entityName,
    overCamel: entity.entityCamel,
    overKebab: entity.entityKebab,
    overUpper: entity.entityUpper,
    overPlural: entity.entityPlural,
    overPluralCamel: entity.entityPluralCamel,
    overPluralUpper: entity.entityPluralUpper,
    overPkProperty: entity.pkProperty,
  };
}

export interface RenderSchematicOptions {
  schematic: Schematic;
  name: string;
  /** The entity a query reads; required for the schematics in `NEEDS_OVER`. */
  over?: string;
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
  over,
  project,
  writer,
  sourceRoot,
}: RenderSchematicOptions): void {
  if (NEEDS_OVER.includes(schematic) && !over) {
    throw new Error(`the "${schematic}" schematic needs the entity it reads: --over <entity>`);
  }

  const context: RenderContext = {
    flags: project.flags,
    vars: { ...project.vars, ...entityVars(name), ...(over ? overVars(over) : {}) },
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
