/**
 * Programmatic surface of the CLI.
 *
 * It exists so the generator can be driven from a test or from another tool
 * —`run(["new", "demo", "--yes"])` is the whole API— without shelling out to
 * the binary and parsing its output. Everything else stays internal on purpose:
 * the template layout is an implementation detail and should be free to change.
 */
export { run } from "./cli.js";
export { cliVersion } from "./version.js";
export { findProject } from "./project.js";
export type { MonoliteMarker, MonoliteProject } from "./project.js";
export { SCHEMATICS } from "./schematics.js";
export type { Schematic } from "./schematics.js";
export { ENGINES, resolveEngine } from "./config/engines.js";
export type { DatabaseFamily, EngineId, EngineSpec } from "./config/engines.js";
