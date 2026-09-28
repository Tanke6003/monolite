import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { credentialCheck, rejectedCredentialMessage } from "./credentials.mjs";

describe("credentialCheck", () => {
  it("checks a token CI was given, since that is the credential that has been failing", () => {
    assert.equal(credentialCheck({ GITHUB_ACTIONS: "true", NODE_AUTH_TOKEN: "npm_x" }).check, true);
  });

  it("skips in CI with no token, where trusted publishing has nothing to ask about yet", () => {
    // An unset secret reaches the job as an empty string, not as a missing variable.
    assert.equal(credentialCheck({ GITHUB_ACTIONS: "true", NODE_AUTH_TOKEN: "" }).check, false);
    assert.equal(credentialCheck({ GITHUB_ACTIONS: "true" }).check, false);
  });

  it("checks a local release, which publishes with the person's own login", () => {
    assert.equal(credentialCheck({}).check, true);
  });
});

describe("rejectedCredentialMessage", () => {
  it("says that nothing was changed, which is the promise the check exists to keep", () => {
    assert.match(rejectedCredentialMessage(), /nothing was versioned, tagged or pushed/);
  });
});
