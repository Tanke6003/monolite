import fs from "node:fs";
import path from "node:path";
import { renderName, renderText, type RenderContext } from "./render.js";

/**
 * npm rewrites a published `.gitignore` to `.npmignore`, so a template that
 * ships one under its real name arrives at the user's machine renamed and the
 * generated project has no ignore file at all. Storing it without the dot is
 * the standard workaround; the same treatment is applied to the other dotfiles
 * for consistency, so that anyone adding one does not have to remember which
 * names npm is opinionated about.
 */
const DOTFILES: Record<string, string> = {
  gitignore: ".gitignore",
  npmrc: ".npmrc",
  dockerignore: ".dockerignore",
  editorconfig: ".editorconfig",
  "env.example": ".env.example",
};

/** Records what a generator wrote, so the command can report it and stop. */
export class FileWriter {
  readonly written: string[] = [];

  constructor(
    private readonly root: string,
    private readonly force: boolean
  ) {}

  /** `true` if it wrote; `false` if the file existed and `--force` was not given. */
  write(relativePath: string, contents: string): boolean {
    const absolute = path.join(this.root, relativePath);

    if (!this.force && fs.existsSync(absolute)) return false;

    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, "utf8");
    this.written.push(relativePath.split(path.sep).join("/"));
    return true;
  }
}

/**
 * `package.json` is the one generated file whose commas depend on which
 * conditional branches survived, and a scaffold that produces JSON npm cannot
 * read is worse than one that produces no JSON at all. Rather than contorting
 * the template so every branch ends without a comma —which is unreadable and
 * breaks the next time someone adds a dependency— the output is re-parsed and
 * re-printed here, with the dangling commas removed first.
 */
export function normalizeJson(contents: string): string {
  const withoutDanglingCommas = contents.replace(/,(\s*[}\]])/g, "$1");

  try {
    return `${JSON.stringify(JSON.parse(withoutDanglingCommas), null, 2)}\n`;
  } catch {
    // A template that is not valid JSON at all is a bug in this package, but
    // failing the whole scaffold over formatting would be the wrong trade: the
    // user still gets the file and a parse error they can see.
    return contents;
  }
}

export interface CopyOptions {
  /** Absolute path of the template directory to walk. */
  source: string;
  context: RenderContext;
  /** Holds the destination root and the overwrite policy. */
  writer: FileWriter;
  /** Prefix inside the destination, for trees that render into a subdirectory. */
  into?: string;
}

/** Copies a template directory, rendering names and contents on the way. */
export function copyTemplateTree({ source, context, writer, into = "" }: CopyOptions): void {
  if (!fs.existsSync(source)) return;

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const renderedName = DOTFILES[entry.name] ?? renderName(entry.name, context);
    const relative = into ? path.join(into, renderedName) : renderedName;

    if (entry.isDirectory()) {
      copyTemplateTree({ source: path.join(source, entry.name), context, writer, into: relative });
      continue;
    }

    const origin = path.join(source, entry.name);
    let contents = renderText(fs.readFileSync(origin, "utf8"), context, origin);
    if (renderedName === "package.json") contents = normalizeJson(contents);

    writer.write(relative, contents);
  }
}

/** Entries other than the ones a fresh clone always has. */
export function directoryIsEmpty(directory: string): boolean {
  if (!fs.existsSync(directory)) return true;
  return fs.readdirSync(directory).length === 0;
}
