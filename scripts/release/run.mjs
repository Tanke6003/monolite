/**
 * The release, end to end: read the commits, decide the version, write it,
 * publish, and record what happened in a tag.
 *
 * Run by CI on a push to master, and runnable by hand with `--dry-run` to see
 * what a merge would do before merging it.
 *
 * The order of the last three steps is deliberate. Publishing is the only step
 * that cannot be undone, so everything that can fail —the build, the commit,
 * the tag— fails first, while a retry is still free. The push comes last
 * because a repository that lags the registry by one push is a nuisance,
 * whereas a registry that lags the repository is a version nobody can install.
 */

import { execFileSync } from "node:child_process";

import { applyVersion, currentVersion, publishOrder, ROOT } from "./apply.mjs";
import { plan } from "./plan.mjs";

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
const version = currentVersion();

if (!tag) {
  log("! no v* tag found, so every commit in the history counts towards the bump");
  log(`  tag the released commit —git tag v${version}— if that is not what you want`);
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

for (const name of publishOrder()) {
  if (isPublished(name, decision.version)) {
    log(`  skip ${name}@${decision.version}, already on the registry`);
    continue;
  }

  npm("publish", "-w", name, "--access", "public");
}

git("push", "origin", "HEAD", "--follow-tags");

log(`released v${decision.version}`);
