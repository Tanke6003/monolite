/**
 * The release, end to end: read the commits, decide the version, write it,
 * publish, and record what happened in a tag.
 *
 * Run by CI on a push to master, and runnable by hand with `--dry-run` to see
 * what a merge would do before merging it.
 *
 * **The push comes before the publish, and that is the whole lesson here.**
 *
 * It used to be the other way round, on the reasoning that publishing is the
 * only irreversible step so everything that can fail should fail first. The
 * reasoning had the trade backwards. A push is not a formality that either
 * works or is worth retrying: it can be *rejected*, permanently, because
 * somebody merged another pull request while this run was building — and a
 * rejection after the publish leaves the registry ahead of the repository with
 * no way back, because a published version cannot be recalled.
 *
 * That is not a hypothesis. v0.4.0 went out that way: seven packages on the
 * registry, a tag pointing at a commit no branch contained, and a manifest
 * still saying 0.3.0.
 *
 * Pushing first inverts every one of those costs. If the push is rejected,
 * nothing has been published, nothing has been promised, and the next run —
 * which will see the newer master — does the release properly. The registry
 * briefly lagging the repository is the failure mode that a re-run fixes.
 */

import { execFileSync } from "node:child_process";

import { applyVersion, currentVersion, publishOrder, ROOT } from "./apply.mjs";
import { baseVersion, plan } from "./plan.mjs";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const dryRun = process.argv.includes("--dry-run");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function npm(...args) {
  execFileSync(NPM, args, { cwd: ROOT, encoding: "utf8", stdio: "inherit" });
}

/**
 * The branch this release belongs on.
 *
 * Named explicitly in the push rather than left to `HEAD`, because a checkout
 * in CI can leave the working tree detached and `git push origin HEAD` then
 * means something different — or nothing at all. `GITHUB_REF_NAME` is what the
 * runner already knows; the git call is for running this by hand.
 */
function branch() {
  return process.env.GITHUB_REF_NAME || git("rev-parse", "--abbrev-ref", "HEAD");
}

/** The newest `v*` tag, or `null` on a repository that has never released. */
function lastTag() {
  const tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean);
  return tags[0] ?? null;
}

/**
 * Whole commit messages, bodies included, since the last release.
 *
 * Split on a record separator rather than a newline because the body is where
 * `BREAKING CHANGE:` lives, and a footer that gets cut off is a major release
 * that silently becomes a patch.
 */
function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD";

  return git("log", "--format=%B%x1e", range)
    .split("\x1e")
    .map((message) => message.trim())
    .filter(Boolean);
}

/** A version already on the registry is a step to skip, not a run to fail. */
function isPublished(name, version) {
  try {
    const output = execFileSync(NPM, ["view", `${name}@${version}`, "version"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output.trim().length > 0;
  } catch {
    // A package that does not exist yet answers with a 404, which is a normal
    // answer on a first release rather than a failure.
    return false;
  }
}

const tag = lastTag();
const manifestVersion = currentVersion();

if (!tag) {
  log("! no v* tag found, so every commit in the history counts towards the bump");
  log(`  tag the released commit —git tag v${manifestVersion}— if that is not what you want`);
}

// The tag wins when the two disagree, because a tag is only written after the
// registry has one of these, whereas a manifest can be left behind by a run
// that got part of the way. Reading the manifest alone is what turned one
// half-finished release into a run that failed identically for ever.
const version = baseVersion(manifestVersion, tag);

if (version !== manifestVersion) {
  log(`! the manifest says ${manifestVersion} but ${tag} is tagged, so ${version} is the base`);
  log("  a previous run published and tagged without pushing its version commit");
}

const messages = commitsSince(tag);
log(`${messages.length} commit(s) since ${tag ?? "the start of the history"}`);

const decision = plan(version, messages);

if (!decision) {
  log("nothing user-facing in the range, so no release");
  process.exit(0);
}

log(`${version} -> ${decision.version} (${decision.type})`);

if (dryRun) {
  log("dry run, so nothing was written, published or pushed");
  process.exit(0);
}

for (const file of applyVersion(decision.version)) log(`  update ${file}`);

// The published tarballs come out of `dist`, so the build has to happen after
// the version is written and before anything is packed.
npm("run", "build");

git("add", "-A");
git("commit", "-m", `chore(release): v${decision.version}`);
git("tag", "-a", `v${decision.version}`, "-m", `v${decision.version}`);

// Atomically, and before anything is published. `--atomic` is what stops the
// half-state this whole ordering exists to prevent: without it the tag is a new
// ref and goes through even when the branch is rejected, which is how v0.4.0
// came to point at a commit no branch contained.
//
// A rejection here is not an error to shout about. It means somebody merged
// while this run was building, so master already has more than this release
// would describe — and the push that overtook us has a run of its own that will
// do it properly. Nothing has been published, so there is nothing to undo.
try {
  git("push", "--atomic", "origin", `HEAD:refs/heads/${branch()}`, `refs/tags/v${decision.version}`);
} catch {
  log(`master moved while this run was working, so v${decision.version} was not released`);
  log("  the push that overtook this one has a run of its own; nothing was published");
  process.exit(0);
}

for (const name of publishOrder()) {
  if (isPublished(name, decision.version)) {
    log(`  skip ${name}@${decision.version}, already on the registry`);
    continue;
  }

  // `--provenance` attaches a signed statement linking this tarball to the
  // commit and the workflow run that built it, which npm shows on the package
  // page and anybody can verify. It needs the OIDC token the release job
  // already has, so it costs a flag.
  //
  // For a toolkit asking people to install seven packages from one publisher,
  // "built from this commit, by this workflow" is worth more than any wording
  // in a README.
  npm("publish", "-w", name, "--access", "public", "--provenance");
}

log(`released v${decision.version}`);
