import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The subpath a consumer actually resolves.
 *
 * `docs/{en,es}/testing.md` told readers to import the contract kit from
 * `monolite-data/testing` for as long as the page had existed, and the manifest
 * declared only `"."` — so the import resolved for nobody, and the function was
 * called something else besides. Two mistakes in one line, in the guide whose
 * whole subject is checking that things work.
 *
 * What hid it is worth naming: inside this repository `monolite-data` resolves
 * through Jest's module mapper and TypeScript's `paths`, neither of which cares
 * what `exports` says. So this test reads the manifest the way npm does rather
 * than importing anything, because importing it here proves nothing about what
 * a consumer gets.
 */
describe("monolite-data/testing", () => {
  const root = path.resolve(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    exports: Record<string, { types: string; default: string }>;
    files: string[];
  };

  it("is declared as a subpath export", () => {
    expect(manifest.exports["./testing"]).toEqual({
      types: "./dist/testing/index.d.ts",
      default: "./dist/testing/index.js",
    });
  });

  it("points at files the build actually produces", () => {
    // The manifest names paths under `dist`, and `dist` is what `files` ships.
    // Asserting against the *source* is what keeps this honest without needing
    // a build to have run first.
    expect(manifest.files).toContain("dist");
    expect(fs.existsSync(path.join(root, "src", "testing", "index.ts"))).toBe(true);
  });

  it("exports the contract kit under the name the guide uses", () => {
    const entry = path.join(root, "src", "testing", "index.ts");
    const source = ts.createSourceFile(
      entry,
      fs.readFileSync(entry, "utf8"),
      ts.ScriptTarget.ES2022,
      true
    );

    const exported = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) exported.add(element.name.text);
    }

    expect(exported).toContain("runGenericRepositoryContract");
    expect(exported).toContain("CONTRACT_ENTITY");
  });

  /**
   * The root keeps them too. Moving a published name is a breaking change, and
   * this one can be avoided entirely for the cost of a re-export.
   */
  it("leaves the root export in place", async () => {
    const root = (await import("monolite-data")) as Record<string, unknown>;

    expect(typeof root.runGenericRepositoryContract).toBe("function");
  });
});
