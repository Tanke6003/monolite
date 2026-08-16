import path from "node:path";

/**
 * Where the template tree lives at runtime.
 *
 * `templates/` sits next to `dist/` and outside `src/` deliberately: the
 * templates are TypeScript that must *not* be type-checked or compiled by this
 * package —they import `monolite-*` packages the CLI does not depend on, and
 * they contain placeholders that are not valid syntax— so they have to be
 * outside the `include` of `tsconfig.json`. Both directories are listed in
 * `files`, so both ship.
 */
export const TEMPLATES_ROOT = path.resolve(__dirname, "..", "templates");

export const templatePath = (...segments: string[]): string =>
  path.join(TEMPLATES_ROOT, ...segments);
