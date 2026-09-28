/**
 * Whether the npm credential can be checked before anything is written.
 *
 * The run pushes its version commit and tag *before* publishing (see `run.mjs`
 * for why), which means a credential npm rejects is only discovered after the
 * version number is spent. That is how v0.10.0, v0.10.1 and v0.10.2 all ended
 * up tagged on GitHub with nothing on the registry: each merge burned a version
 * on the same dead token. Asking npm who we are first turns that into a red run
 * that has changed nothing.
 *
 * The check is skipped in exactly one case: in CI with no token at all. That is
 * trusted publishing (OIDC), where npm exchanges the workflow's identity for a
 * credential at publish time and there is nothing to ask `whoami` about yet.
 * Everywhere else —a token in CI, or a person releasing from their own login—
 * `npm whoami` has a real answer, and a wrong one should stop the run.
 */
export function credentialCheck(env) {
  const inCi = env.GITHUB_ACTIONS === "true";
  const token = env.NODE_AUTH_TOKEN ?? "";

  if (inCi && token.trim() === "") {
    return { check: false, reason: "no NODE_AUTH_TOKEN in CI, so publishing relies on trusted publishing (OIDC)" };
  }

  return { check: true, reason: inCi ? "NODE_AUTH_TOKEN is set" : "releasing from a local npm login" };
}

/** What to print when `npm whoami` refuses, so the next step is obvious. */
export function rejectedCredentialMessage() {
  return [
    "! npm rejected the publish credential, so nothing was versioned, tagged or pushed",
    "  in CI: regenerate the NPM_TOKEN secret (a granular token with read and write on every",
    "  monolite-* package), or configure trusted publishing for each package on npmjs.com",
    "  (GitHub Actions, Tanke6003/monolite, release.yml) and delete the secret",
    "  locally: npm login",
  ].join("\n");
}
