# Testing

> 🇪🇸 [Leer en español](../es/testing.md)

The rule this project holds itself to: **a test must fail if the behaviour it
describes is removed.** Everything below follows from that.

---

## Running

```bash
npm test                  # every package
npm test -- --coverage
npm test -- packages/data # one package
npm test -- -t "lockRow"  # one test by name
```

Jest runs once from the repository root across all workspaces. One run means one
coverage report, which is what actually tells you whether the toolkit is tested —
seven separate reports each looking healthy can still hide a package nobody covers.

Tests import packages by name (`monolite-core`), and Jest maps those names to the
**sources**, not to `dist`. Pointing at build output would make every test run
depend on a prior build, and a stale build silently tests yesterday's code.

---

## What gets a unit test

Unit tests cover the **machinery**: the parts that are generic, structural, and
whose behaviour is not obvious from reading them.

- Filter compilers — the same `WhereFilter` against the SQL, Mongo and in-memory
  compilers, including the escaping and the rejection of unmapped properties.
- Dialect differences — paging, identity retrieval and row locking per engine.
- The route registry — specificity sorting, duplicate detection, decorator
  metadata.
- The OpenAPI builder — that the document matches the routes it was built from.
- The error mapper — every branch of "thrown value → status + code".
- The request and transaction contexts — that they survive `await` and stay
  isolated between concurrent flows.

What does **not** get a unit test is per-entity ceremony. A test asserting that
`UsersService.create` calls `usersRepository.insert` restates the implementation in
a second language; it passes as long as the two files agree with each other and
says nothing about whether either is correct. Those flows belong in end-to-end
tests, where a real request produces a real row.

---

## What gets an end-to-end test

Anything where the answer depends on more than one layer agreeing:

- A request through the full middleware chain, including the error envelope.
- Validation rejecting a body, with the field-level detail the client sees.
- A transactional use case, including the rollback path.
- Authentication: a token issued, then accepted, then rejected once expired.

These run against the in-memory driver by default, so they need no infrastructure.
Point `DATA_SOURCE` at a real engine to run the same suite against it.

---

## The contract test

`monolite-data` exports a **repository contract kit**: one suite that any
`IGenericRepository` implementation must pass.

```ts
import { runGenericRepositoryContract } from "monolite-data/testing";

// The driver's name is the first argument: it goes into the name of every test
// the kit generates, so a failure says which implementation broke.
runGenericRepositoryContract("MyCustomRepository", {
  create: () => new MyCustomRepository(/* ... */),
});
```

This is what makes "six engines, one contract" a claim rather than a hope. A new
driver is correct when it passes this suite, and a change to the contract fails
every driver that has not caught up.

---

## Writing a test that discriminates

The failure mode to watch for is a test that passes **with and without** the
mechanism it claims to cover. Two real examples from this codebase:

**A concurrency test on the in-memory driver.** It exercised the TOCTOU race the
row lock exists to close — but the in-memory driver is single-threaded, so the
interleaving never happened and the test passed with the lock removed. The fix was
to run it against SQL with forced interleaving.

**An ambient-transaction test on the memory unit of work.** It asserted the
repository joined the transaction, but the memory driver's repository and its
transactional scope are the same object, so joining was a no-op and the assertion
held either way.

Both were caught by the same technique, and it is the one worth internalising:

> Break the mechanism on purpose — comment it out, or gate it behind an
> environment variable — and confirm the test goes red. If it stays green, the
> test is measuring something else.

Do this once for every test that covers a subtle invariant. It costs a minute and
it is the difference between a suite that protects you and a suite that reassures
you.

---

## Coverage

```bash
npm test -- --coverage
```

Coverage is collected from `packages/*/src/**/*.ts` — **every** source file, not
only the ones some test happens to import. That is a deliberate choice with a cost:
the number goes down, because files nobody tests now appear at 0% instead of not
appearing at all.

That is the point. A report that only lists imported files reads as complete to
anyone skimming it, and the files most likely to be untested — bootstrap code,
middleware wiring, the process-level shutdown path — are exactly the ones no unit
test imports.

Do not chase the percentage. A module at 70% whose branches are all meaningfully
exercised is in better shape than one at 95% padded with assertions on getters.

---

## Testing your own project

A project generated by the CLI arrives with two suites and both pass on the first
run: a unit test over the configuration helpers, and an end-to-end one over the
application itself — health, the OpenAPI document, the example module and, in a
project with authentication, the login route and the guard in front of everything
else.

They need nothing running. `tests/setup/test-env.ts` forces `DATA_SOURCE=memory`
before a single module loads, so the tests get the real repository, the real
services and the real routes on the in-memory driver. Point that variable at an
engine to run the very same tests against one — the entity metadata does not change.

The application is driven in memory rather than over a socket:

```ts
import { api, API, headers, type Api } from "./support/api";

let http: Api;
let auth: Record<string, string>;

beforeAll(async () => {
  http = await api();       // Server.configure(), never Server.run()
  auth = await headers();   // a real token, from the real login route
});

it("rejects a body that fails validation", async () => {
  const response = await http.post(`${API}/branches`).set(auth).send({ name: "" });

  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ code: "VALIDATION_ERROR" });
  expect(response.body.errors[0]).toMatchObject({ field: "name" });
});
```

`Server.configure()` is `run()` without the listening, which is what lets the suite
run beside a `dev` server without fighting it for a port. The chain it assembles is
the same one, in the same order.

One caveat worth knowing: an Express error handler only covers routes registered
**before** it. If you assemble an app by hand in a test rather than through
`createApp` or the generated `Server`, register the error handling last, or your
errors escape as Express's default HTML and the assertion above fails for a reason
that has nothing to do with validation.
