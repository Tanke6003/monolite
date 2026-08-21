import { api, API, SEED_CREDENTIALS, type Api } from "./support/api";

/**
 * The login flow and the guard in front of everything else.
 *
 * The guard is the one piece whose failure mode is silent in the good
 * direction: an API that lets everybody in works perfectly for every test that
 * only checks the happy path. So the assertions that matter here are the
 * negative ones — no token, wrong token, wrong password — and they are the
 * reason this file exists.
 */
describe("authentication, end to end", () => {
  let http: Api;

  beforeAll(async () => {
    http = await api();
  });

  it("signs in the seeded account and hands back a token", async () => {
    const response = await http.post(`${API}/auth/login`).send(SEED_CREDENTIALS).expect(200);

    expect(response.body).toMatchObject({
      token: expect.any(String),
      expiresIn: expect.any(Number),
      user: { email: SEED_CREDENTIALS.email, roles: expect.arrayContaining(["admin"]) },
    });
    // The hash never leaves the provider, and this is the assertion that keeps
    // it that way when somebody widens what login returns.
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
  });

  it("answers a wrong password and an unknown email the same way", async () => {
    const wrongPassword = await http
      .post(`${API}/auth/login`)
      .send({ ...SEED_CREDENTIALS, password: "not it" })
      .expect(401);

    const unknownEmail = await http
      .post(`${API}/auth/login`)
      .send({ email: "nobody@example.com", password: "not it" })
      .expect(401);

    // Deliberately identical: telling the two apart turns the login route into
    // a way of asking which addresses have accounts.
    expect(unknownEmail.body.message).toBe(wrongPassword.body.message);
  });

  it("validates the credentials before it checks them", async () => {
    const response = await http.post(`${API}/auth/login`).send({ email: "not-an-email" }).expect(400);

    expect(response.body).toMatchObject({ status: "error", code: "VALIDATION_ERROR" });
  });
#if example

  it("closes a route that nothing marked public", async () => {
    const response = await http.get(`${API}/products`).expect(401);

    expect(response.body).toMatchObject({ status: "error", code: expect.any(String) });
  });

  it("refuses a token it did not sign", async () => {
    await http
      .get(`${API}/products`)
      .set("Authorization", "Bearer not.a.real.token")
      .expect(401);
  });

  it("opens it for a token it did", async () => {
    const { body } = await http.post(`${API}/auth/login`).send(SEED_CREDENTIALS).expect(200);

    await http
      .get(`${API}/products`)
      .set("Authorization", `Bearer ${(body as { token: string }).token}`)
      .expect(200);
  });
#endif
});
