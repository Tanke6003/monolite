import { newCommand } from "./commands/new.js";
import { generateCommand } from "./commands/generate.js";
import { printGenerateHelp, printNewHelp, printRootHelp } from "./help.js";
import { setColorEnabled } from "./util/colors.js";
import { fail, hint, line } from "./util/log.js";
import { cliVersion } from "./version.js";

const ALIASES: Record<string, string> = {
  init: "new",
  g: "generate",
};

/**
 * Dispatch, and the two flags that only mean something before a subcommand.
 *
 * `--version` is deliberately not parsed globally: after `monolite new` it can
 * only mean the version of the project being created, and stealing it there
 * would make the obvious `--version=2.0.0` print the CLI's version and exit.
 * So it is handled here, where there is no subcommand to disagree with it.
 */
export async function run(argv: string[]): Promise<number> {
  // Read before any parsing, because everything from here on may print.
  if (argv.includes("--no-color")) setColorEnabled(false);

  const [first, ...rest] = argv;

  if (!first || first === "--help" || first === "-h" || first === "help") {
    return helpFor(rest);
  }

  if (first === "--version" || first === "-v") {
    line(cliVersion());
    return 0;
  }

  const command = ALIASES[first] ?? first;

  switch (command) {
    case "new":
      return newCommand(rest);
    case "generate":
      return generateCommand(rest);
    default:
      fail(`unknown command "${first}"`);
      hint("run `monolite --help` to see what there is");
      return 1;
  }
}

function helpFor(rest: string[]): number {
  const topic = rest[0] ? (ALIASES[rest[0]] ?? rest[0]) : undefined;

  if (topic === "new") printNewHelp();
  else if (topic === "generate") printGenerateHelp();
  else printRootHelp();

  return 0;
}
