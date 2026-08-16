/**
 * Which release a set of commits adds up to.
 *
 * Kept apart from the script that acts on it because this is the half that can
 * be wrong without anyone noticing. A `feat:` read as a patch ships a feature
 * under a version that promised none, and by the time that is visible the
 * version is published and immutable. Everything here is a pure function, so
 * the decision can be tested without a git history or a registry.
 */

/** Conventional Commits, as much of the grammar as a release decision needs. */
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s+(?<subject>.+)$/;

/** A footer says it too, and says it in commits whose header never did. */
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

const MINOR_TYPES = new Set(["feat"]);

/**
 * `revert` is in because reverting a fix is itself a change users receive;
 * `docs`, `test`, `chore`, `ci`, `style` and `refactor` are deliberately out —
 * they do not change what an installed package does, and cutting a version for
 * them trains everyone to ignore the version.
 */
const PATCH_TYPES = new Set(["fix", "perf", "revert"]);

/** `null` for anything that is not a Conventional Commit; those simply do not vote. */
export function parseCommit(message) {
  const [header = "", ...rest] = message.split("\n");
  const match = HEADER.exec(header.trim());
  if (!match) return null;

  const { type, scope, breaking, subject } = match.groups;

  return {
    type,
    scope: scope || null,
    subject,
    breaking: Boolean(breaking) || BREAKING_FOOTER.test(rest.join("\n")),
  };
}

/**
 * The strongest bump any one commit asks for. `null` when nothing in the range
 * is user-visible, which is a normal outcome and not an error: a branch of
 * docs and tests should land on master without cutting a version.
 */
export function releaseType(messages) {
  let level = null;

  for (const message of messages) {
    const commit = parseCommit(message);
    if (!commit) continue;

    // Nothing outranks a breaking change, so there is no reason to keep reading.
    if (commit.breaking) return "major";

    if (MINOR_TYPES.has(commit.type)) level = "minor";
    else if (PATCH_TYPES.has(commit.type) && level === null) level = "patch";
  }

  return level;
}

/**
 * Applies a bump to a version.
 *
 * Below 1.0 the major number is not a promise yet, so a breaking change moves
 * the minor rather than declaring 1.0 off the back of a single commit —
 * announcing stability is a decision a person makes, not one a commit message
 * makes for them.
 */
export function nextVersion(current, type) {
  if (!type) return null;

  const core = current.split("-")[0].split("+")[0];
  const [major, minor, patch] = core.split(".").map(Number);

  if ([major, minor, patch].some((part) => !Number.isInteger(part))) {
    throw new Error(`cannot bump "${current}": it is not a semver version`);
  }

  const effective = major === 0 && type === "major" ? "minor" : type;

  switch (effective) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`unknown release type "${type}"`);
  }
}

/**
 * The whole decision in one call: `null` when this range releases nothing.
 */
export function plan(currentVersion, messages) {
  const type = releaseType(messages);
  if (!type) return null;

  return { type, version: nextVersion(currentVersion, type) };
}
