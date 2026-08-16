import readline from "node:readline/promises";
// `emitKeypressEvents` is only on the callback module: the promises one wraps
// the interface, not the stream helpers.
import { emitKeypressEvents } from "node:readline";
import { color } from "./colors.js";

/**
 * Built from the char code for the same reason `colors.ts` does it: a literal
 * ESC byte in a source file does not survive editors, patches and copy/paste
 * reliably, and every one of those touches this repository.
 */
const CSI = `${String.fromCharCode(27)}[`;

const cursor = {
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  up: (lines: number) => (lines > 0 ? `${CSI}${lines}A` : ""),
  /** Clears from the cursor to the end of the screen. */
  clearBelow: `${CSI}0J`,
};

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

/** What a keypress means to a list. `null` is a key the list ignores. */
export type SelectAction = "up" | "down" | "first" | "last" | "accept" | "abort" | null;

/**
 * Key handling as a pure function, so the part with the actual behaviour in it
 * can be tested without a terminal. Everything around it —raw mode, redrawing,
 * restoring the cursor— is plumbing that a test would only be asserting on
 * itself.
 *
 * Vim's `j`/`k` are in because the people who reach for them do it without
 * thinking, and they cost one line.
 */
export function selectAction(key: { name?: string; ctrl?: boolean }): SelectAction {
  if (key.ctrl && (key.name === "c" || key.name === "d")) return "abort";

  switch (key.name) {
    case "up":
    case "k":
      return "up";
    case "down":
    case "j":
      return "down";
    case "home":
    case "pageup":
      return "first";
    case "end":
    case "pagedown":
      return "last";
    case "return":
    case "enter":
    case "space":
      return "accept";
    case "escape":
      return "abort";
    default:
      return null;
  }
}

/** Applies an action to the highlighted row. Wraps around at both ends. */
export function nextIndex(action: SelectAction, index: number, length: number): number {
  switch (action) {
    case "up":
      return (index - 1 + length) % length;
    case "down":
      return (index + 1) % length;
    case "first":
      return 0;
    case "last":
      return length - 1;
    default:
      return index;
  }
}

/**
 * The three prompts a scaffold needs, on `node:readline/promises`.
 *
 * The select prompt is arrow-driven, with the numbered list kept as the
 * fallback rather than deleted. Raw mode is where a hand-rolled prompt breaks:
 * it needs a real TTY, and a process that dies mid-prompt leaves the cursor
 * hidden and the terminal in raw mode. So the arrow version runs only when
 * stdin can actually do it, restores the terminal on every exit including the
 * abort, and hands over to the numbered list otherwise — which is also what a
 * pipe, a CI log and a terminal recording get.
 */
export class Prompter {
  private readonly rl: readline.Interface;
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;

  /**
   * The streams are arguments rather than `process.stdin` reached for inside,
   * so the arrow-driven list can be driven by a test. It is the one prompt
   * with enough machinery —raw mode, a paused interface, a listener swap— to
   * be broken while looking perfectly fine on screen, which is exactly what
   * happened: it rendered and then ignored every key.
   */
  constructor(
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WriteStream = process.stdout
  ) {
    this.input = input;
    this.output = output;
    this.rl = readline.createInterface({ input, output });
  }

  close(): void {
    this.rl.close();
  }

  async text(
    message: string,
    options: {
      default?: string;
      hint?: string;
      validate?: (value: string) => string | null;
    } = {}
  ): Promise<string> {
    const suffix = options.default ? color.dim(` (${options.default})`) : "";

    // Printed above the question rather than inside it. What shape the answer
    // has to have is needed before typing, and a question line long enough to
    // wrap is worse than one dim line of its own — the same way the select
    // prompt puts its hints beside the choices instead of in the message.
    if (options.hint) this.output.write(color.dim(`  ${options.hint}\n`));

    for (;;) {
      const raw = (await this.rl.question(`${color.cyan("?")} ${message}${suffix}: `)).trim();
      const value = raw || options.default || "";

      const error = options.validate?.(value) ?? null;
      if (!error) return value;

      this.output.write(`  ${color.red(error)}\n`);
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

      this.output.write(`  ${color.red("answer y or n")}\n`);
    }
  }

  /**
   * Arrow keys when the terminal can do it, a numbered list when it cannot.
   *
   * The choice is made per call rather than once at construction because the
   * only thing that decides it is whether stdin is a TTY that accepts raw mode,
   * and that is cheap to ask.
   */
  async select<T>(message: string, choices: Choice<T>[], defaultIndex = 0): Promise<T> {
    const byKeys = await this.selectWithKeys(message, choices, defaultIndex);
    if (byKeys.supported) return byKeys.value;

    return this.selectByNumber(message, choices, defaultIndex);
  }

