/**
 * The template renderer, in full.
 *
 * It does two things and nothing else:
 *
 *  1. **Substitution.** `__token__` is replaced by the value of `token`, in
 *     file contents and in path segments alike. An unknown token is a hard
 *     error rather than a silent pass-through, because the failure mode of
 *     letting it through is a generated project that looks fine until someone
 *     reads `__apiPrefix__` in their own README.
 *
 *  2. **Line conditionals.** A line that reads `#if <expr>`, `#elif <expr>`,
 *     `#else` or `#endif` —optionally behind a `//` or an HTML comment, so the
 *     template file stays readable in its own language— includes or drops
 *     everything up to the matching directive. Blocks nest.
 *
 * Anything coarser than a line is expressed by *where the template file lives*
 * instead: `templates/db/postgres/`, `templates/auth/`, `templates/example/`.
 * That is the rule that keeps this file thirty lines of logic instead of a
 * template engine, and it is worth defending — the moment a whole file needs
 * wrapping in a conditional, it belongs in a conditional directory.
 */

export interface RenderContext {
  /** `__key__` -> value. */
  vars: Record<string, string>;
  /** Names that `#if` can test. */
  flags: Set<string>;
}

const PLACEHOLDER = /__([A-Za-z][A-Za-z0-9]*)__/g;
const DIRECTIVE = /^#(if|elif|else|endif)\b\s*(.*)$/;

export class TemplateError extends Error {}

/**
 * Recognises a directive behind whatever comment syntax the file uses. `#` is
 * already a comment in YAML, `.env` and `.gitignore`, so those templates carry
 * the directive bare; `//` covers TypeScript and the template `package.json`,
 * and `<!-- -->` covers Markdown.
 */
function directiveOf(rawLine: string): { kind: string; expression: string } | null {
  let text = rawLine.trim();

  if (text.startsWith("<!--")) {
    text = text.slice(4).trim();
    if (text.endsWith("-->")) text = text.slice(0, -3).trim();
  } else if (text.startsWith("//")) {
    text = text.slice(2).trim();
  }

  const match = DIRECTIVE.exec(text);
  return match ? { kind: match[1], expression: match[2].trim() } : null;
}

/** `flag`, `!flag`, or several of either joined by `||`. */
function evaluate(expression: string, flags: Set<string>): boolean {
  const terms = expression
    .split("||")
    .map((term) => term.trim())
    .filter(Boolean);

  if (terms.length === 0) throw new TemplateError("empty #if condition");

  return terms.some((term) =>
    term.startsWith("!") ? !flags.has(term.slice(1).trim()) : flags.has(term)
  );
}

interface Frame {
  /** Whether the branch currently open emits. */
  emitting: boolean;
  /** Whether some branch of this `#if` chain already matched. */
  satisfied: boolean;
  /** Whether the enclosing block emits; a nested `#if` cannot revive it. */
  enclosing: boolean;
}

function applyConditionals(source: string, flags: Set<string>, origin: string): string {
  const lines = source.split("\n");
  const output: string[] = [];
  const stack: Frame[] = [];

  const emitting = (): boolean => stack.every((frame) => frame.emitting);

  for (const rawLine of lines) {
    const directive = directiveOf(rawLine);

    if (!directive) {
      if (emitting()) output.push(rawLine);
      continue;
    }

    const top = stack[stack.length - 1];

    switch (directive.kind) {
      case "if": {
        const enclosing = emitting();
        const taken = enclosing && evaluate(directive.expression, flags);
        stack.push({ emitting: taken, satisfied: taken, enclosing });
        break;
      }
      case "elif": {
        if (!top) throw new TemplateError(`#elif without #if in ${origin}`);
        const taken = top.enclosing && !top.satisfied && evaluate(directive.expression, flags);
        top.emitting = taken;
        top.satisfied = top.satisfied || taken;
        break;
      }
      case "else": {
        if (!top) throw new TemplateError(`#else without #if in ${origin}`);
        top.emitting = top.enclosing && !top.satisfied;
        top.satisfied = true;
        break;
      }
      case "endif": {
        if (!stack.pop()) throw new TemplateError(`#endif without #if in ${origin}`);
        break;
      }
    }
  }

  if (stack.length > 0) throw new TemplateError(`unclosed #if in ${origin}`);

  return output.join("\n");
}

function substitute(source: string, vars: Record<string, string>, origin: string): string {
  return source.replace(PLACEHOLDER, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new TemplateError(`unknown placeholder ${match} in ${origin}`);
    }
    return value;
  });
}

/**
 * Dropping a conditional block leaves the blank lines that surrounded it, and
 * two or three of them in a row is the tell-tale sign of generated code. One
 * pass over the output is cheaper than making every template author reason
 * about where the blank line belongs relative to the `#if`.
 */
function collapseBlankRuns(source: string): string {
  return source.replace(/\n{3,}/g, "\n\n");
}

export function renderText(source: string, context: RenderContext, origin: string): string {
  const conditioned = collapseBlankRuns(applyConditionals(source, context.flags, origin));
  // Exactly one trailing newline, for the same reason `.editorconfig` asks for
  // one: a conditional at the end of a file otherwise leaves a ragged tail that
  // every editor and every diff will then want to fix.
  return `${substitute(conditioned, context.vars, origin).replace(/\n+$/, "")}\n`;
}

/** Path segments only ever get substitution; a directory cannot hold a `#if`. */
export function renderName(name: string, context: RenderContext): string {
  return substitute(name, context.vars, `file name "${name}"`);
}
