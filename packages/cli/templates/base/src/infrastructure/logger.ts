import type { ILogger } from "@monolite/core";
import { readEnv } from "../config/env";

/**
 * A logger with no dependencies, writing one JSON object per line.
 *
 * The scaffold does not pick pino or winston for you, and that is the point:
 * `ILogger` is five methods, every package in the toolkit talks to the
 * interface, and swapping this class for a real driver is a change to this file
 * and to the one line in `composition/container.ts` that builds it. Shipping a
 * logging library in the template would make that choice for every project that
 * starts here, and logging is exactly the kind of decision an organisation has
 * already made.
 *
 * The format is JSON lines because that is what a log collector parses. In
 * development, pipe it through anything that pretty-prints NDJSON.
 */

const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;

type Level = (typeof LEVELS)[number];

const RANK: Record<Level, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

export interface ConsoleLoggerOptions {
  /** Records below this level are dropped. Defaults to `LOG_LEVEL`, then info. */
  level?: string;
  /** Goes into every record, so several services can share a log stream. */
  service?: string;
}

export class ConsoleLogger implements ILogger {
  private readonly threshold: number;
  private readonly service: string;

  constructor(options: ConsoleLoggerOptions = {}) {
    const requested = (options.level ?? readEnv("LOG_LEVEL", "info")).toLowerCase();
    this.threshold = RANK[isLevel(requested) ? requested : "info"];
    this.service = options.service ?? readEnv("SERVICE_NAME", "__serviceName__");
  }

  log(level: string, message: string, meta?: object): void {
    const normalized = isLevel(level) ? level : "info";
    if (RANK[normalized] < this.threshold) return;

    const record = {
      level: normalized,
      time: new Date().toISOString(),
      service: this.service,
      message,
      ...meta,
    };

    // stderr for anything that needs attention, stdout for the rest: that is
    // the split every process supervisor already knows how to route.
    const line = JSON.stringify(record, replacer);
    if (normalized === "error" || normalized === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  info(message: string, meta?: object): void {
    this.log("info", message, meta);
  }

  error(message: string, meta?: object): void {
    this.log("error", message, meta);
  }

  warn(message: string, meta?: object): void {
    this.log("warn", message, meta);
  }

  debug(message: string, meta?: object): void {
    this.log("debug", message, meta);
  }
}

/**
 * `JSON.stringify` turns an Error into `{}`, which is how a stack trace goes
 * missing from the one log line that needed it.
 */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
