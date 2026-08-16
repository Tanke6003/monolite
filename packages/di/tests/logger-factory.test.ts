import { createLogger } from "monolite-di";
import type { LoggerDriverFactory, LoggerSettings } from "monolite-di";
import { envsFrom, silentLogger } from "./support/test-entity";

/**
 * A backend that only records that it was the one chosen, and with what.
 *
 * The factory's whole job is a resolution — which name wins, and which settings
 * reach it — so the backends themselves need to be nothing more than a receipt.
 */
function recorder(name: string, journal: [string, LoggerSettings][]): LoggerDriverFactory {
  return (settings) => {
    journal.push([name, settings]);
    return silentLogger();
  };
}

function driversFor(journal: [string, LoggerSettings][], ...names: string[]) {
  return Object.fromEntries(names.map((name) => [name, recorder(name, journal)]));
}

describe("createLogger", () => {
  it("builds the backend the option names", () => {
    const journal: [string, LoggerSettings][] = [];
    createLogger({ drivers: driversFor(journal, "pino", "winston"), driver: "winston" });

    expect(journal.map(([name]) => name)).toEqual(["winston"]);
  });

  it("falls back to LOG_DRIVER when the option says nothing", () => {
    const journal: [string, LoggerSettings][] = [];
    createLogger({
      drivers: driversFor(journal, "pino", "winston"),
      envs: envsFrom({ LOG_DRIVER: "winston" }),
    });

    expect(journal.map(([name]) => name)).toEqual(["winston"]);
  });

  it("prefers the explicit option over the environment", () => {
    const journal: [string, LoggerSettings][] = [];
    createLogger({
      drivers: driversFor(journal, "pino", "winston"),
      envs: envsFrom({ LOG_DRIVER: "winston" }),
      driver: "pino",
    });

    expect(journal.map(([name]) => name)).toEqual(["pino"]);
  });

  it("takes the caller's default before its own", () => {
    const journal: [string, LoggerSettings][] = [];
    createLogger({ drivers: driversFor(journal, "pino", "console"), defaultDriver: "console" });

    expect(journal.map(([name]) => name)).toEqual(["console"]);
  });

  it("lands on pino when nothing anywhere says otherwise", () => {
    const journal: [string, LoggerSettings][] = [];
    createLogger({ drivers: driversFor(journal, "pino", "winston") });

    expect(journal.map(([name]) => name)).toEqual(["pino"]);
  });

  it("ignores case and surrounding space in the name", () => {
    const journal: [string, LoggerSettings][] = [];
    createLogger({ drivers: driversFor(journal, "winston"), driver: "  WinSton " });

    expect(journal.map(([name]) => name)).toEqual(["winston"]);
  });

  it("passes the level and the service name through", () => {
    const journal: [string, LoggerSettings][] = [];
    createLogger({
      drivers: driversFor(journal, "pino"),
      envs: envsFrom({ LOG_LEVEL: "warn", SERVICE_NAME: "billing" }),
    });

    expect(journal[0][1]).toEqual({ level: "warn", service: "billing" });
  });

  it("has a default for both", () => {
    const journal: [string, LoggerSettings][] = [];
    createLogger({ drivers: driversFor(journal, "pino") });

    expect(journal[0][1]).toEqual({ level: "debug", service: "app" });
  });

  /**
   * The important one. A misspelled `LOG_DRIVER=wiston` that quietly started on
   * the default backend would only surface the day somebody went looking for
   * the log files it was supposed to be writing.
   */
  it("refuses an unknown driver, and says what it would have accepted", () => {
    expect(() =>
      createLogger({ drivers: driversFor([], "pino", "winston"), driver: "wiston" })
    ).toThrow(/Unknown LOG_DRIVER "wiston".*pino, winston/s);
  });

  it("says so plainly when no backend was registered at all", () => {
    expect(() => createLogger({ drivers: {} })).toThrow(/none registered/);
  });
});
