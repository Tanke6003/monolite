/**
 * Name handling: what npm accepts as a package name, and the four casings a
 * schematic needs to turn one word from the command line into a file name, a
 * class, a variable and a table.
 */

/** npm's own limit; longer names are rejected by the registry, not by us. */
const MAX_PACKAGE_NAME_LENGTH = 214;

const UNSCOPED = /^[a-z0-9][a-z0-9._-]*$/;
const SCOPED = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

/** `null` when the name is valid; otherwise the reason, ready to print. */
export function validatePackageName(name: string): string | null {
  if (!name) return "the name cannot be empty";
  if (name.length > MAX_PACKAGE_NAME_LENGTH) {
    return `the name cannot be longer than ${MAX_PACKAGE_NAME_LENGTH} characters`;
  }
  if (name.trim() !== name) return "the name cannot start or end with whitespace";
  if (name !== name.toLowerCase()) return "the name must be lowercase";
  if (name.startsWith(".") || name.startsWith("_")) {
    return "the name cannot start with a dot or an underscore";
  }
  if (name.startsWith("@")) {
    return SCOPED.test(name) ? null : "a scoped name looks like @scope/package";
  }
  return UNSCOPED.test(name) ? null : "use lowercase letters, digits, '-', '_' and '.' only";
}

/**
 * Best effort at turning whatever the user typed —or whatever the directory is
 * called— into something npm accepts, so the prompt can offer a default instead
 * of rejecting the obvious answer.
 */
export function toPackageName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@/-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+/g, "-")
    .replace(/-+$/, "");

  return cleaned.slice(0, MAX_PACKAGE_NAME_LENGTH) || "monolite-app";
}

/** Splits on anything that separates words, including camelCase boundaries. */
function words(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function toPascalCase(raw: string): string {
  return words(raw)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

export function toCamelCase(raw: string): string {
  const pascal = toPascalCase(raw);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function toKebabCase(raw: string): string {
  return words(raw)
    .map((word) => word.toLowerCase())
    .join("-");
}

export function toUpperSnakeCase(raw: string): string {
  return words(raw)
    .map((word) => word.toUpperCase())
    .join("_");
}

/**
 * English plural, the naive three rules.
 *
 * A scaffold names a route `/products` and a table `PRODUCTS`, and getting
 * `/persons` instead of `/people` costs one rename; pulling in an inflection
 * library to avoid that rename costs a dependency in every install.
 */
export function pluralize(raw: string): string {
  if (/[^aeiou]y$/i.test(raw)) return `${raw.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(raw)) return `${raw}es`;
  return `${raw}s`;
}

/**
 * Strips what would break the JSON of a generated `package.json` or the
 * Markdown of its README. Quoting properly at every injection point would mean
 * a second, escaped copy of every free-text answer; a description cannot
 * legitimately contain a control character, so it is cheaper to refuse them.
 */
export function sanitizeText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f"\\]/g, " ").replace(/\s+/g, " ").trim();
}
