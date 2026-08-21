import { api, API, headers, type Api } from "./support/api";

/**
 * The example module, over HTTP, through everything.
 *
 * Every one of these goes through the real chain: the router the decorators
 * built, the Zod schema that validates the body, `CrudController`, `CrudService`,
 * the mapper, the generic repository and the error handler on the way out. The
 * point is not to test `CrudService` again — it has unit tests of its own in the
 * toolkit — but to prove this module is *wired*: that the token resolves, the
 * routes are where the document says they are, and the status codes are the ones
 * a client will branch on.
 *
 * Written against a module the generator produced, so it is also the shape to
 * copy for the next one.
 */
describe("products, end to end", () => {
  let http: Api;
  let auth: Record<string, string>;

  beforeAll(async () => {
    http = await api();
    auth = await headers();
  });

  it("answers the listing with the paginated envelope", async () => {
    const response = await http.get(`${API}/products`).set(auth).expect(200);

    expect(response.body).toMatchObject({
      data: expect.any(Array),
      total: expect.any(Number),
      page: 1,
      limit: 10,
      pages: expect.any(Number),
    });
  });
#if memory

  it("starts with the rows the module seeds", async () => {
    // Seeded by `product.module.ts`, and only in memory: on a real engine the
    // rows come from a migration, not from the process that queries them.
    const response = await http.get(`${API}/products`).set(auth).expect(200);

    expect(response.body.total).toBeGreaterThanOrEqual(2);
  });
#endif

  it("takes the paging from the query and range-checks it", async () => {
    // A row of its own first: the module only seeds rows on the in-memory
    // driver, so a project scaffolded for a real engine starts empty and an
    // assertion about the first page would depend on which one it is.
    await http.post(`${API}/products`).set(auth).send({ name: "One to page over" }).expect(201);

    const paged = await http.get(`${API}/products?page=1&limit=1`).set(auth).expect(200);
    expect(paged.body).toMatchObject({ page: 1, limit: 1 });
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.total).toBeGreaterThanOrEqual(1);

    // `?limit=99999` is a request to page the whole table into memory, and the
    // schema is what refuses it — before any of this reaches the repository.
    const refused = await http.get(`${API}/products?limit=99999`).set(auth).expect(400);
    expect(refused.body).toMatchObject({ status: "error", code: "VALIDATION_ERROR" });
  });

  /**
   * The four verbs in the order a client uses them, in one test on purpose: an
   * id created by a previous `it` is a dependency between tests, and this way
   * the dependency is a local variable instead.
   */
  it("creates, reads, updates and soft deletes one", async () => {
    const created = await http
      .post(`${API}/products`)
      .set(auth)
      .send({ name: "Written by a test", description: "and read back" })
      .expect(201);

    expect(created.body).toMatchObject({ id: expect.any(Number), name: "Written by a test" });
    const { id } = created.body as { id: number };

    const read = await http.get(`${API}/products/${id}`).set(auth).expect(200);
    expect(read.body).toMatchObject({ id, description: "and read back" });

    const updated = await http
      .put(`${API}/products/${id}`)
      .set(auth)
      .send({ name: "Renamed", description: null })
      .expect(200);
    expect(updated.body).toMatchObject({ id, name: "Renamed", description: null });

    await http.delete(`${API}/products/${id}`).set(auth).expect(204);

    // Soft, not gone: the row is deactivated, and the listing and the lookup
    // both stop seeing it.
    await http.get(`${API}/products/${id}`).set(auth).expect(404);
  });

  it("refuses a body the schema does not accept, and says which field", async () => {
    const response = await http.post(`${API}/products`).set(auth).send({ name: "" }).expect(400);

    expect(response.body).toMatchObject({
      status: "error",
      code: "VALIDATION_ERROR",
      errors: expect.arrayContaining([expect.objectContaining({ field: "name" })]),
    });
  });

  it("refuses an id that is not one instead of querying for it", async () => {
    // `/products/abc` is a 400 and not a 404: the request is malformed, and the
    // distinction is what tells a client to fix its call rather than retry it.
    await http.get(`${API}/products/abc`).set(auth).expect(400);
  });

  it("answers 404 for an id that could exist and does not", async () => {
    const response = await http.get(`${API}/products/999999`).set(auth).expect(404);

    expect(response.body).toMatchObject({ status: "error", code: expect.any(String) });
  });
});
