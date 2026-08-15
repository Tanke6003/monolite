import readline from "node:readline/promises";
import { color } from "./colors.js";

/**
 * The three prompts a scaffold needs, on `node:readline/promises`.
 *
 * The select prompt is numbered rather than arrow-driven on purpose. Raw mode
 * plus cursor movement is where a hand-rolled prompt starts breaking: it needs
 * a TTY, it fights with Windows terminals, it leaves the cursor hidden when the
 * process dies mid-prompt, and none of that buys anything a numbered list does
 * not already give. A number is also something a human can read back out of a
 * terminal recording when a scaffold goes wrong.
 */
export class Prompter {
  private readonly rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  close(): void {
    this.rl.close();
  }

  async text(
    message: string,
    options: { default?: string; validate?: (value: string) => string | null } = {}
  ): Promise<string> {
    const suffix = options.default ? color.dim(` (${options.default})`) : "";

    for (;;) {
      const raw = (await this.rl.question(`${color.cyan("?")} ${message}${suffix}: `)).trim();
      const value = raw || options.default || "";

      const error = options.validate?.(value) ?? null;
      if (!error) return value;

      process.stdout.write(`  ${color.red(error)}\n`);
    }
  }

  async confirm(message: string, fallback: boolean): Promise<boolean> {
    const suffix = color.dim(fallback ? " (Y/n)" : " (y/N)");

    for (;;) {
      const raw = (await this.rl.question(`${color.cyan("?")} ${message}${suffix}: `))
        .trim()
        .toLowerCase();

      if (!raw) return fallback;
      if (["y", "yes"].includes(raw)) return true;
      if (["n", "no"].includes(raw)) return false;

      process.stdout.write(`  ${color.red("answer y or n")}\n`);
    }
  }

  async select<T>(
    message: string,
    choices: { value: T; label: string; hint?: string }[],
    defaultIndex = 0
  ): Promise<T> {
    process.stdout.write(`${color.cyan("?")} ${message}\n`);

    choices.forEach((choice, index) => {
      const marker = index === defaultIndex ? color.green(">") : " ";
      const hint = choice.hint ? color.dim(`  ${choice.hint}`) : "";
      process.stdout.write(`  ${marker} ${color.bold(String(index + 1))}) ${choice.label}${hint}\n`);
    });

    for (;;) {
      const raw = (
        await this.rl.question(`  ${color.dim(`choose 1-${choices.length}`)} (${defaultIndex + 1}): `)
      ).trim();

      if (!raw) return choices[defaultIndex].value;

      const index = Number(raw) - 1;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) {
        return choices[index].value;
      }

      // Accepting the label too costs one line and saves the user who typed
      // "postgres" instead of counting rows.
      const byLabel = choices.find((choice) => choice.label.toLowerCase() === raw.toLowerCase());
      if (byLabel) return byLabel.value;

      process.stdout.write(`  ${color.red(`enter a number between 1 and ${choices.length}`)}\n`);
    }
  }
}

/**
 * Interactive mode needs somewhere to read from. Without this check a CI job
 * that forgot `--yes` hangs until the runner times it out, and the log shows a
 * question nobody was there to answer.
 */
export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY);
}
