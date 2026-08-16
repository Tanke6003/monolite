import { HealthProbe } from "monolite-core";

describe("HealthProbe", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe("without a connection (the in-memory driver)", () => {
    const probe = () => new HealthProbe({ dataSource: "memory" });

    it("is ready: there is nothing to check", async () => {
      await expect(probe().report()).resolves.toEqual({
        ready: true,
        dataSource: "memory",
        database: "not_applicable",
        shuttingDown: false,
      });
    });
  });

  describe("with a connection", () => {
    it("reports `up` when the database answers", async () => {
      const connection = { authenticate: jest.fn().mockResolvedValue(undefined) };
      const probe = new HealthProbe({ connection, dataSource: "postgres" });

      await expect(probe.report()).resolves.toMatchObject({ ready: true, database: "up" });
    });

    it("reports `down` instead of propagating the failure", async () => {
      const connection = { authenticate: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
      const probe = new HealthProbe({ connection, dataSource: "postgres" });

      // The database not being there *is* the answer, not an error to propagate:
      // if it threw, the probe would answer a 500 instead of a 503.
      await expect(probe.report()).resolves.toMatchObject({
        ready: false,
        database: "down",
        shuttingDown: false,
      });
    });

    it("gives up on a database that accepts but never answers", async () => {
      // Never resolves: this is the case that leaves an unbounded probe hanging.
      const connection = { authenticate: jest.fn(() => new Promise<void>(() => {})) };
      const probe = new HealthProbe({ connection, dataSource: "oracle", timeoutMs: 20 });

      await expect(probe.report()).resolves.toMatchObject({ ready: false, database: "down" });
    });

    it("caches the result so that probes do not hammer the database", async () => {
      const connection = { authenticate: jest.fn().mockResolvedValue(undefined) };
      const probe = new HealthProbe({ connection, dataSource: "mysql", ttlMs: 10_000 });

      await probe.report();
      await probe.report();
      await probe.report();

      expect(connection.authenticate).toHaveBeenCalledTimes(1);
    });

    it("asks again once the cache expires", async () => {
      const connection = { authenticate: jest.fn().mockResolvedValue(undefined) };
      const probe = new HealthProbe({ connection, dataSource: "mysql", ttlMs: 5 });

      await probe.report();
      await new Promise((resolve) => setTimeout(resolve, 15));
      await probe.report();

      expect(connection.authenticate).toHaveBeenCalledTimes(2);
    });
  });

  describe("shutdown", () => {
    it("stops being ready even though the database is still standing", async () => {
      const connection = { authenticate: jest.fn().mockResolvedValue(undefined) };
      const probe = new HealthProbe({ connection, dataSource: "postgres" });

      await expect(probe.report()).resolves.toMatchObject({ ready: true });

      probe.beginShutdown();

      await expect(probe.report()).resolves.toMatchObject({
        ready: false,
        database: "up",
        shuttingDown: true,
      });
    });

    it("draining shows up on the very next probe, without waiting for the cache to expire", async () => {
      const connection = { authenticate: jest.fn().mockResolvedValue(undefined) };
      const probe = new HealthProbe({ connection, dataSource: "postgres", ttlMs: 60_000 });

      await probe.report();
      probe.beginShutdown();

      await expect(probe.report()).resolves.toMatchObject({ ready: false, shuttingDown: true });
    });
  });
});
