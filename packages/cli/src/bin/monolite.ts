#!/usr/bin/env node
import { run } from "../cli.js";
import { fail } from "../util/log.js";

/**
 * The exit code is set rather than passed to `process.exit()`, so that stdout
 * finishes flushing first. On Windows a piped stdout is asynchronous, and
 * exiting immediately after the last `write` truncates the summary — which is
 * the one part of a scaffold's output the user actually needs.
 */
void run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
