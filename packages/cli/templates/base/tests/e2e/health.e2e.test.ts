import { api, API, type Api } from "./support/api";

/**
 * The two questions an orchestrator asks, and the answer it gets for a route
 * that does not exist.
 *
 * They are worth an end-to-end test rather than a unit one because what is on
 * trial is the wiring: that the probe is registered, that the routes are
 * mounted where a load balancer will look for them, and that a failure comes
 * back as this API's own JSON rather than as Express's HTML page.
 */
describe("health and the shape of a failure", () => {
  let http: Api;

  beforeAll(async () => {
    http = await api();
  });

  it("says it is alive without touching the database", async () => {
    const response = await http.get("/health/live").expect(200);

    expect(response.body).toMatchObject({ status: "ok", uptime: expect.any(Number) });
  });

  it("says it is ready, and which driver it is ready on", async () => {
    const response = await http.get("/health/ready").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      dataSource: "memory",
      // Published rather than assumed: `API_PREFIX` is configurable, so a
      // client discovers where this instance serves instead of guessing.
      apiPrefix: API || "/",
    });
  });

  it("answers readiness on the bare path too", async () => {
    // The address a load balancer configured with `/health` will call. A 404
    // there reads to it as an instance that is down.
    const response = await http.get("/health").expect(200);

    expect(response.body).toMatchObject({ status: "ok" });
  });

  it("answers an unknown route with the API's own error envelope", async () => {
    const response = await http.get(`${API}/nothing-here`).expect(404);

    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toMatchObject({
      status: "error",
      code: expect.any(String),
      // The same value as the `X-Request-Id` header, which is what makes a
      // report from a user traceable to a line in the log.
      requestId: response.headers["x-request-id"],
    });
  });

  it("gives every request an id, whether or not it went well", async () => {
    const response = await http.get("/health/live").expect(200);

    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
  });
});
