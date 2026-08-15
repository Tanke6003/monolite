import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  buildRenderContext,
  PACKAGE_MANAGERS,
  type PackageManager,
  type ProjectAnswers,
} from "../config/answers.js";
import {
  ENGINES,
  engineAliases,
  enginesOfFamily,
  resolveEngine,
  type DatabaseFamily,
  type EngineSpec,
} from "../config/engines.js";
import { printNewHelp } from "../help.js";
import { renderSchematic } from "../schematics.js";
import { templatePath } from "../templates.js";
import { color } from "../util/colors.js";
import { copyTemplateTree, directoryIsEmpty, FileWriter } from "../util/files.js";
import { run } from "../util/exec.js";
import { created, fail, hint, info, line, success, title, warn } from "../util/log.js";
import { sanitizeText, toPackageName, validatePackageName } from "../util/naming.js";
import { canPrompt, Prompter } from "../util/prompt.js";

const OPTIONS = {
  directory: { type: "string" },
  "project-version": { type: "string" },
  // `--version` is the CLI's own flag at the top level; after `new` it can only
  // sensibly mean the generated project's version, so both spellings work here.
  version: { type: "string" },
  description: { type: "string" },
  author: { type: "string" },
  license: { type: "string" },
  database: { type: "string" },
  "db-host": { type: "string" },
  "db-port": { type: "string" },
  "db-name": { type: "string" },
  "db-user": { type: "string" },
  "api-prefix": { type: "string" },
  pm: { type: "string" },
  auth: { type: "boolean" },
  "no-auth": { type: "boolean" },
  example: { type: "boolean" },
  "no-example": { type: "boolean" },
  install: { type: "boolean" },
  "skip-install": { type: "boolean" },
  git: { type: "boolean" },
  "skip-git": { type: "boolean" },
  force: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
  "no-color": { type: "boolean" },
} as const;

/**
 * Entity the `--example` module is built around.
 *
 * Fixed rather than configurable because the base templates have to name it
 * too —the composition root registers it and the router imports its
 * controller— and a placeholder there would buy nothing: anyone who wants a
 * different entity deletes four files and runs `monolite generate module`.
 */
const EXAMPLE_ENTITY = "product";

type OptionName = keyof typeof OPTIONS;
type Values = Partial<Record<OptionName, string | boolean>>;

const str = (values: Values, name: OptionName): string | undefined =>
  typeof values[name] === "string" ? (values[name] as string) : undefined;

/**
 * Reads a yes/no answer that has two flags. `--auth` and `--no-auth` are two
 * separate booleans rather than one negatable option because `parseArgs` has no
 * notion of negation, and the pair is what people expect to be able to type.
 * `undefined` means "not answered", which is what makes the prompt skippable.
 */
function tristate(values: Values, positive: OptionName, negative: OptionName): boolean | undefined {
  if (values[positive]) return true;
  if (values[negative]) return false;
  return undefined;
}

export async function newCommand(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    fail((error as Error).message);
    hint("run `monolite new --help` for the full list of options");
    return 1;
  }

  const values = parsed.values as Values;
  if (values.help) {
    printNewHelp();
    return 0;
  }

  const yes = Boolean(values.yes);
  const interactive = !yes && canPrompt();

  if (!yes && !interactive) {
    fail("stdin is not a terminal, so the questions cannot be asked");
    hint("pass --yes to take every default, or give each answer with its flag");
    return 1;
  }

  const positional = parsed.positionals[0];
  const targetDirectory = path.resolve(
    process.cwd(),
    str(values, "directory") ?? positional ?? "."
  );
  const defaultName = toPackageName(positional ?? path.basename(targetDirectory));

  const prompter = interactive ? new Prompter() : null;

  try {
    const answers = await collect(values, defaultName, Boolean(positional), prompter);
    return scaffold(answers, targetDirectory, Boolean(values.force));
  } catch (error) {
    fail((error as Error).message);
    return 1;
  } finally {
    prompter?.close();
  }
}

/**
 * One place where flags, prompts and defaults meet, in that order of priority.
 *
 * An answer given as a flag is never asked again: mixing `--database=postgres`
 * with the wizard is the normal way to use a scaffold that has ten questions
 * and only one you care about.
 */
