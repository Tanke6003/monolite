/**
 * Colour without a dependency.
 *
 * chalk would be one more package inside a tool whose selling point is that
 * `npm i -g @monolite/cli` pulls nothing else, and the escape codes it wraps
 * are four characters long. What is worth copying from it is the *policy*: a
 * CLI that is piped is usually being read by a log file, a CI annotation or
 * another program, and escape sequences there are noise at best and broken
 * parsing at worst.
 */

const CODES = {
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
} as const;

type ColorName = keyof typeof CODES;

/**
 * Built from the char code instead of written literally: an ESC byte inside a
 * source file survives an editor round trip badly, and every tool that touches
 * this repo (git, the linter, a copy/paste) would be one more chance to lose it.
 */
const CSI = `${String.fromCharCode(27)}[`;

/**
 * Decided once at load time so that every call site agrees, and overridable
 * afterwards because `--no-color` is only known once the arguments are parsed.
 */
function detect(): boolean {
  // https://no-color.org: the variable being *present* is the signal, whatever
  // it holds. An empty value is still a request to turn colour off.
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === "dumb") return false;

  // FORCE_COLOR wins over the TTY check: it is how a CI job that does render
  // escapes asks for them even though its stdout is a pipe.
  const forced = process.env.FORCE_COLOR;
  if (forced !== undefined && forced !== "0" && forced !== "false") return true;

  return Boolean(process.stdout.isTTY);
}

let enabled = detect();

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

export function isColorEnabled(): boolean {
  return enabled;
}

function paint(name: ColorName) {
  return (text: string): string => (enabled ? `${CSI}${CODES[name]}m${text}${CSI}0m` : text);
}

export const color = {
  bold: paint("bold"),
  dim: paint("dim"),
  red: paint("red"),
  green: paint("green"),
  yellow: paint("yellow"),
  blue: paint("blue"),
  magenta: paint("magenta"),
  cyan: paint("cyan"),
  gray: paint("gray"),
};
