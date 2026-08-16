import type { EngineSpec } from "./engines.js";
import type { RenderContext } from "../util/render.js";
import { toPascalCase } from "../util/naming.js";
import { cliVersion } from "../version.js";

export type PackageManager = "npm" | "pnpm" | "yarn";

export const PACKAGE_MANAGERS: PackageManager[] = ["npm", "pnpm", "yarn"];

/** Every answer the `new` command needs, however it was obtained. */
export interface ProjectAnswers {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  engine: EngineSpec;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  auth: boolean;
  example: boolean;
  apiPrefix: string;
  packageManager: PackageManager;
  git: boolean;
  install: boolean;
}

/**
 * Range the generated project depends on for every `@monolite/*` package.
 *
 * One constant rather than one per package: they are released together out of
 * this monorepo, and a scaffold that pins `core` and `http` to different minors
 * is a support ticket waiting to happen.
 */
export const MONOLITE_VERSION = "^0.1.0";

/** Third-party runtime dependencies every generated project needs. */
const BASE_DEPENDENCIES: Record<string, string> = {
  cors: "^2.8.5",
  dotenv: "^17.2.2",
  express: "^5.1.0",
  helmet: "^8.3.0",
  "reflect-metadata": "^0.2.2",
  tsyringe: "^4.10.0",
  zod: "^4.4.3",
};

const BASE_DEV_DEPENDENCIES: Record<string, string> = {
  "@eslint/js": "^9.36.0",
  "@types/cors": "^2.8.19",
  "@types/express": "^5.0.3",
  "@types/jest": "^30.0.0",
  "@types/node": "^24.5.0",
  eslint: "^9.36.0",
  jest: "^30.1.3",
  "ts-jest": "^29.4.4",
  tsx: "^4.20.5",
  typescript: "^5.9.2",
  "typescript-eslint": "^8.44.0",
};

export function dependenciesFor(answers: ProjectAnswers): Record<string, string> {
  return sorted({
    "@monolite/core": MONOLITE_VERSION,
    "@monolite/crud": MONOLITE_VERSION,
    "@monolite/data": MONOLITE_VERSION,
    "@monolite/di": MONOLITE_VERSION,
    "@monolite/http": MONOLITE_VERSION,
    ...(answers.auth ? { "@monolite/auth": MONOLITE_VERSION } : {}),
    ...BASE_DEPENDENCIES,
    ...answers.engine.dependencies,
  });
}

export function devDependenciesFor(answers: ProjectAnswers): Record<string, string> {
  return sorted({ ...BASE_DEV_DEPENDENCIES, ...answers.engine.devDependencies });
}

function sorted(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Renders a dependency map as the *body* of a JSON object. The template writes
 * `"dependencies": { __dependencies__ }` and `normalizeJson` puts the result
 * back into shape, which is what keeps `package.json` free of `#if` blocks: the
 * one file whose commas would otherwise depend on which branches survived.
 */
function asJsonBody(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([name, range]) => `"${name}": "${range}"`)
    .join(", ");
}

/** Human label for the engine, phrased for prose in the generated README. */
function engineSentence(engine: EngineSpec): string {
  return engine.id === "memory"
    ? "the in-memory driver, so it runs with nothing else installed"
    : `${engine.label}, through the generic repository in \`@monolite/data\``;
}

export function buildRenderContext(answers: ProjectAnswers): RenderContext {
  const { engine } = answers;
  const isMemory = engine.id === "memory";

  const flags = new Set<string>();
  if (answers.auth) flags.add("auth");
  if (answers.example) flags.add("example");
  if (isMemory) flags.add("memory");
  else {
    // `db` reads better than `!memory` at every call site, and `docker` states
    // the actual reason a block exists: there is a container to talk to.
    flags.add("db");
    flags.add("docker");
    flags.add(engine.id);
    flags.add(engine.family);
  }

  const run = answers.packageManager === "npm" ? "npm run" : answers.packageManager;

  return {
    flags,
    vars: {
      projectName: answers.name,
      projectVersion: answers.version,
      projectDescription: answers.description,
      projectAuthor: answers.author,
      projectLicense: answers.license,
      // Used as the logger's `service` field and as the README heading, so it
      // wants to be readable rather than npm-safe.
      serviceName: toPascalCase(answers.name) || "MonoliteApp",
      apiPrefix: answers.apiPrefix,
      dataSource: engine.dataSource,
      engineId: engine.id,
      engineLabel: engine.label,
      engineSentence: engineSentence(engine),
      // The compose service is named after the image, which is not always the
      // engine id: `mongodb` runs in a service called `mongo`.
      dockerService: engine.templateDir ?? "",
      envPrefix: engine.envPrefix || "DB",
      dbHost: answers.dbHost,
      dbPort: String(answers.dbPort),
      dbContainerPort: String(engine.containerPort),
      dbName: answers.dbName,
      dbUser: answers.dbUser,
      // Oracle is the one engine that takes a descriptor instead of host/port.
      oracleConnectString: `${answers.dbHost}:${answers.dbPort}/${answers.dbName}`,
      pm: answers.packageManager,
      pmRun: run,
      pmInstall: answers.packageManager === "yarn" ? "yarn" : `${answers.packageManager} install`,
      monoliteVersion: MONOLITE_VERSION,
      // Stamped into the project's `monolite` marker, so a future `generate`
      // can tell what produced the layout it is adding to.
      cliVersion: cliVersion(),
      dependencies: asJsonBody(dependenciesFor(answers)),
      devDependencies: asJsonBody(devDependenciesFor(answers)),
      authEnabled: String(answers.auth),
      exampleEnabled: String(answers.example),
      year: String(new Date().getFullYear()),
    },
  };
}
