import path from "node:path";
import ts from "typescript";

import { storeToken, tokensFor, TOKENS } from "monolite-di";

// The module itself rather than the package index: it has no imports, so the
// probe compiles in milliseconds instead of dragging in the data layer.
const TOKENS_SOURCE = path.resolve(__dirname, "..", "src", "tokens");

/** Type-checks `body` with `tokensFor` in scope, and returns the messages. */
function typeErrors(body: string): string[] {
  const file = path.join(__dirname, "__tokens-probe__.ts");
  const source = `import { tokensFor } from ${JSON.stringify(TOKENS_SOURCE)};\n${body}`;

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };

  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);

  host.readFile = (name) => (path.resolve(name) === file ? source : readFile(name));
  host.fileExists = (name) => path.resolve(name) === file || fileExists(name);
  host.getSourceFile = (name, language) =>
    path.resolve(name) === file
      ? ts.createSourceFile(name, source, language)
      : getSourceFile(name, language);

  const program = ts.createProgram([file], options, host);

  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("TOKENS", () => {
  /**
   * The table's whole value is that `grep ILogger` finds the registration and
   * the injection alike. A key that did not match its value would break that
   * quietly, and nothing else would ever fail.
   */
  it("spells every value exactly like its key", () => {
    for (const [key, value] of Object.entries(TOKENS)) {
      expect(value).toBe(key);
    }
  });

  it("covers the framework contracts an application never registers itself", () => {
    // Not an inventory for its own sake: each of these is resolved by name
    // somewhere in the toolkit, so dropping one is a runtime failure in wiring
    // that no compiler sees.
    expect(Object.keys(TOKENS)).toEqual(
      expect.arrayContaining([
        "IEnvs",
        "ILogger",
        "IRequestContext",
        "ITransactionContext",
        "IHealthProbe",
        "ITokenBLL",
        "IFileStorage",
        "IDbPlugin",
        "IUnitOfWork",
        "IAuditTrail",
        "IAuditLogStore",
      ])
    );
  });
});

describe("storeToken", () => {
  it("is the entity name plus the Store suffix", () => {
    expect(storeToken("USERS")).toBe("USERSStore");
    expect(storeToken("Products")).toBe("ProductsStore");
  });

  it("does not normalise the name it is given", () => {
    // The caller's spelling is the one their feature modules inject, so
    // "correcting" it here would break the injection rather than fix anything.
    expect(storeToken("weird_Name")).toBe("weird_NameStore");
  });
});

describe("tokensFor", () => {
  it("derives the four identifiers a generated module used to spell out", () => {
    expect(tokensFor("Payment")).toEqual({
      store: "PaymentsStore",
      bll: "IPaymentsBLL",
      repository: "IPaymentsRepository",
      controller: "IPaymentsController",
    });
  });

  it("pluralises with the generator's rules", () => {
    expect(tokensFor("Category").store).toBe("CategoriesStore");
    expect(tokensFor("Day").store).toBe("DaysStore");
    expect(tokensFor("Address").store).toBe("AddressesStore");
    expect(tokensFor("Box").store).toBe("BoxesStore");
    expect(tokensFor("Branch").store).toBe("BranchesStore");
    expect(tokensFor("Wish").store).toBe("WishesStore");
    expect(tokensFor("InvoiceLine").store).toBe("InvoiceLinesStore");
  });

  /**
   * Compiled rather than asserted, because Jest here strips types without
   * checking them: an assignment in this file would pass whatever the helper
   * returned. The failure that matters is the result widening to `string`,
   * which still compiles in `@inject()` and lets a typo through.
   */
  it("stays as narrow as the literal it replaces", () => {
    expect(
      typeErrors(`
        const category = tokensFor("Category");
        const store: "CategoriesStore" = category.store;
        const bll: "ICategoriesBLL" = category.bll;
        const repository: "ICategoriesRepository" = category.repository;
        const controller: "ICategoriesController" = category.controller;
        const box: "IBoxesBLL" = tokensFor("Box").bll;
        const day: "IDaysBLL" = tokensFor("Day").bll;
        const branch: "IBranchesBLL" = tokensFor("Branch").bll;
        export { store, bll, repository, controller, box, day, branch };
      `)
    ).toEqual([]);

    // The control: the same check has to be able to fail, or the test above
    // proves nothing.
    expect(typeErrors(`export const bll: "IPaymentBLL" = tokensFor("Payment").bll;`)).toHaveLength(1);
  });

  it("can be spread to rename one identifier and keep the rest", () => {
    const tokens = { ...tokensFor("Payment"), bll: "LegacyPaymentsService" } as const;

    expect(tokens.bll).toBe("LegacyPaymentsService");
    expect(tokens.store).toBe("PaymentsStore");
  });

  it("cannot be changed after the fact", () => {
    // A shared object mutated by one module would rename another module's
    // registration from under it.
    expect(Object.isFrozen(tokensFor("Payment"))).toBe(true);
  });
});