async function collect(
  values: Values,
  defaultName: string,
  nameWasGiven: boolean,
  prompter: Prompter | null
): Promise<ProjectAnswers> {
  async function ask<T>(
    given: T | undefined,
    question: (prompter: Prompter) => Promise<T>,
    fallback: T
  ): Promise<T> {
    if (given !== undefined) return given;
    if (!prompter) return fallback;
    return question(prompter);
  }

  const name = await ask(
    nameWasGiven ? defaultName : undefined,
    (p) => p.text("Project name", { default: defaultName, validate: validatePackageName }),
    defaultName
  );

  const nameError = validatePackageName(name);
  if (nameError) throw new Error(`invalid project name "${name}": ${nameError}`);

  const version = await ask(
    str(values, "project-version") ?? str(values, "version"),
    (p) => p.text("Version", { default: "0.1.0" }),
    "0.1.0"
  );

  const defaultDescription = "Backend service scaffolded with the monolite toolkit.";
  const description = sanitizeText(
    await ask(
      str(values, "description"),
      (p) => p.text("Description", { default: defaultDescription }),
      defaultDescription
    )
  );

  const author = sanitizeText(
    await ask(str(values, "author"), (p) => p.text("Author", { default: "" }), "")
  );

  const license = sanitizeText(
    await ask(str(values, "license"), (p) => p.text("License", { default: "MIT" }), "MIT")
  );

  const engine = await resolveEngineAnswer(values, prompter);
  const connection = await collectConnection(values, engine, prompter);

  const auth = await ask(
    tristate(values, "auth", "no-auth"),
    (p) => p.confirm("Include authentication (JWT login and route guards)?", false),
    false
  );

  const example = await ask(
    tristate(values, "example", "no-example"),
    (p) => p.confirm("Include an example CRUD module?", true),
    true
  );

  const apiPrefix = normalizePrefix(
    await ask(
      str(values, "api-prefix"),
      (p) => p.text("API prefix", { default: "/api/v1" }),
      "/api/v1"
    )
  );

  const packageManager = await resolvePackageManager(values, prompter);

  const git = await ask(
    tristate(values, "git", "skip-git"),
    (p) => p.confirm("Initialise a git repository?", true),
    true
  );

  const install = await ask(
    tristate(values, "install", "skip-install"),
    (p) => p.confirm(`Install dependencies now with ${packageManager}?`, true),
    true
  );

  return {
    name,
    version,
    description,
    author,
    license,
    engine,
    ...connection,
    auth,
    example,
    apiPrefix,
    packageManager,
    git,
    install,
  };
}

async function resolveEngineAnswer(values: Values, prompter: Prompter | null): Promise<EngineSpec> {
  const requested = str(values, "database");

  if (requested !== undefined) {
    const engine = resolveEngine(requested);
    if (!engine) {
      throw new Error(
        `unknown --database=${requested}. Valid values: ${engineAliases().join(", ")}`
      );
    }
    return engine;
  }

  if (!prompter) return ENGINES.memory;

  const family = await prompter.select<DatabaseFamily>(
    "Database family",
    [
      { value: "sql", label: "SQL", hint: "Oracle, SQL Server, PostgreSQL, MySQL" },
      { value: "nosql", label: "NoSQL", hint: "MongoDB" },
      { value: "none", label: "None (in-memory)", hint: "no driver, no container" },
    ],
    2
  );

  if (family === "none") return ENGINES.memory;

  const candidates = enginesOfFamily(family);
  if (candidates.length === 1) return candidates[0];

  return prompter.select(
    "Engine",
    candidates.map((engine) => ({ value: engine, label: engine.label })),
    0
  );
}

