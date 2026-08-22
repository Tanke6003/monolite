# Security

## Reporting a vulnerability

**Not through a public issue.** Seven packages are published to npm from this
repository, and a vulnerability described in the open is installed by everyone
who runs `npm install` between the report and the fix.

Use GitHub's private reporting — **Security → Report a vulnerability** on
[the repository](https://github.com/Tanke6003/monolite/security/advisories/new).
It opens a channel only the maintainers can read, and it is the same place the
advisory is published from once there is a version to point at.

Include what a fix needs: the package and version, what an attacker can do that
they should not be able to, and the smallest case that shows it. If you are not
sure whether something counts, report it — deciding that is not your job.

### What happens next

There is one maintainer and no service-level agreement to offer that would be
honest. What you can expect is an acknowledgement, a decision about whether it
is a vulnerability, and — if it is — a fix released before the advisory goes
public, with credit unless you would rather not have it.

## Supported versions

Pre-1.0, and while it is, only the latest minor gets fixes. All seven packages
share one version number and the API may change in a minor release, so pinning
an old one and expecting patches is not a promise this project can keep. Pin
exact versions and upgrade deliberately; the changelog records every break with
the search-and-replace it needs.

## What is in scope

The published packages and the code the CLI generates. A vulnerability in a
scaffolded project matters here too: the scaffold is the project's output and
its defaults are its opinion.

Some things are deliberate and are not vulnerabilities, though a report about
them is still welcome if you think the reasoning is wrong:

- **`executeRaw` runs the SQL you give it.** It is the documented escape hatch
  for what the generic API does not express. Values travel as binds; the
  statement is the caller's, and concatenating user input into one is the
  caller's bug. The generated code says so at the point of use.
- **A generated project ships with the CSP off** until `CSP_ENABLED=true`,
  because the documentation readers load from a CDN and a blank page is a worse
  first five minutes than a permissive default that the README tells you to
  turn on. `docsCspDirectives` widens the policy for the reader you chose.
- **`JWT_SECRET` has no default and the process refuses to start without one.**
  That is the intended behaviour, not a missing convenience: a framework that
  ships a fallback signing key ships a forged token to everyone who never
  changed it.
- **The seeded login account in a scaffolded project is a placeholder.** Its
  password is in the source and the file says to delete it. Reaching production
  with it is a deployment problem, and the generated README says so twice.

## Dependencies

`monolite-cli` has no runtime dependencies at all. The database drivers are
optional peers, so a project installs only the one its engine needs and a
vulnerability in the other five is not in its tree.
