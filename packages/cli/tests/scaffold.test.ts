import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { missingSchemaRefs } from "monolite-http";

import { generateCommand } from "../src/commands/generate";
import { newCommand } from "../src/commands/new";

/**
 * The test that makes the templates real.
 *
 * Everything else about the CLI can be checked by reading a string: this cannot.
 * The templates are TypeScript that this package deliberately does not compile
 * —they import `monolite-*` packages the CLI does not depend on and they hold
 * placeholders that are not valid syntax— so before this file existed, nothing
 * anywhere ever type-checked the code the scaffold writes. It drifted: the
 * templates were still importing `SequelizeDbPlugin`, `OraclePlugin` and
 * `buildOpenApiSpec` long after the packages had renamed all three, and every
 * generated project was broken on arrival.
 *
 * So this generates real projects into a scratch directory and runs the
 * compiler over them, with `monolite-*` pointed at the sources in this
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
  /** Whether this one is also compiled to JavaScript and served over HTTP. */
  boot?: boolean;
  /** Which reader a booted variant mounts, and the word its page must contain. */
  reader?: { path: string; contains: string };
}

const VARIANTS: Variant[] = [
  // Every option on: the largest surface, and the only one that renders the
  // auth tree and the example module.
  {
    name: "full",
    args: ["--database=postgres", "--auth", "--example", "--docs=swagger"],
  },
  // Every option off. Worth its own run because the `#if` blocks that drop out
  // leave behind unused imports and dangling references, which is exactly what
  // a conditional template gets wrong.
  {
    name: "bare",
    args: ["--database=none", "--no-auth", "--no-example", "--docs=none"],
  },
  // A second engine, so a mistake in one `db/<engine>/` tree is not hidden by
  // postgres being the only one ever generated.
  {
    name: "mongo",
    // Also the only run that generates Scalar, for the same reason it is the
    // only one that generates the mongo tree.
    args: ["--database=mongo", "--no-auth", "--example", "--docs=scalar"],
  },
  /**
   * Two readers over one document. Worth a run of its own because it is the
   * only answer that turns on both conditional blocks at once, and a template
   * that mounted them at the same path would compile perfectly and then have
   * one shadow the other.
   */
  {
    name: "both-readers",
    args: ["--database=none", "--no-auth", "--example", "--docs=both"],
  },
  // The one that is actually run. In memory and with the example module, so it
  // serves real routes without a container to bring up first.
  {
    name: "memory",
    args: ["--database=none", "--no-auth", "--example", "--docs=swagger"],
    boot: true,
    reader: { path: "/docs/", contains: "swagger" },
  },
];

