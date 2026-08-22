# Contributing

> 🇪🇸 [Leer en español](./CONTRIBUTING.es.md)

Thanks for taking the time. This document covers the conventions that are not
obvious from reading the code.

## Where to start

If you are looking for something to pick up: the
[open issues](https://github.com/Tanke6003/monolite/issues) carry the reasoning
behind each one, because the templates ask for it. Anything labelled
`documentation` is a good first change — the guides are type-checked in CI, so
you get told immediately whether an example you wrote works.

You do not need a database to contribute. `npm run check` runs with nothing
installed, and the in-memory driver is a complete engine.

Two things worth knowing before you open anything:

- **A reasoned disagreement is welcome and is the point.** This repository
  argues about design in the open; see the [code of conduct](./CODE_OF_CONDUCT.md)
  for the one rule that makes that work.
- **Something security-sensitive does not go in an issue.** Seven packages are
  published from here — see [SECURITY.md](./SECURITY.md).

## Setup

```bash
git clone <repo>
cd monolite
npm install
npm run check     # typecheck + lint + tests
```

The repository is an npm workspace with TypeScript project references, so
`npm run typecheck` (`tsc --build`) rebuilds only what changed. If a package
suddenly cannot find a sibling's types, delete the `*.tsbuildinfo` files and build
again — a stale incremental state is almost always the cause.

## Where code goes

| If it… | It belongs in |
| --- | --- |
| has no dependencies and every other package needs it | `core` |
| touches a database driver or compiles a query | `data` |
| touches Express, HTTP semantics or OpenAPI | `http` |
| is generic CRUD or transaction plumbing | `crud` |
| authenticates or authorises | `auth` |
| mentions tsyringe | `di` |
| generates files for a user's project | `cli` |

Two hard rules: **`core` must stay dependency-free**, and **nothing may depend on
`di`**. Both exist so a consumer can adopt one package without inheriting the
others' choices. A pull request that breaks either will be asked to restructure
rather than to add an exception.

## Style

- **Everything in English** — identifiers, comments, doc blocks, error messages,
  commit messages, PR descriptions. The project is bilingual in its documentation
  only, and the Spanish docs are translations of the English ones, not a parallel
  source of truth.
- **Comments explain why, not what.** `// increment the counter` above `i++` is
  noise. `// The lock has to be the first statement: MySQL's REPEATABLE READ pins
  the snapshot at the first read` is the kind of thing we keep. If a comment
  restates the code, delete it; if it records a decision, a constraint or a bug
  that used to live there, keep it.
- Two-space indentation, 100-column soft limit, LF endings — `.editorconfig`
  covers it.
- Prefer explicit types on public API surfaces. Inference is fine inside a
  function body.

## Tests

```bash
npm test
npm test -- --coverage
```

Coverage is collected from every source file, not only the imported ones. An
untested file that never appears in the report reads as covered to anyone skimming
the number, so the configuration deliberately surfaces the gaps.

A test must **discriminate**: it has to fail if the behaviour it describes is
removed. The quickest way to check is to break the mechanism on purpose and
confirm the test goes red. A test that passes both with and without the feature is
worse than no test, because it buys confidence it has not earned.

### Against real engines

`npm test` verifies the drivers against an array and two doubles. Good doubles —
they evaluate the generated SQL rather than nodding at it — and still unable to
catch the class of bug where the engine and the double disagree. That class has
shipped repeatedly: a soft-delete flag the SQL driver never wrote, an
`ON DELETE` clause one engine has no word for, a `CALL` the connector could not
make, and a `like` that ignored case on two of the four.

```bash
npm run engines:up          # PostgreSQL, MySQL, SQL Server, MongoDB, Oracle
npm run test:integration
npm run engines:down
```

Touching a driver, a dialect, a connector or the DDL generator means running
this. CI runs it on every push, so a change that only passes the unit suite will
be caught — but an hour later and with less context than you have now.

`MONOLITE_IT_ENGINES=postgres` narrows it while you work.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), in English:

```
feat(data): add a MySQL row-lock statement to the dialect
fix(http): sort routes by specificity before mounting
docs(es): translate the CRUD guide
```

Scope is the package name (`core`, `data`, `http`, `crud`, `auth`, `di`, `cli`) or
`docs`, `build`, `ci`.

## Documentation

Every user-visible change updates both `docs/en/` and `docs/es/`. English is
written first and Spanish mirrors it; the two directories have the same file names
and each page links to its counterpart at the top.

## Releasing

Nobody releases by hand. A push to `master` runs `.github/workflows/release.yml`,
which reads the commits since the last `v*` tag and decides what they add up to:

| Commit | Release |
| --- | --- |
| `fix:`, `perf:`, `revert:` | patch — `0.1.0` → `0.1.1` |
| `feat:` | minor — `0.1.0` → `0.2.0` |
| `feat!:`, or a `BREAKING CHANGE:` footer | major, but see below |
| `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, `style:` | none |

The strongest bump in the range wins, and a branch that only moves
documentation and tests lands without cutting a version — which is the point of
the last row. Below `1.0.0` a breaking change moves the minor instead: declaring
stability is a decision a person makes, not one a commit message makes for them.

Having decided, the workflow writes that version into all seven manifests, the
ranges they use for each other and `MONOLITE_VERSION` in the CLI, builds,
commits it as `chore(release): vX.Y.Z`, tags it, publishes every package in
dependency order, and pushes. Publishing is last, because it is the only step
that cannot be undone.

To see what a merge would release before merging it:

```bash
npm run release:dry
```

Packages are versioned together — one number across all seven — because the API
is not stable and independent versions would only encourage mismatched installs.
`MONOLITE_VERSION` in `packages/cli/src/config/answers.ts` is the same decision
seen from the other side: a scaffold that pinned `core` and `http` to different
minors would be a support ticket waiting to happen.

The decision itself is tested — `npm run test:scripts`, part of `npm run check`
— because it is made once per merge, by nobody, and a published version cannot
be taken back.
