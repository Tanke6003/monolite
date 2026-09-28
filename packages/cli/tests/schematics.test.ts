import { tokensFor } from "monolite-di";

import {
  entityVars,
  isSchematic,
  overVars,
  RENAMED_SCHEMATICS,
  SCHEMATICS,
} from "../src/schematics";

describe("the schematics on offer", () => {
  it("are the seven a project is built out of", () => {
    expect([...SCHEMATICS]).toEqual([
      "module",
      "entity",
      "bll",
      "controller",
      "query",
      "repository",
      "task",
    ]);
  });

  /**
   * `service` was the name until the layer was renamed to BLL.
   *
   * It still resolves, and `generate` says what it resolved to. An unrecognised
   * subcommand is the worse answer when the thing it asks for still exists
   * under another name — somebody with the old command in a script or in their
   * fingers gets what they wanted plus the new word, rather than a list to read.
   */
  it("still answer to the name the BLL schematic used to have", () => {
    expect(RENAMED_SCHEMATICS.service).toBe("bll");
    expect(isSchematic(RENAMED_SCHEMATICS.service)).toBe(true);

    // And the old name is genuinely gone from the list, so the help does not
    // offer two spellings of one thing.
    expect(isSchematic("service")).toBe(false);
  });
});

describe("entityVars", () => {
  it("derives every name a module needs from the one word typed", () => {
    expect(entityVars("payment-method")).toMatchObject({
      entityName: "PaymentMethod",
      entityKebab: "payment-method",
      entityUpper: "PAYMENT_METHOD",
      entityPlural: "PaymentMethods",
      entityPluralUpper: "PAYMENT_METHODS",
      pkProperty: "pkPaymentMethod",
      pkColumn: "PK_PAYMENT_METHOD",
      routePath: "/payment-methods",
    });
  });

  it("names the BLL's token after the layer, not after what it used to be", () => {
    expect(entityVars("invoice")).toMatchObject({
      bllToken: "IInvoicesBLL",
      controllerToken: "IInvoicesController",
      storeToken: "InvoicesStore",
    });
  });

  it("refuses a name with nothing usable in it", () => {
    expect(() => entityVars("---")).toThrow(/usable name/);
  });
});

describe("overVars", () => {
  /**
   * A query owns no table, so the entity it reads is the one thing a generator
   * cannot derive from the name typed. These are that entity's names, kept
   * apart from the query's own so a template can use both at once.
   */
  it("carries the read entity's names under their own prefix", () => {
    expect(overVars("product")).toEqual({
      overName: "Product",
      overCamel: "product",
      overKebab: "product",
      overUpper: "PRODUCT",
      overPlural: "Products",
      overPluralCamel: "products",
      overPluralUpper: "PRODUCTS",
      overPkProperty: "pkProduct",
    });
  });
});

/**
 * A generated tokens file is now `tokensFor("<Entity>")`, so the names the
 * container registers come from `monolite-di` while the names the generator
 * reasons with come from `entityVars`. The CLI depends on no package of this
 * repository, so the rule is written twice — and this is what stops the two
 * copies from drifting into a module that fails to resolve at start-up.
 */
describe("the tokens a generated module registers", () => {
  const NAMES = [
    "product",
    "invoice-line",
    "category",
    "day",
    "address",
    "box",
    "buzz",
    "branch",
    "wish",
    "InvoiceLine",
    "user_role",
    "status",
  ];

  it.each(NAMES)("agree with the generator for %s", (name) => {
    const vars = entityVars(name);

    expect(tokensFor(vars.entityName)).toEqual({
      store: vars.storeToken,
      bll: vars.bllToken,
      repository: vars.repositoryToken,
      controller: vars.controllerToken,
    });
  });
});
