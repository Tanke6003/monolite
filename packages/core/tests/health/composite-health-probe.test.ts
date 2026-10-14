import { CompositeHealthProbe, type HealthReport, type IHealthProbe } from "monolite-core";

function probeAnswering(dataSource: string, database: HealthReport["database"]) {
  return {
    report: jest.fn(async () => ({
      ready: database !== "down",
      dataSource,
      database,
      shuttingDown: false,
    })),
    beginShutdown: jest.fn(),
  } satisfies IHealthProbe;
}

describe("CompositeHealthProbe", () => {
  it("is not ready when one layer's database is down, and says which", async () => {
    const probe = new CompositeHealthProbe(
      new Map([
        ["records", probeAnswering("postgres", "up")],
        ["documents", probeAnswering("mongodb", "down")],
      ])
    );

    await expect(probe.report()).resolves.toEqual({
      ready: false,
      dataSource: "postgres,mongodb",
      database: "down",
      shuttingDown: false,
      layers: {
        records: { dataSource: "postgres", database: "up" },
        documents: { dataSource: "mongodb", database: "down" },
      },
    });
  });

  it("is up when every layer with a connection is", async () => {
    const probe = new CompositeHealthProbe(
      new Map([
        ["records", probeAnswering("postgres", "up")],
        ["scratch", probeAnswering("memory", "not_applicable")],
      ])
    );

    const report = await probe.report();
    expect(report.ready).toBe(true);
    expect(report.database).toBe("up");
  });

  it("hands the shutdown to every layer and stops being ready", async () => {
    const one = probeAnswering("postgres", "up");
    const two = probeAnswering("mongodb", "up");
    const probe = new CompositeHealthProbe(new Map([["a", one], ["b", two]]));

    probe.beginShutdown();

    expect(one.beginShutdown).toHaveBeenCalled();
    expect(two.beginShutdown).toHaveBeenCalled();
    await expect(probe.report()).resolves.toMatchObject({ ready: false, shuttingDown: true });
  });
});
