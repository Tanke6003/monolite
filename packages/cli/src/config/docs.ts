/**
 * Everything that changes in a generated project when the API documentation
 * changes, in one table — the same shape `engines.ts` uses, for the same
 * reason: a new reader is a new row, not an `if` in the dependency list and
 * another in the template.
 *
 * The document itself is never optional. It is built from the decorator
 * metadata that produced the routes, so it costs nothing to publish and cannot
 * drift from the implementation. What this chooses is whether something is
 * mounted to read it with, and which.
 */

export type DocsUiId = "swagger" | "scalar" | "none";

export interface DocsUiSpec {
  id: DocsUiId;
  /** What the prompt shows. */
  label: string;
  /** The dim half-line beside it. */
  hint: string;
  /** Runtime packages the generated project needs. Only the chosen one's land. */
  dependencies: Record<string, string>;
  /** Types for a package that does not bundle its own. */
  devDependencies: Record<string, string>;
  /** Where the reader is served. Absent when there is nothing to serve. */
  path?: string;
}

/**
 * Versions are pinned the way the engine drivers are: to ranges this repository
 * generates against, so a scaffolded project starts on a combination known to
 * work rather than on whatever `latest` is that morning.
 */
export const DOCS_UIS: DocsUiSpec[] = [
  {
    id: "swagger",
    label: "Swagger UI",
    hint: "the familiar one, with Try it out",
    dependencies: { "swagger-ui-express": "^5.0.1" },
    devDependencies: { "@types/swagger-ui-express": "^4.1.8" },
    path: "/docs",
  },
  {
    id: "scalar",
    label: "Scalar",
    hint: "modern reader, dark mode, built-in client",
    dependencies: { "@scalar/express-api-reference": "^0.10.14" },
    devDependencies: {},
    path: "/docs",
  },
  {
    id: "none",
    label: "None",
    hint: "still serves /openapi.json, just nothing to read it with",
    dependencies: {},
    devDependencies: {},
  },
];

/** Spellings `--docs` accepts beyond the ids themselves. */
const ALIASES: Record<string, DocsUiId> = {
  "swagger-ui": "swagger",
  swaggerui: "swagger",
  openapi: "none",
  no: "none",
  off: "none",
};

export function docsUiAliases(): string[] {
  return [...DOCS_UIS.map((ui) => ui.id), ...Object.keys(ALIASES)];
}

/**
 * `undefined` when nothing matches, so the caller can say what was passed
 * rather than silently falling back to a default nobody asked for.
 */
export function resolveDocsUi(raw: string): DocsUiSpec | undefined {
  const key = raw.trim().toLowerCase();
  const id = ALIASES[key] ?? key;

  return DOCS_UIS.find((ui) => ui.id === id);
}

/** What the prompt and the README call it, in a sentence. */
export function docsSentence(ui: DocsUiSpec): string {
  return ui.path
    ? `${ui.label}, served at ${ui.path}`
    : "the OpenAPI document only, with no reader mounted";
}