async function collectConnection(
  values: Values,
  engine: EngineSpec,
  prompter: Prompter | null
): Promise<Pick<ProjectAnswers, "dbHost" | "dbPort" | "dbName" | "dbUser">> {
  // Nothing to connect to, and asking would only invite someone to fill in
  // values that end up in a file no code reads.
  if (engine.id === "memory") {
    return { dbHost: "", dbPort: 0, dbName: "", dbUser: "" };
  }

  const host =
    str(values, "db-host") ??
    (await prompter?.text("Database host", { default: "localhost" })) ??
    "localhost";

  const portRaw =
    str(values, "db-port") ??
    (await prompter?.text("Database port", {
      default: String(engine.defaultPort),
      validate: (value) =>
        /^\d+$/.test(value) && Number(value) > 0 && Number(value) < 65536
          ? null
          : "the port must be a number between 1 and 65535",
    })) ??
    String(engine.defaultPort);

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid --db-port=${portRaw}: expected a number between 1 and 65535`);
  }

  const database =
    str(values, "db-name") ??
    (await prompter?.text(engine.id === "oracle" ? "Oracle service name" : "Database name", {
      default: engine.defaultDatabase,
    })) ??
    engine.defaultDatabase;

  const user =
    str(values, "db-user") ??
    (await prompter?.text("Database user", { default: engine.defaultUser })) ??
    engine.defaultUser;

  return { dbHost: host, dbPort: port, dbName: database, dbUser: user };
}

async function resolvePackageManager(
  values: Values,
  prompter: Prompter | null
): Promise<PackageManager> {
  const requested = str(values, "pm");

  if (requested !== undefined) {
    const normalized = requested.trim().toLowerCase() as PackageManager;
    if (!PACKAGE_MANAGERS.includes(normalized)) {
      throw new Error(`unknown --pm=${requested}. Valid values: ${PACKAGE_MANAGERS.join(", ")}`);
    }
    return normalized;
  }

  if (!prompter) return "npm";

  return prompter.select(
    "Package manager",
    PACKAGE_MANAGERS.map((pm) => ({ value: pm, label: pm })),
    0
  );
}

/** `api/v1` and `/api/v1/` both mean `/api/v1`; the router only accepts one. */
function normalizePrefix(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function scaffold(answers: ProjectAnswers, targetDirectory: string, force: boolean): number {
  if (!directoryIsEmpty(targetDirectory) && !force) {
    fail(`${targetDirectory} is not empty`);
    hint("pass --force to write into it anyway, or pick another --directory");
    return 1;
  }

  fs.mkdirSync(targetDirectory, { recursive: true });

  const context = buildRenderContext(answers);
  const writer = new FileWriter(targetDirectory, force);

  // Order matters only in that later trees may legitimately overwrite earlier
  // ones; today none do, and `FileWriter` refuses to overwrite without --force,
  // so an accidental collision surfaces as a missing file in the summary.
  const trees = [
    templatePath("base"),
    templatePath("db", answers.engine.templateDir ?? "memory"),
    ...(answers.auth ? [templatePath("auth")] : []),
  ];

  for (const source of trees) {
    copyTemplateTree({ source, context, writer });
  }

  // The example module goes through the very same schematic `generate module`
  // uses, so the code a user reads on day one is exactly what the generator
  // will hand them on day two. Nothing about it is a special case.
  if (answers.example) {
    renderSchematic({
      schematic: "module",
      name: EXAMPLE_ENTITY,
      project: context,
      writer,
      sourceRoot: "src",
    });
  }

  report(answers, targetDirectory, writer);

  if (answers.git) initGit(targetDirectory);
  if (answers.install) install(answers, targetDirectory);

  nextSteps(answers, targetDirectory);
  return 0;
}

function report(answers: ProjectAnswers, targetDirectory: string, writer: FileWriter): void {
  title(`Created ${color.bold(answers.name)} in ${targetDirectory}`);
  line();
  for (const relative of [...writer.written].sort()) created(relative);
  line();

  info(`Database: ${color.bold(answers.engine.label)} (DATA_SOURCE=${answers.engine.dataSource})`);
  info(`API mounted at ${color.bold(answers.apiPrefix)}`);
  info(`Authentication: ${answers.auth ? "included" : "not included"}`);
  info(`Example module: ${answers.example ? "included" : "not included"}`);
}

function initGit(targetDirectory: string): void {
  line();
  if (fs.existsSync(path.join(targetDirectory, ".git"))) {
    warn("a git repository already exists here; leaving it alone");
    return;
  }

  if (run("git", ["init", "--quiet"], targetDirectory)) success("git repository initialised");
}

function install(answers: ProjectAnswers, targetDirectory: string): void {
  line();
  const args = answers.packageManager === "yarn" ? [] : ["install"];

  if (run(answers.packageManager, args, targetDirectory)) {
    success("dependencies installed");
  } else {
    warn(`install them yourself with \`${answers.packageManager} install\` inside the project`);
  }
}

function nextSteps(answers: ProjectAnswers, targetDirectory: string): void {
  const relative = path.relative(process.cwd(), targetDirectory) || ".";
  const runScript = answers.packageManager === "npm" ? "npm run" : answers.packageManager;

  title("Next steps");
  line(`  cd ${relative}`);
  if (!answers.install) {
    line(`  ${answers.packageManager === "yarn" ? "yarn" : `${answers.packageManager} install`}`);
  }
  line("  cp .env.example .env");

  if (answers.engine.id !== "memory") {
    line(
      color.dim(
        "  # .env.example ships a placeholder password. Put the real one in .env, which is git-ignored."
      )
    );
    line(`  docker compose up -d ${answers.engine.templateDir}`);
  }

  if (answers.auth) {
    line(color.dim("  # set JWT_SECRET in .env: the app refuses to start without it"));
  }

  line(`  ${runScript} dev`);
  line();
  hint("then GET http://localhost:3000/health/ready");
  line();
}
