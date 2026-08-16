# Examples

The canonical example is whatever `@monolite/cli` writes, because that is the
output the project is actually accountable for:

```bash
npm run build
npm run cli -- new demo --database=postgres --auth --example --yes --skip-install --skip-git
```

CI generates two of them on every push — one with every optional feature on, one
with none — and fails if either stops building or leaves an unrendered
placeholder behind. Keeping a hand-maintained example in the repository as well
would mean two things to update and only one of them checked.

Anything committed under `examples/` is picked up as an npm workspace, so it can
depend on the packages by name (`@monolite/data`) and resolve to the local
sources rather than to a published version.
