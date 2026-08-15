import fs from "node:fs";
import path from "node:path";

/**
 * Read from disk instead of imported.
 *
 * `import pkg from "../package.json"` would need `resolveJsonModule`, and with
 * `rootDir: "src"` it would also drag the manifest into `dist/` under a second
 * path. One `readFileSync` at startup costs nothing and keeps the emitted tree
 * exactly mirroring `src/`.
 */
export function cliVersion(): string {
  try {
    const manifest = fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8");
    return (JSON.parse(manifest) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
