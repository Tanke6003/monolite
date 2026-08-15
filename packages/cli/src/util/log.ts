import { color } from "./colors.js";

/**
 * Every line the CLI prints goes through here.
 *
 * Two reasons beyond tidiness. Diagnostics go to stderr and results go to
 * stdout, so `monolite new x --yes > log.txt` still shows the failure on the
 * terminal; and the symbols are ASCII, because a Windows console that has not
 * been switched to UTF-8 renders the fancy ones as mojibake, which is exactly
 * the audience of a scaffolding tool's first run.
 */

export function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function title(text: string): void {
  line();
  line(color.bold(text));
}

export function info(text: string): void {
  line(`${color.cyan("i")} ${text}`);
}

export function success(text: string): void {
  line(`${color.green("+")} ${text}`);
}

export function created(relativePath: string): void {
  line(`  ${color.green("create")} ${relativePath}`);
}

export function step(text: string): void {
  line(`${color.blue(">")} ${text}`);
}

export function hint(text: string): void {
  line(color.dim(`  ${text}`));
}

export function warn(text: string): void {
  process.stderr.write(`${color.yellow("!")} ${text}\n`);
}

export function fail(text: string): void {
  process.stderr.write(`${color.red("x")} ${text}\n`);
}
