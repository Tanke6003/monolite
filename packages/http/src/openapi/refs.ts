// The one failure mode a generated document has that nothing else catches: a
// `$ref` to a component nobody registered.
//
// The route metadata names its schemas by string —`@Crud({ dto: "Product" })`
// emits `#/components/schemas/Product`— and the components come from whichever
// DTO modules happened to be loaded. Nothing forces the two halves to meet, and
// when they do not the document is still valid JSON and still serves with a
// 200: the reader is the only thing that notices, and all it says is that it
// could not resolve a reference. Swagger UI renders the operation with an empty
// body; Scalar shows nothing at all.
//
// So it is checked, once, at the point the document is built, and reported by
// name instead of being left for someone to spot in a browser.

/** `#/components/schemas/Product` -> `Product`; anything else -> `null`. */
function schemaNameOf(ref: string): string | null {
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  // A `$ref` into another document, or into a part of this one that is not the
  // schema components, is somebody else's to resolve.
  return match ? decodeURIComponent(match[1]) : null;
}

function collectRefs(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return;
  }
  if (node === null || typeof node !== "object") return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") {
      const name = schemaNameOf(value);
      if (name) found.add(name);
      continue;
    }
    collectRefs(value, found);
  }
}

/**
 * Components the document points at and does not define, sorted and without
 * repeats. An empty array means every reference resolves.
 *
 * Typically one of two mistakes: the DTO was never declared with
 * {@link defineDto}, or it was declared in a module nothing imports for its
 * value — a `import type { ProductDTO }` is erased at compile time, so the
 * `defineDto` beside it never runs and the component never exists.
 */
export function missingSchemaRefs(document: unknown): string[] {
  const referenced = new Set<string>();
  collectRefs(document, referenced);

  const components = (document as { components?: { schemas?: Record<string, unknown> } })
    ?.components?.schemas;
  const defined = new Set(Object.keys(components ?? {}));

  return [...referenced].filter((name) => !defined.has(name)).sort();
}
