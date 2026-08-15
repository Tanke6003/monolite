/**
 * The logging contract every other package writes against.
 *
 * The kernel deliberately stops at the level methods. The original interface
 * also exposed an `http()` factory returning an Express `RequestHandler`, and
 * that single method dragged a whole HTTP framework into the one contract that
 * everything else depends on. Request logging is a transport concern, so the
 * middleware lives in the HTTP package and only the levels stay here.
 */
export interface ILogger {
  /**
   * Escape hatch for a level chosen at runtime — reading it from configuration,
   * or re-emitting a record whose severity was decided elsewhere.
   */
  log(level: string, message: string, meta?: object): void;

  info(message: string, meta?: object): void;
  error(message: string, meta?: object): void;
  warn(message: string, meta?: object): void;
  debug(message: string, meta?: object): void;
}
