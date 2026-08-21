import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MODULES_MARKER, wireModule } from "../src/util/wiring";

/**
 * The generator editing a file somebody else owns.
 *
 * That is a licence worth being careful with, and the care is entirely in the
 * marker: the scaffold writes `// monolite:modules` into the list, and this
 * writes immediately above it. Every test here is really about the same
 * question — *when is it allowed to write, and what does it do when it is not*.
 */
describe("wireModule", () => {
  let root: string;
  let sourceRoot: string;

  const LIST = `import type { AnyMonoliteModule } from "monolite-di";
import { PRODUCT_MODULE } from "./modules/product.module";

export const MODULES: readonly AnyMonoliteModule[] = [
  PRODUCT_MODULE,
  ${MODULES_MARKER}
];
`;

  const write = (contents: string): void => {
    fs.mkdirSync(path.join(sourceRoot, "composition"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "composition", "modules.ts"), contents);
  };

  const read = (): string =>
    fs.readFileSync(path.join(sourceRoot, "composition", "modules.ts"), "utf8");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "monolite-wiring-"));
    sourceRoot = path.join(root, "src");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("adds the import and the entry, and says which they were", () => {
    write(LIST);

    const result = wireModule(root, sourceRoot, "invoice");

    expect(result.wired).toBe(true);
    expect(result.lines).toEqual([
      'import { INVOICE_MODULE } from "./modules/invoice.module";',
      "INVOICE_MODULE,",
    ]);
  });

  it("puts the entry above the marker, so the next one still has somewhere to go", () => {
    write(LIST);
    wireModule(root, sourceRoot, "invoice");

    const lines = read().split("\n");
    const entry = lines.findIndex((row) => row.trim() === "INVOICE_MODULE,");
    const marker = lines.findIndex((row) => row.trim() === MODULES_MARKER);

    expect(entry).toBeGreaterThan(-1);
    expect(marker).toBe(entry + 1);
  });

  it("keeps the modules already there, in the order they were listed", () => {
    write(LIST);
    wireModule(root, sourceRoot, "invoice");
    wireModule(root, sourceRoot, "payment method");

    const listed = read()
      .split("\n")
      .filter((row) => /^\s+[A-Z_]+_MODULE,$/.test(row))
      .map((row) => row.trim());

    expect(listed).toEqual(["PRODUCT_MODULE,", "INVOICE_MODULE,", "PAYMENT_METHOD_MODULE,"]);
  });

  it("puts the import with the other imports", () => {
    write(LIST);
    wireModule(root, sourceRoot, "invoice");

    const lines = read().split("\n");
    const added = lines.findIndex((row) => row.includes("INVOICE_MODULE"));

    expect(lines[added]).toBe('import { INVOICE_MODULE } from "./modules/invoice.module";');
    // Directly after the last import, which is where a person would have put it.
    expect(lines[added - 1].startsWith("import ")).toBe(true);
  });

  /**
   * The half that matters more than the insertion. A generator that edits a
   * file it no longer recognises is the thing this design was avoiding.
   */
  it("touches nothing when the marker is gone, and says so", () => {
    const withoutMarker = LIST.replace(`  ${MODULES_MARKER}\n`, "");
    write(withoutMarker);

    const result = wireModule(root, sourceRoot, "invoice");

    expect(result.wired).toBe(false);
    expect(result.reason).toContain(MODULES_MARKER);
    // Byte for byte: not reformatted, not reordered, not touched.
    expect(read()).toBe(withoutMarker);
  });

  it("touches nothing when the file is not there, and says so", () => {
    const result = wireModule(root, sourceRoot, "invoice");

    expect(result.wired).toBe(false);
    expect(result.reason).toBe("it is not there");
  });

  /** Re-running `generate module --force` must not list the module twice. */
  it("is idempotent", () => {
    write(LIST);
    wireModule(root, sourceRoot, "invoice");
    const once = read();

    const again = wireModule(root, sourceRoot, "invoice");

    expect(again.wired).toBe(false);
    expect(again.reason).toBe("it is already listed");
    expect(read()).toBe(once);
  });

  it("still reports the line to add when it does not write", () => {
    const result = wireModule(root, sourceRoot, "payment method");

    expect(result.lines).toEqual([
      'import { PAYMENT_METHOD_MODULE } from "./modules/payment-method.module";',
      "PAYMENT_METHOD_MODULE,",
    ]);
  });
});