/**
 * Scalar is compiled but not served here, and the reason is Jest rather than
 * the template: the package is ESM-only and this suite runs the emitted
 * CommonJS through Jest's own loader, which cannot `require()` an ES module the
 * way Node itself now can. What the reader needs from the server —a policy that
 * does not blank its CDN out— is asserted on the variant that does boot, and
 * the directives themselves are covered in `security-config.test.ts`.
 */

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
  // `jest` because the generated project ships tests of its own, and they are
  // compiled here too: a scaffold that writes a test suite which does not
  // compile is worse than one that writes none.
  types: ["node", "jest"],
  baseUrl: SCRATCH,
  paths: {
    // Resolve to the sources rather than to `dist`, for the same reason the
    // Jest config does: a stale build would type-check yesterday's packages.
    "monolite-*": [path.join(PACKAGES, "*", "src", "index.ts")],
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
 * compiled by their own build, under their own options: `monolite-data`
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

/**
 * Emits the project to `dist/`, the way its own `npm run build` would.
 *
 * The emitted `require("monolite-di")` resolves through this repository's
 * workspace links, and Jest's module mapper then sends it at the package
 * sources — so what is served is the code in this working tree, not a build
 * from whenever `tsc` last ran.
 */
function emitJavaScript(target: string): void {
  const sources = filesOf(path.join(target, "src"), ".ts");

  const program = ts.createProgram(sources, {
    ...COMPILER_OPTIONS,
    noEmit: false,
    outDir: path.join(target, "dist"),
    rootDir: path.join(target, "src"),
  });

  // One file at a time, and not a whole-program emit. The program also contains
  // the toolkit's sources —`paths` puts them there— and they sit outside
  // `rootDir`, so a blanket emit writes a `.js` next to every `.ts` in this
  // repository. Naming each file keeps the output inside the generated project.
  for (const source of sources) {
    const file = program.getSourceFile(source);

    // `emit(undefined)` *is* the blanket emit, so a file the program does not
    // recognise has to stop this rather than fall through to it. It has
    // happened: the run leaves a `.js` beside every source in the repository
    // and, because the project's own output never lands where it is expected,
    // fails several tests later as a module that cannot be found.
    if (!file) throw new Error(`[tests] ${source} is not part of the program`);

    const emitted = program.emit(file);
    expect(emitted.emitSkipped).toBe(false);
  }
}

/**
 * Runs `monolite generate module` against a project that has just been
 * scaffolded, from inside it.
 *
 * The command finds its project by walking up from the working directory —
 * which is the check that stops a mistyped `cd` scattering files over an
 * unrelated repository — so a test that wants to exercise it has to be standing
 * in the right place, exactly as a person would be.
 *
 * Nothing is hand-edited afterwards. That is the point of the assertion this
 * feeds: the module reaches HTTP because the generator wired it, or it does not
 * reach HTTP at all.
 */
function generateInto(target: string, ...argv: string[]): void {
  const previous = process.cwd();
  const write = jest.spyOn(process.stdout, "write").mockReturnValue(true);

  try {
    process.chdir(target);
    expect(generateCommand(argv)).toBe(0);
  } finally {
    process.chdir(previous);
    write.mockRestore();
  }
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

    it("mounts each chosen reader at an address of its own", () => {
      const docs = path.join(target, "src", "presentation", "docs.ts");
      if (!fs.existsSync(docs)) return;

      const source = fs.readFileSync(docs, "utf8");
      const mounted = [...source.matchAll(/app\.use\(\s*"([^"]+)"/g)].map((match) => match[1]);

      expect(mounted).toEqual([...new Set(mounted)]);
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

    /**
     * The tests the scaffold writes are code it wrote, and they drifted the same
     * way the source did before this file existed — with the added twist that a
     * generated suite which does not compile fails on `npm test`, which is the
     * first command anybody runs in a new project.
     */
    it("writes a test suite that compiles", () => {
      const tests = filesOf(path.join(target, "tests"), ".ts");
      expect(tests.length).toBeGreaterThan(0);

      expect(typeErrors(tests)).toEqual([]);
    });

    /**
     * Compiling is not the same as working, and the difference has been three
     * separate bugs: a driver imported at the top of a module that a project on
     * another engine never installs, and an error-handler *factory* handed to
     * Express unbuilt — which type-checks, registers as ordinary middleware and
     * turns every failure into Express's default HTML page, stack trace and all.
     *
     * So one variant is emitted to JavaScript and actually served. `monolite-*`
     * resolves through this repository's own workspace links, which is why no
     * install is needed here.
     */
    (variant.boot ? describe : describe.skip)("served over HTTP", () => {
      let server: { run(): Promise<void>; close(): Promise<void>; address: { port: number } | null };
      let base: string;
      let quiet: jest.SpyInstance[];

      beforeAll(async () => {
        generateInto(target, "module", "invoice");
        // Over `product`, the example module's entity: the schematic exists for
        // the case where the generic API has run out on a table you already have.
        generateInto(target, "query", "revenue", "--over", "product");
        emitJavaScript(target);

        // The generated logger writes a JSON line per request, to stdout and to
        // stderr. Useful in the project, noise around these assertions — and it
        // stays silenced for the whole block, since the requests are what log.
        quiet = [
          jest.spyOn(process.stdout, "write").mockReturnValue(true),
          jest.spyOn(process.stderr, "write").mockReturnValue(true),
        ];

        // Required rather than imported: the path only exists once the project
        // above has been generated and emitted.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Server } = require(path.join(target, "dist", "server.js")) as {
          Server: new (port: number) => typeof server;
        };

        // Port 0: the OS picks a free one, so a developer with something already
        // on 3000 does not get a mystery failure here.
        server = new Server(0);
        await server.run();
        base = `http://localhost:${server.address?.port}`;
      });

      afterAll(async () => {
        await server?.close();
        for (const spy of quiet ?? []) spy.mockRestore();
      });

      it("reports itself ready", async () => {
        const response = await fetch(`${base}/health/ready`);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "ok", dataSource: "memory" });
      });

      /**
       * The document is what a client generator consumes, so it is published
       * whether or not a reader is mounted over it.
       */
      it("publishes the OpenAPI document", async () => {
        const response = await fetch(`${base}/openapi.json`);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          openapi: expect.stringMatching(/^3\./),
          paths: expect.any(Object),
        });
      });

      it("serves the reader that was chosen", async () => {
        const response = await fetch(`${base}${variant.reader!.path}`);

        expect(response.status).toBe(200);
        expect(await response.text()).toContain(variant.reader!.contains);
      });

      /**
       * The header that decides whether the reader is a documentation page or a
       * blank one.
       *
       * Helmet's own default policy is `script-src 'self'`, which stops Scalar's
       * CDN bundle and its inline bootstrap dead. The response is still a 200,
       * so the only symptom is an empty page and a console nobody is reading.
       * The toolkit therefore leaves the CSP off until `CSP_ENABLED=true` asks
       * for it, and this is the assertion that keeps it that way.
       */
      it("does not ship a policy that would blank the reader out", async () => {
        const response = await fetch(`${base}${variant.reader!.path}`);

        expect(response.headers.get("content-security-policy")).toBeNull();
      });

      /**
       * A `$ref` to a component nobody declared is the one way this document
       * breaks while still serving a valid 200: the reader shows the operation
       * with an empty body and says only that it could not resolve a reference.
       * It shipped exactly that way — the DTO template declared a plain
       * interface, so `Product` and `PaginatedProduct` were referenced by every
       * operation and defined by none.
       */
      it("publishes a document whose every reference resolves", async () => {
        const document = await (await fetch(`${base}/openapi.json`)).json();

        expect(missingSchemaRefs(document)).toEqual([]);
      });

      /**
       * Exact, not "contains": a component nobody declared is the fault this
       * assertion exists for, and so is one that appeared from nowhere. The
       * generated module's two are in the list because the generator wired it —
       * which makes this a second check on that, from the document's side.
       */
      it("declares every module's DTOs as components, and nothing else", async () => {
        const document = (await (await fetch(`${base}/openapi.json`)).json()) as {
          components: { schemas: Record<string, unknown> };
        };

        expect(Object.keys(document.components.schemas).sort()).toEqual([
          "ErrorResponse",
          "Invoice",
          "PaginatedInvoice",
          "PaginatedProduct",
          "Product",
          "Revenue",
        ]);
      });

      /**
       * Generated with `--no-auth`, so the document says so. The decorators
       * close every route that does not declare itself public, which is the
       * right default and the wrong document here: an "Authorize" button and a
       * 401 on every operation send the reader looking for a login endpoint
       * this project does not have.
       */
      it("invents no authentication for a project generated without it", async () => {
        const document = (await (await fetch(`${base}/openapi.json`)).json()) as {
          security?: unknown;
          components: { securitySchemes?: unknown };
          paths: Record<string, Record<string, { security?: unknown; responses: object }>>;
        };

        expect(document.security).toBeUndefined();
        expect(document.components.securitySchemes).toBeUndefined();
        expect(document.paths["/products"].get.security).toBeUndefined();
        expect(document.paths["/products"].get.responses).not.toHaveProperty("401");
      });

      /**
       * `/health` alongside `/health/live` and `/health/ready`: it is the path a
       * load balancer configured with the bare one expects, and answering a 404
       * there reads to it as an instance that is down.
       */
      it("answers readiness on the bare health path too", async () => {
        const response = await fetch(`${base}/health`);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "ok" });
      });

      /** The quota is on, and the health checks are exempt from it. */
      it("counts requests against a per-IP quota", async () => {
        const limited = await fetch(`${base}/api/v1/products`);
        expect(limited.headers.get("ratelimit-policy")).toMatch(/^120;w=60$/);

        const health = await fetch(`${base}/health/live`);
        expect(health.headers.get("ratelimit")).toBeNull();
      });

      /**
       * The generator's real contract, and the only assertion that can hold it:
       * a module it wrote is *served*, with nothing hand-edited in between.
       *
       * That the files appeared proves nothing — they always appeared. What used
       * to be missing was the wiring, and a module registered nowhere compiles
       * perfectly and answers 404 for ever.
       */
      it("serves a module the generator wired by itself", async () => {
        const response = await fetch(`${base}/api/v1/invoices`);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ total: 2, page: 1 });
      });
      /**
       * The query schematic, held to the same bar as `generate module`: it is
       * served, with nothing hand-edited in between.
       *
       * It reads the example module's two seeded rows through `executeRaw` on a
       * SQL engine and through the in-process fallback in memory, and answers
       * the same either way — which is the property the fallback exists for.
       */
      it("serves a query the generator wrote and wired", async () => {
        const response = await fetch(`${base}/api/v1/revenues`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([{ total: 2, lowestId: 1, highestId: 2 }]);
      });

      /**
       * The shape, which is the other half of why this schematic exists.
       *
       * Every `@Crud` module keeps the layering right without anyone thinking
       * about it, because `CrudController` takes an `ICrudService` and will not
       * take anything else. A query is four files written from a blank page, so
       * it is the one place in a monolite project where nothing enforces the
       * rule — and the first time one was written by hand, the rule was broken:
       * the controller held the repository and the repository returned the
       * shape the client sees.
       */
      it("writes a query whose controller talks to the service, not the repository", () => {
        const inside = (...parts: string[]) =>
          fs.readFileSync(path.join(target, "src", ...parts), "utf8");

        const controller = inside("presentation", "controllers", "revenue.controller.ts");

        expect(controller).toContain("REVENUE_TOKENS.service");
        expect(controller).not.toContain("REVENUE_TOKENS.repository");

        // And from the other end: the repository answers rows, and the DTO is
        // built a layer up, so what a client may see is decided in one place.
        const repository = inside("infrastructure", "persistence", "revenue.repository.ts");

        expect(repository).toContain("Promise<RevenueRow[]>");
        expect(repository).not.toContain("RevenueDTO");
      });

      it("serves the example module, seeded", async () => {
        const response = await fetch(`${base}/api/v1/products`);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ total: 2, page: 1 });
      });

      it("creates through the generic CRUD", async () => {
        const response = await fetch(`${base}/api/v1/products`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "over HTTP" }),
        });

        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ name: "over HTTP" });
      });

      /**
       * The assertion that catches the unbuilt error handler: what a rejected
       * body produces has to be the API's own JSON, not a page with a stack
       * trace in it.
       */
      it("answers a rejected body as JSON, not as an HTML stack trace", async () => {
        const response = await fetch(`${base}/api/v1/products`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "" }),
        });

        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toMatch(/application\/json/);
        expect(await response.json()).toMatchObject({ message: expect.any(String) });
      });

      it("answers an unknown route the same way", async () => {
        const response = await fetch(`${base}/api/v1/nothing-here`);

        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toMatch(/application\/json/);
      });

      it("publishes a document generated from the same decorators", async () => {
        const document = (await (await fetch(`${base}/openapi.json`)).json()) as {
          paths: Record<string, unknown>;
        };

        expect(Object.keys(document.paths)).toEqual(
          expect.arrayContaining(["/products", "/products/{id}"])
        );
      });
    });
  });
});
