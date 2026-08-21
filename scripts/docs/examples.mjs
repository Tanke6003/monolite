import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * The documentation's TypeScript, put through the compiler.
 *
 * Every documented `@Crud` example passed `dto: branchDto, paged: true` to a
 * `CrudController<T, TDto>`. Not one of those three had ever existed, and the
 * pages had said so for as long as they had been there — because nothing read
 * them. The templates have `scaffold.test.ts` type-checking the code they
 * generate; the prose had nothing, so its correctness rested on somebody
 * remembering to re-read it after a rename.
 *
 * This is that check. It is deliberately not a lint of the examples: what it is
 * hunting is the class of mistake that only the compiler can see — a symbol the
 * packages no longer export, a signature that changed shape, a type argument on
 * something that is not generic.
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every package name a snippet may import from, and where its sources live. */
const PACKAGES = fs
  .readdirSync(path.join(ROOT, "packages"))
  .filter((name) => fs.existsSync(path.join(ROOT, "packages", name, "src", "index.ts")))
  .map((name) => ({ module: `monolite-${name}`, entry: `packages/${name}/src/index.ts` }));

/**
 * A block the compiler is not meant to accept, marked in the Markdown itself:
 *
 *     <!-- docs:invalid -->
 *     ```ts
 *     // ...code shown precisely because it is wrong
 *     ```
 *
 * An HTML comment rather than something in the fence's info string, so nothing
 * shows up in the rendered page. It is the only marker there is, and needing it
 * should be rare: a block that is simply a fragment is recognised as one.
 */
const INVALID_MARKER = "<!-- docs:invalid -->";

const FENCE = /^```(ts|typescript)\b/;

/** Markdown worth reading: the guides, the two root READMEs and each package's. */
export function documentationFiles(root = ROOT) {
  const found = [];

  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) found.push(full);
    }
  };

  walk(path.join(root, "docs"));

  for (const name of ["README.md", "README.es.md"]) {
    found.push(path.join(root, name));
  }

  for (const entry of fs.readdirSync(path.join(root, "packages"))) {
    const readme = path.join(root, "packages", entry, "README.md");
    if (fs.existsSync(readme)) found.push(readme);
  }

  // The templates are not documentation: `scaffold.test.ts` already compiles
  // them, and they hold placeholders that are not valid syntax until rendered.
  return found.filter((file) => !file.includes(`${path.sep}templates${path.sep}`)).sort();
}

/**
 * The TypeScript blocks of one Markdown file.
 *
 * `line` is where the code starts in the source file, so a diagnostic can point
 * at the page a reader would open rather than at an offset into a string.
 */
export function extractBlocks(markdown, file = "<inline>") {
  const lines = markdown.split("\n");
  const blocks = [];

  for (let index = 0; index < lines.length; index++) {
    if (!FENCE.test(lines[index])) continue;

    const start = index + 1;
    let end = start;
    while (end < lines.length && lines[end].trimEnd() !== "```") end++;

    blocks.push({
      file,
      // Markdown lines are one-based, and so is every editor that will open it.
      line: start + 1,
      code: lines.slice(start, end).join("\n"),
      invalid: lines[index - 1]?.trim() === INVALID_MARKER,
    });

    index = end;
  }

  return blocks;
}

/**
 * How a block has to be read.
 *
 * Most examples in these pages are fragments — the body of an overridden hook,
 * a decorator on its own — and wrapping them in enough context to compile would
 * make the page worse to read than it is to check. So a block that stands on
 * its own is type-checked, and one that does not is required to *parse* as a
 * class member. That still catches an unbalanced brace or a mistyped keyword,
 * and it never asks an author to pad an example.
 *
 * There is no third tier for a loose run of statements, and there is no point
 * in one: the parser accepts a bare `return` at the top of a file and reports it
 * later as a grammar error, so nothing would ever reach it.
 */
export function classify(code) {
  if (parses(code)) return "module";
  if (parses(`class __Fragment__ {\n${code}\n  private __anchor__ = 0;\n}`)) return "member";
  return "broken";
}

