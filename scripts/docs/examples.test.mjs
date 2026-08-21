import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import {
  checkExamples,
  classify,
  extractBlocks,
  formatError,
  headings,
  translationPairs,
} from "./examples.mjs";

/**
 * Run by `npm run test:scripts`, on Node's own test runner.
 *
 * It lives here rather than under a package's own `tests` because it is about the
 * repository and not about any one package: it reads the guides, both root
 * READMEs and each package's, and it needs no build step to do it — the same
 * reasons the release tooling is tested here.
 */

describe("extractBlocks", () => {
  it("takes the TypeScript blocks and leaves the rest", () => {
    const blocks = extractBlocks(
      ["# Title", "", "```ts", "const a = 1;", "```", "", "```bash", "npm test", "```"].join("\n")
    );

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].code, "const a = 1;");
  });

  it("reports the line the code starts on, not the line of the fence", () => {
    const blocks = extractBlocks(["one", "two", "```ts", "const a = 1;", "```"].join("\n"));

    // The fence is line 3, so the code is line 4 — which is where an editor
    // will land somebody who clicks the failure.
    assert.equal(blocks[0].line, 4);
  });

  it("reads `typescript` as well as `ts`", () => {
    assert.equal(extractBlocks(["```typescript", "const a = 1;", "```"].join("\n")).length, 1);
  });

  it("honours the marker for a block that is meant to be wrong", () => {
    const blocks = extractBlocks(
      ["<!-- docs:invalid -->", "```ts", "const a: string = 1;", "```"].join("\n")
    );

    assert.equal(blocks[0].invalid, true);
  });
});

describe("classify", () => {
  it("calls a self-contained block a module", () => {
    assert.equal(classify("export const a = 1;"), "module");
  });

  it("recognises the body of an overridden method", () => {
    // The shape most examples in these pages take.
    assert.equal(classify("protected override buildWhere(q: unknown) {\n  return undefined;\n}"), "member");
  });

  it("recognises a decorator shown on its own", () => {
    assert.equal(classify('@Crud({ resource: "audit log", dto: "AuditLog" })'), "member");
  });

  it("recognises a run of statements", () => {
    // `return` outside a function is what makes this one a fragment. Top-level
    // `await` would not: it is perfectly valid in a module, and a block using
    // it is type-checked like any other.
    assert.equal(classify("if (ready) {\n  return null;\n}"), "statements");
  });

  it("calls an unbalanced block broken", () => {
    assert.equal(classify("function f() {"), "broken");
  });
});

describe("the documentation's examples", () => {
  const result = checkExamples();

  /**
   * The test that would have caught `dto: branchDto, paged: true` and a generic
   * `CrudController<T, TDto>` on the day they were written, instead of months
   * later when somebody tried to copy one of them.
   */
  it("compiles, every self-contained one of them", () => {
    assert.deepEqual(
      result.errors.map(formatError),
      [],
      `\n${result.errors.map(formatError).join("\n")}\n`
    );
  });

  /**
   * A guard on the check itself. Everything here would also pass if the
   * extractor silently stopped finding blocks, or if every block were being
   * waved through as a fragment.
   */
  it("actually reads the pages and actually compiles something", () => {
    assert.ok(result.files >= 10, `only ${result.files} pages read`);
    assert.ok(result.blocks >= 30, `only ${result.blocks} blocks found`);
    assert.ok(result.compiled >= 5, `only ${result.compiled} blocks type-checked`);
  });
});

/**
 * The pages come in pairs, and a correction applied to one and not the other is
 * the second way this documentation has drifted. This does not read the prose —
 * it checks that the two have the same shape.
 */
describe("the English and Spanish pages stay in step", () => {
  for (const pair of translationPairs()) {
    it(`${pair.name} has a translation with the same structure`, () => {
      assert.ok(fs.existsSync(pair.es), `docs/es/${pair.name} is missing`);

      const en = fs.readFileSync(pair.en, "utf8");
      const es = fs.readFileSync(pair.es, "utf8");

      assert.deepEqual(
        headings(es),
        headings(en),
        `docs/es/${pair.name} has a different section structure`
      );

      assert.equal(
        extractBlocks(es).length,
        extractBlocks(en).length,
        `docs/es/${pair.name} has a different number of code blocks`
      );
    });
  }
});
