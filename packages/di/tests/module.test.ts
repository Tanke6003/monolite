import {
  createContainer,
  entitiesOf,
  registerModules,
  type AnyMonoliteModule,
  type MonoliteModule,
} from "monolite-di";

import { GADGET_ENTITY, WIDGET_ENTITY, type IGadget, type IWidget } from "./support/test-entity";

/** A controller is only ever held, never constructed, so an empty class is one. */
class WidgetsController {}
class GadgetsController {}
class ReportsController {}

const widgets: MonoliteModule<IWidget> = {
  registration: { name: "WIDGETS", metadata: WIDGET_ENTITY },
  register: () => undefined,
  controller: WidgetsController,
};

const gadgets: MonoliteModule<IGadget> = {
  registration: { name: "GADGETS", metadata: GADGET_ENTITY },
  register: () => undefined,
  controller: GadgetsController,
};

/**
 * The module this issue is about: bindings and a controller, no table.
 *
 * A sales report reads three entities that already exist and owns none. So do a
 * search endpoint across several tables, a dashboard, an import job and a
 * webhook receiver — none of which are exotic, and all of which used to be
 * registered by hand in the composition root because the list would not take
 * them.
 */
const reports: MonoliteModule = {
  register: () => undefined,
  controller: ReportsController,
};

describe("entitiesOf", () => {
  it("keeps the registrations in the order they were listed", () => {
    expect(entitiesOf([widgets, gadgets]).map((one) => one.name)).toEqual(["WIDGETS", "GADGETS"]);
  });

  it("skips the modules that own no table", () => {
    const modules: AnyMonoliteModule[] = [widgets, reports, gadgets];

    // Skipped, not rejected: a module with no table is not an incomplete module,
    // it is a module with nothing for the persistence layer to build.
    expect(entitiesOf(modules).map((one) => one.name)).toEqual(["WIDGETS", "GADGETS"]);
  });

  it("is empty when nothing in the list owns one", () => {
    expect(entitiesOf([reports])).toEqual([]);
  });
});

describe("registerModules", () => {
  it("runs every module's bindings, table or not", () => {
    const container = createContainer();
    const ran: string[] = [];

    registerModules(container, [
      { ...widgets, register: () => ran.push("widgets") },
      { ...reports, register: () => ran.push("reports") },
    ]);

    expect(ran).toEqual(["widgets", "reports"]);
  });
});
