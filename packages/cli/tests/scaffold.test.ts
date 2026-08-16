import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { newCommand } from "../src/commands/new";

/**
 * The test that makes the templates real.
 *
 * Everything else about the CLI can be checked by reading a string: this cannot.
 * The templates are TypeScript that this package deliberately does not compile
 * —they import `@monolite/*` packages the CLI does not depend on and they hold
 * placeholders that are not valid syntax— so before this file existed, nothing
 * anywhere ever type-checked the code the scaffold writes. It drifted: the
 * templates were still importing `SequelizeDbPlugin`, `OraclePlugin` and
 * `buildOpenApiSpec` long after the packages had renamed all three, and every
 * generated project was broken on arrival.
 *
 * So this generates real projects into a scratch directory and runs the
 * compiler over them, with `@monolite/*` pointed at the sources in this
 * repository. It is slower than every other test here put together and it is
 * the only one that can catch that class of mistake.
 */

/**
 * Inside the repository, not in `os.tmpdir()`, and outside `packages/`.
 *
 * Inside, because the generated project imports `express`, `zod` and the rest,
 * and the only way those resolve is by walking up to this repository's
 * `node_modules`. Outside `packages/`, because Jest collects `**\/tests\/**`
 * under it and would otherwise try to run the scaffold's own smoke test as if
 * it were one of ours.
 */
const SCRATCH = path.resolve(__dirname, "..", "..", "..", ".scaffold-tests");

const PACKAGES = path.resolve(__dirname, "..", "..");

interface Variant {
  name: string;
  args: string[];
}

const VARIANTS: Variant[] = [
  // Every option on: the largest surface, and the only one that renders the
  // auth tree and the example module.
  {
    name: "full",
    args: ["--database=postgres", "--auth", "--example"],
  },
  // Every option off. Worth its own run because the `#if` blocks that drop out
  // leave behind unused imports and dangling references, which is exactly what
  // a conditional template gets wrong.
  {
    name: "bare",
    args: ["--database=none", "--no-auth", "--no-example"],
  },
  // A second engine, so a mistake in one `db/<engine>/` tree is not hidden by
  // postgres being the only one ever generated.
  {
    name: "mongo",
    args: ["--database=mongo", "--no-auth", "--example"],
  },
];

/**
 * `strict`, and matching what the generated `tsconfig.json` asks for. Checking
 * the output under looser settings than the project ships with would let
 * through exactly the errors its own `npm run typecheck` is going to report.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  esModuleInterop: true,
  forceConsistentCasingInFileNames: true,
  // The packages' own types are checked by their own build; what is on trial
  // here is the generated code.
  skipLibCheck: true,
  noEmit: true,
  types: ["node"],
  baseUrl: SCRATCH,
  paths: {
    // Resolve to the sources rather than to `dist`, for the same reason the
    // Jest config does: a stale build would type-check yesterday's packages.
    "@monolite/*": [path.join(PACKAGES, "*", "src", "index.ts")],
  },
};

function filesOf(directory: string, extension?: string): string[] {
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!extension || entry.name.endsWith(extension)) found.push(full);
    }
  };

  walk(directory);
  return found;
}

/**
 * Compiler complaints about the generated project, formatted the way `tsc`
 * would print them.
 *
 * Only the generated files are reported on. The program also pulls in the
 * toolkit's own sources —that is what the `paths` mapping is for— and those are
 * compiled by their own build, under their own options: `@monolite/data`
 * re-exports a testing helper written against Jest's globals, which is correct
 * for the package and produces a screenful of noise here. What is on trial is
 * the code the scaffold wrote.
 */
function typeErrors(files: string[]): string[] {
  const program = ts.createProgram(files, COMPILER_OPTIONS);

  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName.startsWith(SCRATCH.replace(/\\/g, "/")))
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      const file = diagnostic.file;

      if (!file || diagnostic.start === undefined) return `TS${diagnostic.code}: ${message}`;

      const { line } = file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${path.relative(SCRATCH, file.fileName)}:${line + 1} TS${diagnostic.code}: ${message}`;
    });
}

beforeAll(() => {
  fs.mkdirSync(SCRATCH, { recursive: true });
});

afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

describe("the projects `monolite new` writes", () => {
  // Generating three projects and running the compiler over each is well past
  // Jest's default budget, and the failure it produces —a timeout— says nothing
  // about what went wrong.
  jest.setTimeout(120_000);

  describe.each(VARIANTS)("$name", (variant) => {
    const target = path.join(SCRATCH, variant.name);
    let exitCode: number;

    beforeAll(async () => {
      fs.rmSync(target, { recursive: true, force: true });

      // The command reports to stdout, which here is only noise around the
      // assertions. Silenced rather than left in, so a real failure is the
      // only thing in the output.
      const write = jest.spyOn(process.stdout, "write").mockReturnValue(true);
      try {
        exitCode = await newCommand([
          `demo-${variant.name}`,
          `--directory=${target}`,
          ...variant.args,
          "--yes",
          "--skip-install",
          "--skip-git",
        ]);
      } finally {
        write.mockRestore();
      }
    });

    it("is written without the command failing", () => {
      expect(exitCode).toBe(0);
    });

    it("leaves no placeholder or conditional behind", () => {
      const offenders: string[] = [];
      const leftovers = /__[a-z][A-Za-z0-9]*__|^[ \t]*(?:\/\/|<!--)?[ \t]*#(?:if|else|elif|endif)\b/gm;

      for (const file of filesOf(target)) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(leftovers)) {
          offenders.push(`${path.relative(SCRATCH, file)}: ${match[0].trim()}`);
        }
      }

      expect(offenders).toEqual([]);
    });

    it("compiles", () => {
      const sources = filesOf(path.join(target, "src"), ".ts");
      expect(sources.length).toBeGreaterThan(0);

      expect(typeErrors(sources)).toEqual([]);
    });
  });
});
