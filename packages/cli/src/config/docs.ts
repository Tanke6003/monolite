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

export type DocsUiId = "swagger" | "scalar" | "both" | "none";

/** A reader, as the template and the security policy know it. */
export type DocsReader = "swagger" | "scalar";

export interface DocsMount {
  reader: DocsReader;
  /** Where it is served. */
  path: string;
}

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
  /** What gets mounted, and where. Empty when there is nothing to read with. */
  mounts: DocsMount[];
}

/**
 * Versions are pinned the way the engine drivers are: to ranges this repository
 * generates against, so a scaffolded project starts on a combination known to
 * work rather than on whatever `latest` is that morning.
 */
const SWAGGER_DEPENDENCIES = { "swagger-ui-express": "^5.0.1" };
const SWAGGER_DEV_DEPENDENCIES = { "@types/swagger-ui-express": "^4.1.8" };
const SCALAR_DEPENDENCIES = { "@scalar/express-api-reference": "^0.10.14" };

export const DOCS_UIS: DocsUiSpec[] = [
  {
    id: "swagger",
    label: "Swagger UI",
    hint: "the familiar one, with Try it out",
    dependencies: SWAGGER_DEPENDENCIES,
    devDependencies: SWAGGER_DEV_DEPENDENCIES,
    mounts: [{ reader: "swagger", path: "/docs" }],
  },
  {
    id: "scalar",
    label: "Scalar",
    hint: "modern reader, dark mode, built-in client",
    dependencies: SCALAR_DEPENDENCIES,
    devDependencies: {},
    mounts: [{ reader: "scalar", path: "/docs" }],
  },
  {
    id: "both",
    label: "Both",
    hint: "Swagger UI at /docs, Scalar at /reference",
    dependencies: { ...SWAGGER_DEPENDENCIES, ...SCALAR_DEPENDENCIES },
    devDependencies: SWAGGER_DEV_DEPENDENCIES,
    // One document, two pages over it. They cost nothing to run side by side —
    // both fetch `/openapi.json` rather than carrying a copy — and which one a
    // reader reaches for is a matter of taste that a scaffold should not have
    // to settle. Swagger UI keeps `/docs` so the address does not move when
    // this is chosen instead of the first row.
    mounts: [
      { reader: "swagger", path: "/docs" },
      { reader: "scalar", path: "/reference" },
    ],
  },
  {
    id: "none",
    label: "None",
    hint: "still serves /openapi.json, just nothing to read it with",
    dependencies: {},
    devDependencies: {},
    mounts: [],
  },
];

/** Spellings `--docs` accepts beyond the ids themselves. */
const ALIASES: Record<string, DocsUiId> = {
  "swagger-ui": "swagger",
  swaggerui: "swagger",
  all: "both",
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

/** Where a given reader is served, if it is. */
export function docsPathOf(ui: DocsUiSpec, reader: DocsReader): string {
  return ui.mounts.find((mount) => mount.reader === reader)?.path ?? "";
}

/**
 * The address to point someone at. The first mount, because that is the one the
 * prompt's own wording leads with.
 */
export function primaryDocsPath(ui: DocsUiSpec): string {
  return ui.mounts[0]?.path ?? "";
}

/**
 * Which reader the Content-Security-Policy has to accommodate.
 *
 * Scalar wins whenever it is mounted: its page loads from a CDN, which is the
 * wider of the two policies, and a project serving both needs the wider one.
 */
export function docsCspReader(ui: DocsUiSpec): DocsReader | "none" {
  if (ui.mounts.some((mount) => mount.reader === "scalar")) return "scalar";
  return ui.mounts.length > 0 ? "swagger" : "none";
}

/** What the prompt and the README call it, in a sentence. */
export function docsSentence(ui: DocsUiSpec): string {
  if (ui.mounts.length === 0) return "the OpenAPI document only, with no reader mounted";

  const readers = new Intl.ListFormat("en").format(
    ui.mounts.map((mount) => `${label(mount.reader)} at ${mount.path}`)
  );

  return readers;
}

function label(reader: DocsReader): string {
  return reader === "swagger" ? "Swagger UI" : "Scalar";
}
