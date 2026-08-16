/**
 * Validation for the free-text answers that land in `package.json` verbatim.
 *
 * The project name has been checked since the first version because npm
 * refuses a bad one outright. `version` and `license` are quieter: npm takes
 * the manifest, writes it, and complains later or never — so `"license": "yes"`
 * ships. Asking again costs one keystroke; a published manifest with a nonsense
 * licence in it costs a release.
 */

/**
 * The SPDX ids worth spelling out, canonically cased.
 *
 * Not the full list — it runs to hundreds and npm does not enforce it — but
 * enough to accept `mit` for `MIT`, which is what people actually type.
 */
const KNOWN_LICENSES = [
  "MIT",
  "Apache-2.0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "GPL-2.0-only",
  "GPL-3.0-only",
  "LGPL-3.0-only",
  "AGPL-3.0-only",
  "MPL-2.0",
  "CC0-1.0",
  "Unlicense",
  "UNLICENSED",
];

/**
 * Answers to a yes/no question, which this never was.
 *
 * `? License (MIT):` reads like a confirmation to anyone moving quickly, and
 * the answer it invites —`yes`— is the one case worth naming in the error
 * instead of printing the generic list at someone who already misread it.
 */
const CONFIRMATIONS = new Set(["y", "yes", "n", "no", "true", "false"]);

const SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** One SPDX id, or several joined by the operators SPDX defines. */
const LICENSE_EXPRESSION =
  /^[A-Za-z0-9][A-Za-z0-9.+-]*(?: (?:OR|AND|WITH) [A-Za-z0-9][A-Za-z0-9.+-]*)*$/;

/** `null` when the version is valid; otherwise the reason, ready to print. */
export function validateVersion(version: string): string | null {
  if (!version) return "the version cannot be empty";
  return SEMVER.test(version) ? null : "use a semver version like 0.1.0";
}

/** `null` when the licence is valid; otherwise the reason, ready to print. */
export function validateLicense(license: string): string | null {
  if (!license) return "the license cannot be empty";

  if (CONFIRMATIONS.has(license.toLowerCase())) {
    return "this asks which license, not whether: MIT, Apache-2.0, or UNLICENSED to publish none";
  }

  // npm's own escape hatch for a licence that has no SPDX id.
  if (/^SEE LICENSE IN \S/.test(license)) return null;

  // A dual licence is conventionally written `(MIT OR Apache-2.0)`. Unwrapping
  // one layer is enough: this is a sanity check on what someone typed, not an
  // SPDX parser, and a malformed expression is npm's complaint to make.
  const expression =
    license.startsWith("(") && license.endsWith(")") ? license.slice(1, -1).trim() : license;

  return LICENSE_EXPRESSION.test(expression)
    ? null
    : "use an SPDX id like MIT, Apache-2.0 or ISC; UNLICENSED for a private project";
}

/**
 * Accepts `mit` for `MIT`, so a right answer in the wrong case is not an
 * error. Anything outside the known list is returned untouched: this
 * normalises, it does not police.
 */
export function normalizeLicense(license: string): string {
  const known = KNOWN_LICENSES.find((id) => id.toLowerCase() === license.toLowerCase());
  return known ?? license;
}