function parses(code) {
  const source = ts.createSourceFile("probe.ts", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  // `parseDiagnostics` is internal, and it is the only way to ask the parser
  // whether it was happy without building a whole program for every candidate.
  return (source.parseDiagnostics ?? []).length === 0;
}

/**
 * The names a block brings with it: what it imports, and what it declares.
 *
 * Both have to be left alone. Importing a name the example already imports is a
 * duplicate identifier, and stubbing one it declares is a redeclaration — and
 * either way the error is about this file rather than about the page.
 */
export function localNames(code) {
  const source = ts.createSourceFile("names.ts", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const names = new Set();

  const add = (node) => {
    if (node && ts.isIdentifier(node)) names.add(node.text);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      add(clause?.name);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) add(element.name);
      } else if (clause?.namedBindings) {
        add(clause.namedBindings.name);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) add(declaration.name);
      continue;
    }

    add(statement.name);
  }

  return names;
}

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  // ES2022 and not CommonJS, only so that a documented `await` at the top of a
  // block is read as the module-level await it is rather than as an error about
  // the compiler settings of a file that does not exist.
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true,
  // Off for snippets, both of them. A documented handler is written
  // `(req, res) => ...` because the types are noise in prose, and a documented
  // class shows the fields it has without the constructor that fills them.
  // Neither is the kind of mistake this check exists to find.
  noImplicitAny: false,
  strictPropertyInitialization: false,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  esModuleInterop: true,
  skipLibCheck: true,
  noEmit: true,
  baseUrl: ROOT,
  paths: Object.fromEntries(
    PACKAGES.flatMap((p) => [
      [p.module, [p.entry]],
      // The packages publish subpaths of their own (`monolite-data/testing`),
      // and a documented import of one has to resolve or be reported as wrong.
      [`${p.module}/*`, [p.entry.replace("/index.ts", "/*/index.ts")]],
    ])
  ),
  types: ["node", "jest"],
};

/** Every name each `monolite-*` package exports, so a snippet can be given its imports. */
function exportsByPackage() {
  const program = ts.createProgram(
    PACKAGES.map((p) => path.join(ROOT, p.entry)),
    COMPILER_OPTIONS
  );
  const checker = program.getTypeChecker();
  const table = new Map();

  for (const pkg of PACKAGES) {
    const source = program.getSourceFile(path.join(ROOT, pkg.entry));
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) continue;

    for (const exported of checker.getExportsOfModule(symbol)) {
      // First package wins, deterministically: the list is alphabetical, and a
      // name re-exported by two packages is the same name either way.
      if (!table.has(exported.getName())) table.set(exported.getName(), pkg.module);
    }
  }

  return table;
}

const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * The handful of third-party names the examples use bare.
 *
 * `z` is worth resolving properly rather than stubbing: half the schemas in
 * these pages are written with it, and a stubbed `z` makes `z.infer<...>` an
 * error about namespaces that says nothing about the documentation.
 */
const EXTERNALS = new Map([["z", "zod"]]);

/**
 * The imports a snippet needs, inferred from the words in it.
 *
 * A word that a package exports is imported from it. Reaching for the AST would
 * be more precise and would buy nothing: a name that only appears inside a
 * comment or a string produces an unused import, and an unused import is not an
 * error here.
 */
function importsFor(code, exported) {
  const byModule = new Map();
  const local = localNames(code);

  for (const word of new Set(code.match(WORD) ?? [])) {
    const module = exported.get(word) ?? EXTERNALS.get(word);
    // A name the block imports or declares itself is already accounted for.
    // Importing it again is a duplicate identifier, and the resulting error
    // would be about this file rather than about the page.
    if (!module || local.has(word)) continue;
    if (!byModule.has(module)) byModule.set(module, new Set());
    byModule.get(module).add(word);
  }

  return [...byModule]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, names]) => `import { ${[...names].sort().join(", ")} } from "${module}";`)
    .join("\n");
}

/**
 * Names the example refers to and never defines: `IBranch`, `branchSchemas`,
 * the DTO of whatever module the page is about.
 *
 * They are stubbed as `any`, which is the honest limit of this check. It means
 * a call whose arguments are all stubs is not really verified — but the names
 * that matter, the ones the packages export, are the real thing, and those are
 * what drift.
 */
function stubs(names) {
  return [...names]
    .sort()
    .map((name) => `declare const ${name}: any;\ntype ${name} = any;`)
    .join("\n");
}

/**
 * The two ways the compiler reports a name the page never introduced: as a
 * missing name, and as a shorthand property with nothing behind it.
 */
const UNDECLARED = new Set([2304, 18004]);

/**
 * Compiles every checkable block in one program.
 *
 * One program and not one per block: there are dozens of them, and each one
 * would otherwise re-read the whole of `monolite-*` and `@types/node` from disk.
 */
function compile(candidates, exported, stubsByIndex) {
  const virtual = new Map();

  for (const [index, block] of candidates.entries()) {
    const preamble = [importsFor(block.code, exported), stubs(stubsByIndex.get(index) ?? [])]
      .filter(Boolean)
      .join("\n");

    // The offset lets a diagnostic be reported against the Markdown rather than
    // against the file this only pretends to be.
    const offset = preamble ? preamble.split("\n").length + 1 : 0;

    // Every block is made a module, and it has to be: a file with no import and
    // no export is a *script*, its declarations land in the global scope, and
    // two examples that both name a variable `appointments` then collide with
    // each other. It is also what makes a documented top-level `await` legal
    // rather than an error about the settings of a file nobody wrote.
    virtual.set(path.join(ROOT, `.docs-example-${index}.ts`), {
      text: `${preamble ? `${preamble}\n` : ""}${block.code}\nexport {};`,
      offset,
      block,
    });
  }

  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (name) => virtual.has(path.normalize(name)) || fileExists(name);
  host.readFile = (name) => virtual.get(path.normalize(name))?.text ?? readFile(name);
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const entry = virtual.get(path.normalize(name));
    return entry
      ? ts.createSourceFile(name, entry.text, languageVersion, true, ts.ScriptKind.TS)
      : getSourceFile(name, languageVersion, ...rest);
  };

  const program = ts.createProgram([...virtual.keys()], COMPILER_OPTIONS, host);

  return { program, virtual };
}

