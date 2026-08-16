import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextVersion, parseCommit, plan, releaseType } from "./plan.mjs";

/**
 * Run by `npm run test:scripts`, on Node's own test runner rather than Jest.
 *
 * Jest is configured for the packages, in TypeScript, through ts-jest. The
 * release tooling is plain ESM that CI has to run without a build step, and
 * teaching the Jest setup about a second language for three files buys less
 * than it costs. What matters is that the decision is tested at all: it is
 * made once per merge, by nobody, and it is not reversible.
 *
 * The script is `cd scripts && node --test` — recursive discovery from a
 * directory — and not a glob, because `--test` only learned glob patterns in
 * Node 22 and the packages support Node 20. Passing the directory as an
 * argument does not work either: Node reads path arguments as test files to
 * run, not as trees to search.
 */

describe("parseCommit", () => {
  it("reads the type, the scope and the subject", () => {
    assert.deepEqual(parseCommit("feat(cli): add a flag"), {
      type: "feat",
      scope: "cli",
      subject: "add a flag",
      breaking: false,
    });
  });

  it("treats a scope as optional", () => {
    assert.equal(parseCommit("fix: stop the crash").scope, null);
  });

  it("reads the bang and the footer as the same declaration", () => {
    assert.equal(parseCommit("feat(data)!: drop the legacy connector").breaking, true);
    assert.equal(
      parseCommit("feat(data): rework connectors\n\nBREAKING CHANGE: the old one is gone")
        .breaking,
      true
    );
    assert.equal(parseCommit("feat: something\n\nBREAKING-CHANGE: also counts").breaking, true);
  });

  it("ignores anything that is not a conventional commit", () => {
    assert.equal(parseCommit("wip"), null);
    assert.equal(parseCommit("Merge pull request #9 from x/y"), null);
  });
});

describe("releaseType", () => {
  it("takes the strongest bump asked for anywhere in the range", () => {
    assert.equal(releaseType(["fix: a", "feat: b", "fix: c"]), "minor");
    assert.equal(releaseType(["fix: a", "fix: b"]), "patch");
    assert.equal(releaseType(["feat: a", "fix!: b"]), "major");
  });

  /**
   * The case that keeps the version meaningful: a branch of documentation and
   * tests lands on master without cutting a release.
   */
  it("releases nothing for commits users never see", () => {
    assert.equal(releaseType(["docs: explain the router", "test: cover it", "chore: tidy"]), null);
    assert.equal(releaseType(["refactor(http): rename a helper", "ci: cache npm"]), null);
    assert.equal(releaseType([]), null);
  });

  it("counts a breaking change whatever type carries it", () => {
    assert.equal(releaseType(["refactor!: rename every package"]), "major");
    assert.equal(releaseType(["chore: bump\n\nBREAKING CHANGE: node 18 is gone"]), "major");
  });
});

describe("nextVersion", () => {
  it("moves the part the bump names", () => {
    assert.equal(nextVersion("1.4.2", "patch"), "1.4.3");
    assert.equal(nextVersion("1.4.2", "minor"), "1.5.0");
    assert.equal(nextVersion("1.4.2", "major"), "2.0.0");
  });

  /**
   * Below 1.0 a breaking change moves the minor. Declaring 1.0 is a decision a
   * person makes; a commit message must not make it for them.
   */
  it("does not let a commit declare 1.0", () => {
    assert.equal(nextVersion("0.1.0", "major"), "0.2.0");
    assert.equal(nextVersion("0.1.0", "minor"), "0.2.0");
    assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  });

  it("ignores a prerelease tail and refuses a version it cannot read", () => {
    assert.equal(nextVersion("1.2.3-beta.1", "patch"), "1.2.4");
    assert.throws(() => nextVersion("latest", "patch"), /not a semver version/);
  });

  it("returns null when there is no bump to apply", () => {
    assert.equal(nextVersion("1.0.0", null), null);
  });
});

describe("plan", () => {
  it("turns a version and a range of commits into one decision", () => {
    assert.deepEqual(plan("0.1.0", ["fix(cli): validate the license"]), {
      type: "patch",
      version: "0.1.1",
    });
    assert.deepEqual(plan("0.1.0", ["feat(auth): refresh tokens", "fix: a typo"]), {
      type: "minor",
      version: "0.2.0",
    });
  });

  it("is null when the range releases nothing", () => {
    assert.equal(plan("0.1.0", ["docs: rewrite the readme"]), null);
  });
});
