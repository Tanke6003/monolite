import fs from "node:fs";
import path from "node:path";

import { toKebabCase, toUpperSnakeCase } from "./naming.js";

/**
 * Adding a generated module to the list the application is built from.
 *
 * This used to be three lines in three files that the CLI printed and the
 * developer typed. It is one line in one file now — that is what the module
 * descriptor bought — and one line in one file is something a generator can
 * insert without becoming the kind of tool that mangles code it did not write.
 *
 * The safety is entirely in the marker. `composition/modules.ts` ships with
 * `// monolite:modules` in it, and this writes immediately above it. If the
 * marker has been moved, renamed or deleted, nothing is touched and the command
 * says what to add — the same as before, but for the one case in a hundred
 * instead of every time.
 *
 * **No AST, on purpose.** `monolite-cli` has no runtime dependencies, and
 * pulling in `typescript` or `ts-morph` to add a line to a list would spend that
 * on the cheapest edit in the project. A marker is enough precisely because the
 * descriptor reduced the target to one line in one file; it would not have been
 * enough for the three-file version, which is the real reason that one was never
 * automated.
 */

export const MODULES_MARKER = "// monolite:modules";

export interface WiringResult {
  /** `true` when the file was edited. */
  wired: boolean;
  /** What was inserted, or what to insert by hand. */
  lines: string[];
  /** Why it was not done, when it was not. */
  reason?: string;
  /** Path of the list, relative to the project root, for the message. */
  file: string;
}

/**
 * Inserts a module into `composition/modules.ts`.
 *
 * Idempotent: a module already in the list is left alone and reported as such,
 * so re-running `generate module --force` over an existing module does not add
 * it twice.
 */
export function wireModule(root: string, sourceRoot: string, name: string): WiringResult {
  const relative = path.join(path.relative(root, sourceRoot) || ".", "composition", "modules.ts");
  const absolute = path.join(sourceRoot, "composition", "modules.ts");

  const constant = `${toUpperSnakeCase(name)}_MODULE`;
  const from = `./modules/${toKebabCase(name)}.module`;
  const importLine = `import { ${constant} } from "${from}";`;
  const entry = `  ${constant},`;
  const lines = [importLine, entry.trim()];

  if (!fs.existsSync(absolute)) {
    return { wired: false, lines, file: relative, reason: "it is not there" };
  }

  const source = fs.readFileSync(absolute, "utf8");

  if (source.includes(constant)) {
    return { wired: false, lines, file: relative, reason: "it is already listed" };
  }

  if (!source.includes(MODULES_MARKER)) {
    return {
      wired: false,
      lines,
      file: relative,
      reason: `it no longer has its ${MODULES_MARKER} marker`,
    };
  }

  const rows = source.split("\n");

  // Immediately above the marker, so the list stays in the order modules were
  // generated and the marker stays at the bottom where the next one goes.
  const markerAt = rows.findIndex((row) => row.trim() === MODULES_MARKER);
  rows.splice(markerAt, 0, entry);

  // After the last import, which is where a person would have put it. Searching
  // from the top rather than tracking an index keeps this correct whatever the
  // file grew in the meantime.
  const lastImport = rows.reduce(
    (found, row, index) => (row.startsWith("import ") ? index : found),
    -1
  );
  rows.splice(lastImport + 1, 0, importLine);

  fs.writeFileSync(absolute, rows.join("\n"), "utf8");

  return { wired: true, lines, file: relative };
}

export const BINDINGS_MARKER = "// monolite:bindings";

/**
 * Registers a generated repository in its module's `register` function.
 *
 * The same trick as `wireModule` and for the same reason: the target is one
 * line above a marker the scaffold put there, which is small enough to insert
 * and to check. A repository is generated *after* its module, so the file it
 * belongs in already exists and is one the developer owns — which is exactly
 * the situation a generator has to be careful in, and exactly what the marker
 * makes safe. Take the marker away and it goes back to printing.
 *
 * Two lines rather than one, because the class has to be imported before it can
 * be bound; they are inserted at the two places a person would have put them.
 */
export function wireBinding(
  root: string,
  sourceRoot: string,
  moduleKebab: string,
  binding: { importLine: string; register: string; constant: string }
): WiringResult {
  const relative = path.join(
    path.relative(root, sourceRoot) || ".",
    "composition",
    "modules",
    `${moduleKebab}.module.ts`
  );
  const absolute = path.join(sourceRoot, "composition", "modules", `${moduleKebab}.module.ts`);
  const lines = [binding.importLine, binding.register.trim()];

  if (!fs.existsSync(absolute)) {
    return { wired: false, lines, file: relative, reason: "there is no module for it yet" };
  }

  const source = fs.readFileSync(absolute, "utf8");

  if (source.includes(binding.constant)) {
    return { wired: false, lines, file: relative, reason: "it is already registered" };
  }

  if (!source.includes(BINDINGS_MARKER)) {
    return {
      wired: false,
      lines,
      file: relative,
      reason: `it no longer has its ${BINDINGS_MARKER} marker`,
    };
  }

  const rows = source.split("\n");

  const markerAt = rows.findIndex((row) => row.trim() === BINDINGS_MARKER);
  rows.splice(markerAt, 0, binding.register);

  const lastImport = rows.reduce(
    (found, row, index) => (row.startsWith("import ") ? index : found),
    -1
  );
  rows.splice(lastImport + 1, 0, binding.importLine);

  fs.writeFileSync(absolute, rows.join("\n"), "utf8");

  return { wired: true, lines, file: relative };
}
