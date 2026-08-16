import { packageNameNotice, toPackageName } from "../src/util/naming";

/**
 * Whether the CLI says anything about the name it derived.
 *
 * Tested as a plain function for the same reason the select prompt is: what
 * can genuinely be wrong is the decision, not the printing. Both cases here
 * came out of a real first run — `monolite new` from `E:\`, where the
 * directory has no basename, announced that `""` was not a valid package name
 * before it had asked for one.
 */
describe("packageNameNotice", () => {
  it("says nothing when the name is about to be asked for", () => {
    // The prompt offers the normalised name as an editable default, so there
    // is nothing to warn about yet.
    expect(packageNameNotice("", "monolite-app", true)).toBeNull();
    expect(packageNameNotice("My App", "my-app", true)).toBeNull();
  });

  it("says nothing when normalising changed nothing", () => {
    expect(packageNameNotice("billing-api", "billing-api", false)).toBeNull();
  });

  it("names the answer that was normalised, when one was given", () => {
    expect(packageNameNotice("My App", "my-app", false)).toBe(
      '"My App" is not a valid npm package name; using "my-app"'
    );
  });

  /**
   * `path.basename` of a drive root is `""`. Quoting that back reads as though
   * the user typed an empty name, which nobody did.
   */
  it("does not quote an empty name back at a user who never typed one", () => {
    const notice = packageNameNotice("", toPackageName(""), false);

    expect(notice).toBe('the target directory has no name to build one from; using "monolite-app"');
    expect(notice).not.toContain('""');
  });
});
