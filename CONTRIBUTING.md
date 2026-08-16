# Contributing

> 🇪🇸 [Leer en español](./CONTRIBUTING.es.md)

Thanks for taking the time. This document covers the conventions that are not
obvious from reading the code.

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