  /**
   * The arrow-driven list.
   *
   * Returns `{ supported: false }` instead of throwing when the terminal cannot
   * do raw mode, so the caller falls back without having to know why.
   */
  private async selectWithKeys<T>(
    message: string,
    choices: Choice<T>[],
    defaultIndex: number
  ): Promise<{ supported: true; value: T } | { supported: false }> {
    const { input, output } = this;

    if (!input.isTTY || typeof input.setRawMode !== "function") return { supported: false };

    // The readline interface is listening on the same stdin. Left running it
    // would eat the keypresses and echo them, so it stands down for the length
    // of the selection and is resumed in `restore`.
    //
    // Pausing it is not enough on its own, and pausing it alone is worse than
    // doing nothing: `pause()` pauses the stream, a paused stream emits no
    // data, and no data means no `keypress` — so the list drew itself, ignored
    // every key including Ctrl+C, and had to be killed from outside. The
    // interface's own handlers come off the stream, and then the stream is
    // resumed for the length of the selection.
    this.rl.pause();

    const readlineHandlers = input.listeners("keypress") as ((...args: unknown[]) => void)[];
    for (const handler of readlineHandlers) input.off("keypress", handler);

    // Whatever was typed while the previous question was on screen is still
    // buffered — an Enter held a moment too long at the last prompt, say. Left
    // there it would be delivered to the list, which would answer itself
    // before anyone had read it.
    while (input.read() !== null) {
      /* drain */
    }

    emitKeypressEvents(input);
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode(true);
    input.resume();
    output.write(cursor.hide);

    let index = Math.min(Math.max(defaultIndex, 0), choices.length - 1);
    let drawn = 0;

    const render = (): void => {
      // Every redraw rewinds over the previous one; the first has nothing to
      // rewind over, which is what `drawn` tracks.
      output.write(cursor.up(drawn) + cursor.clearBelow);

      output.write(`${color.cyan("?")} ${message}\n`);
      for (const [row, choice] of choices.entries()) {
        const active = row === index;
        const marker = active ? color.green("❯") : " ";
        const label = active ? color.bold(choice.label) : choice.label;
        const hint = choice.hint ? color.dim(`  ${choice.hint}`) : "";
        output.write(`  ${marker} ${label}${hint}\n`);
      }
      output.write(color.dim("  ↑↓ move · enter select\n"));

      drawn = choices.length + 2;
    };

    const restore = (): void => {
      output.write(cursor.show);
      input.pause();
      for (const handler of readlineHandlers) input.on("keypress", handler);
      input.setRawMode(wasRaw);
      this.rl.resume();
    };

    render();

    return new Promise<{ supported: true; value: T }>((resolve) => {
      const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean } | undefined) => {
        if (!key) return;

        const action = selectAction(key);
        if (action === null) return;

        if (action === "abort") {
          input.off("keypress", onKeypress);
          restore();
          // Raw mode swallows Ctrl+C, so the signal has to be honoured by hand;
          // leaving it unhandled would make the prompt impossible to escape.
          // 130 is what a shell reports for a program killed by SIGINT.
          process.exit(130);
        }

        if (action === "accept") {
          input.off("keypress", onKeypress);
          restore();
          resolve({ supported: true, value: choices[index].value });
          return;
        }

        const moved = nextIndex(action, index, choices.length);
        if (moved === index) return;

        index = moved;
        render();
      };

      input.on("keypress", onKeypress);
    });
  }

  /**
   * The numbered list. Still the whole prompt on a terminal without raw mode,
   * and still the one that reads back out of a CI log or a screen recording.
   */
  private async selectByNumber<T>(
    message: string,
    choices: Choice<T>[],
    defaultIndex: number
  ): Promise<T> {
    this.output.write(`${color.cyan("?")} ${message}\n`);

    choices.forEach((choice, index) => {
      const marker = index === defaultIndex ? color.green(">") : " ";
      const hint = choice.hint ? color.dim(`  ${choice.hint}`) : "";
      this.output.write(`  ${marker} ${color.bold(String(index + 1))}) ${choice.label}${hint}\n`);
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

      this.output.write(`  ${color.red(`enter a number between 1 and ${choices.length}`)}\n`);
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