const CANNOT_FIND_MODULE = 2307;

/**
 * An import this repository could not possibly resolve is not a documentation
 * bug.
 *
 * Half the examples import from the reader's own project — `./tokens.js`,
 * `./modules/users.module.js` — and one shows a password hasher built on
 * `argon2`, which nobody here has installed. Reporting those would train people
 * to ignore the check.
 *
 * A `monolite-*` specifier is a different matter, and it is the whole point:
 * `monolite-data/testing` failing to resolve means the page tells readers to
 * import something the package does not export.
 */
function isOursToAnswerFor(diagnostic, message) {
  if (diagnostic.code !== CANNOT_FIND_MODULE) return true;
  return /Cannot find module '(monolite-[^']*)'/.test(message);
}

function diagnosticsOf(program, virtual) {
  return ts.getPreEmitDiagnostics(program).flatMap((diagnostic) => {
    const entry = diagnostic.file && virtual.get(path.normalize(diagnostic.file.fileName));
    if (!entry || diagnostic.start === undefined) return [];

    if (!isOursToAnswerFor(diagnostic, ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))) {
      return [];
    }

    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return [
      {
        block: entry.block,
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        // Back to the line of the Markdown file somebody will open.
        line: entry.block.line + Math.max(0, line - entry.offset),
      },
    ];
  });
}

/**
 * The whole check: read the pages, classify every block, compile the ones that
 * stand alone, and report what the compiler said in terms of the Markdown.
 */
export function checkExamples(files = documentationFiles()) {
  const blocks = files.flatMap((file) =>
    extractBlocks(fs.readFileSync(file, "utf8"), path.relative(ROOT, file))
  );

  const broken = blocks
    .filter((block) => !block.invalid && classify(block.code) === "broken")
    .map((block) => ({
      block,
      code: 0,
      line: block.line,
      message: "does not parse, as a module, a class member or a statement",
    }));

  const candidates = blocks.filter((block) => !block.invalid && classify(block.code) === "module");
  const exported = exportsByPackage();

  // First pass discovers the names the page never defines; the second compiles
  // with those stubbed, so what is left is about the packages and not about the
  // shorthand every example writes.
  const first = compile(candidates, exported, new Map());
  const stubsByIndex = new Map();

  for (const diagnostic of diagnosticsOf(first.program, first.virtual)) {
    if (!UNDECLARED.has(diagnostic.code)) continue;

    const index = candidates.indexOf(diagnostic.block);
    const name =
      /Cannot find name '([^']+)'/.exec(diagnostic.message)?.[1] ??
      /shorthand property '([^']+)'/.exec(diagnostic.message)?.[1];

    // A name the block declares is not undeclared, whatever the compiler said
    // about the order it was used in: stubbing it would be a redeclaration.
    if (index < 0 || !name || localNames(candidates[index].code).has(name)) continue;

    if (!stubsByIndex.has(index)) stubsByIndex.set(index, new Set());
    stubsByIndex.get(index).add(name);
  }

  const second = compile(candidates, exported, stubsByIndex);

  return {
    files: files.length,
    blocks: blocks.length,
    compiled: candidates.length,
    fragments: blocks.filter((b) => !b.invalid && classify(b.code) !== "module").length - broken.length,
    marked: blocks.filter((b) => b.invalid).length,
    errors: [...broken, ...diagnosticsOf(second.program, second.virtual)],
  };
}

/** How a failure reads: the page, the line, and what the compiler said. */
export function formatError(error) {
  return `${error.block.file}:${error.line} ${error.code ? `TS${error.code}: ` : ""}${error.message}`;
}

/**
 * The pages come in pairs, and a correction applied to one and not the other is
 * the second way this documentation has gone wrong. Comparing the headings and
 * the number of code blocks catches a section that was added, removed or split
 * in one language only, without pretending to check the prose.
 */
export function translationPairs(root = ROOT) {
  const english = path.join(root, "docs", "en");
  if (!fs.existsSync(english)) return [];

  return fs
    .readdirSync(english)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({
      name,
      en: path.join(english, name),
      es: path.join(root, "docs", "es", name),
    }));
}

export function headings(markdown) {
  let inFence = false;

  return markdown.split("\n").flatMap((line) => {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) return [];

    const match = /^(#{1,6}) /.exec(line);
    return match ? [match[1].length] : [];
  });
}
