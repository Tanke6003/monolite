<!--
  The headings below are the ones the reviews in this repository keep asking
  about, so they are asked here instead. Delete any that genuinely do not apply
  — an empty section is worse than an absent one.
-->

## What this changes

<!-- One paragraph. What is different afterwards, from the outside. -->

Closes #

## Why this shape

<!--
  What else was considered and why it lost.

  This is the section that matters most here. The packages are full of comments
  explaining why a decision went the way it did, because the alternative — a
  correct decision nobody can reconstruct — gets reverted by the next person who
  meets the case it was made for. A change with no rejected alternative behind
  it usually has not met its hard case yet.
-->

## How it is checked

<!--
  The test that fails before and passes after, by name.

  "It compiles" is not one: the mistakes this toolkit keeps making are the ones
  that compile. If the change is to a driver or a dialect, say whether the
  integration suite covers it — the four SQL engines disagree in ways no double
  reproduces, which is how several released bugs got out.
-->

## Breaking change

<!--
  Pick one and delete the rest.

  - No.
  - Yes, for projects generated from now on. Templates only affect new projects.
  - Yes, for a package's published API. Say what to search and replace.
-->

---

- [ ] `npm run check` passes — typecheck, lint, unit tests, script tests
- [ ] `npm run test:integration` passes, or this touches nothing an engine sees
- [ ] The documentation says what the code now does, in both languages
- [ ] The commits follow Conventional Commits — the release version is computed
      from them, so `feat:` read as a `fix:` ships a feature in a patch
