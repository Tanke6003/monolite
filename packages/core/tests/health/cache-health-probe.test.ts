import { CacheHealthProbe, HealthProbe, type HealthReport, type IHealthProbe } from "monolite-core";

const database = (report: Partial<HealthReport> = {}): IHealthProbe => ({
  report: jest.fn().mockResolvedValue({
    ready: true,
    dataSource: "postgres",
    database: "up",
    shuttingDown: false,
    ...report,
  }),
  beginShutdown: jest.fn(),
});

const answering = () => ({ authenticate: jest.fn().mockResolvedValue(undefined) });
const refusing = () => ({ authenticate: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) });

describe("CacheHealthProbe", () => {
  it("reports the in-memory cache as not applicable: it cannot be unreachable", async () => {
    const probe = new CacheHealthProbe(database());

    await expect(probe.report()).resolves.toEqual({
      ready: true,
      dataSource: "postgres",
      database: "up",
      cache: "not_applicable",
      shuttingDown: false,
    });
  });

  it("reports `up` when the cache answers", async () => {
    const probe = new CacheHealthProbe(database(), { connection: answering() });

    await expect(probe.report()).resolves.toMatchObject({ ready: true, cache: "up" });
  });

  it("reports a cache that is down without taking the instance out of rotation", async () => {
    // Every replica shares the server, so every replica would go: a cache
    // outage would become a full one, and traffic would have nowhere to move.
    const probe = new CacheHealthProbe(database(), { connection: refusing() });

    await expect(probe.report()).resolves.toMatchObject({ ready: true, cache: "down" });
  });

  it("makes the instance not ready when the cache was declared required", async () => {
    const probe = new CacheHealthProbe(database(), { connection: refusing(), required: true });

    await expect(probe.report()).resolves.toMatchObject({ ready: false, cache: "down" });
  });

  it("keeps the database's verdict: a required cache that is up does not make it ready", async () => {
    const probe = new CacheHealthProbe(database({ ready: false, database: "down" }), {
      connection: answering(),
      required: true,
    });

    await expect(probe.report()).resolves.toMatchObject({
      ready: false,
      database: "down",
      cache: "up",
    });
  });

  it("gives up on a cache that accepts but never answers", async () => {
    const connection = { authenticate: jest.fn(() => new Promise<void>(() => {})) };
    const probe = new CacheHealthProbe(database(), { connection, timeoutMs: 20 });

    await expect(probe.report()).resolves.toMatchObject({ cache: "down" });
  });

  it("caches the answer so that probes do not hammer the cache", async () => {
    const connection = answering();
    const probe = new CacheHealthProbe(database(), { connection, ttlMs: 10_000 });

    await probe.report();
    await probe.report();

    expect(connection.authenticate).toHaveBeenCalledTimes(1);
  });

  it("asks the database and the cache at the same time, not one after the other", async () => {
    const slow = () =>
      ({ authenticate: () => new Promise<void>((resolve) => setTimeout(resolve, 60)) });
    const probe = new CacheHealthProbe(new HealthProbe({ connection: slow(), dataSource: "mysql" }), {
      connection: slow(),
    });

    const started = Date.now();
    await probe.report();

    expect(Date.now() - started).toBeLessThan(110);
  });

  it("passes shutdown on, and asks the cache again afterwards", async () => {
    const inner = database();
    const connection = answering();
    const probe = new CacheHealthProbe(inner, { connection, ttlMs: 10_000 });

    await probe.report();
    probe.beginShutdown();
    await probe.report();

    expect(inner.beginShutdown).toHaveBeenCalledTimes(1);
    expect(connection.authenticate).toHaveBeenCalledTimes(2);
  });
});
