import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const HTTP_SOURCE = path.resolve(__dirname, "..", "..", "src", "index");

/**
 * Type-checks `body` inside a controller module, and returns the messages.
 * Jest does not type-check test files, so a compile-time guarantee can only be
 * tested by running the compiler.
 */
function typeErrors(body: string): string[] {
  const file = path.join(__dirname, "__handler-probe__.ts");
  const source =
    `import type { Request, Response } from "express";\n` +
    `import { z } from "zod";\n` +
    `import { Get, Post, type Handler } from ${JSON.stringify(HTTP_SOURCE)};\n` +
    `const createBody = z.object({ name: z.string() });\n` +
    `const renameBody = z.object({ title: z.string() });\n` +
    `const listQuery = z.object({ page: z.coerce.number() });\n` +
    body;

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    experimentalDecorators: true,
    types: [],
    // The workspace packages resolve to their sources, as they do for jest:
    // `dist` may not exist, and a stale one would check yesterday's types.
    baseUrl: ROOT,
    paths: { "monolite-*": ["packages/*/src/index.ts"] },
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

describe("Handler types", () => {
  // Compiling pulls in the http and core sources; generous, not slow.
  jest.setTimeout(60_000);

  it("types the body and the query from the schemas the handler names", () => {
    // The negative control too: without it, the failures below would pass just
    // as well if the probe failed to compile for an unrelated reason.
    expect(
      typeErrors(`
        class People {
          @Post("/", { body: createBody, query: listQuery })
          create: Handler<{ body: typeof createBody; query: typeof listQuery }> = (req) => {
            const name: string = req.body.name;
            const page: number = req.validatedQuery.page;
            return [name, page];
          };
        }
      `)
    ).toEqual([]);
  });

  it("does not leave the body as any", () => {
    expect(
      typeErrors(`
        const create: Handler<{ body: typeof createBody }> = (req) => {
          const wrong: number = req.body.name;
          return wrong;
        };
      `)
    ).not.toEqual([]);
  });

  it("fails at the decorator when the handler names another schema than the route", () => {
    const errors = typeErrors(`
      class People {
        @Post("/", { body: createBody })
        create: Handler<{ body: typeof renameBody }> = (req) => req.body.title;
      }
    `);

    // The message names what the route's schema has and the handler's lacks.
    expect(errors.join("\n")).toMatch(/Property 'name' is missing/);
  });

  it("still accepts a handler typed with Express's own Request", () => {
    expect(
      typeErrors(`
        class People {
          @Post("/", { body: createBody, query: listQuery })
          create = async (req: Request, res: Response): Promise<void> => {
            res.json(req.body);
          };

          @Get("/")
          list = (_req: Request, res: Response): void => {
            res.json([]);
          };
        }
      `)
    ).toEqual([]);
  });

  it("rejects a private handler", () => {
    // The one handler that compiled before and does not now: `private` is gone
    // at runtime, so the router found it, but the decorator can only check a
    // property the type says is there.
    const errors = typeErrors(`
      class People {
        @Get("/")
        private list = (_req: Request, res: Response): void => {
          res.json([]);
        };
      }
    `);

    expect(errors.join("\n")).toMatch(/Property 'list' is private/);
  });
});
