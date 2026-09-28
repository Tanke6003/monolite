import path from "node:path";
import ts from "typescript";

import type { IGenericRepository, QueryOptions, WhereFilter } from "monolite-data";
import {
  allOf,
  contains,
  CrudBLL,
  eq,
  filtersFor,
  gt,
  gte,
  lt,
  lte,
  type EntityMapper,
} from "monolite-crud";

interface IPayment {
  pkPayment: number;
  reference: string;
  notes: string | null;
  clientId: number;
  chargeId: number;
  methodId: number;
  paymentDate: Date;
}

type PaymentQuery = {
  q?: string;
  clientId?: number;
  chargeId?: number;
  methodId?: number;
  from?: string;
  to?: string;
};

/** The hand-written override the declarative form replaces, verbatim from the issue. */
function handWrittenWhere(query: unknown): WhereFilter<IPayment> | undefined {
  const q = (query ?? {}) as PaymentQuery;
  const clauses: WhereFilter<IPayment>[] = [];

  if (q.q) clauses.push({ reference: { contains: q.q } });
  if (q.clientId !== undefined) clauses.push({ clientId: q.clientId });
  if (q.chargeId !== undefined) clauses.push({ chargeId: q.chargeId });
  if (q.methodId !== undefined) clauses.push({ methodId: q.methodId });
  if (q.from) clauses.push({ paymentDate: { gte: new Date(`${q.from}T00:00:00.000Z`) } });
  if (q.to) clauses.push({ paymentDate: { lte: new Date(`${q.to}T23:59:59.999Z`) } });

  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

const paymentFilters = filtersFor<IPayment, PaymentQuery>({
  q: contains("reference"),
  clientId: eq("clientId"),
  chargeId: eq("chargeId"),
  methodId: eq("methodId"),
  from: gte("paymentDate", { boundary: "startOfDay" }),
  to: lte("paymentDate", { boundary: "endOfDay" }),
});

const mapper: EntityMapper<IPayment, IPayment> = {
  toDTO: (entity) => entity,
  toDTOList: (entities) => entities,
  toEntity: (dto) => dto,
  toPartialEntity: (dto) => dto,
};

class HandWrittenBLL extends CrudBLL<IPayment, IPayment> {
  constructor(repository: IGenericRepository<IPayment>) {
    super(repository, mapper);
  }

  protected override buildWhere(query: unknown): QueryOptions<IPayment>["where"] {
    return handWrittenWhere(query);
  }
}

class DeclaredBLL extends CrudBLL<IPayment, IPayment> {
  constructor(repository: IGenericRepository<IPayment>) {
    super(repository, mapper, { filters: paymentFilters });
  }
}

function fakeRepository() {
  return {
    getPaged: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 10, pages: 0 }),
  };
}

/** The `where` a BLL hands the repository for this query. */
async function whereSentBy(
  Service: new (repository: IGenericRepository<IPayment>) => CrudBLL<IPayment, IPayment>,
  query: unknown
): Promise<unknown> {
  const repository = fakeRepository();
  await new Service(repository as unknown as IGenericRepository<IPayment>).list(1, 10, { query });
  return repository.getPaged.mock.calls[0][2].where;
}

describe("filtersFor", () => {
  /**
   * The test that lets the hand-written overrides be converted with
   * confidence: for every shape of query, the declared map and the function it
   * replaces send the repository the same filter — and therefore the same SQL.
   */
  it.each<[string, PaymentQuery | undefined]>([
    ["no query at all", undefined],
    ["an empty query", {}],
    ["one parameter", { clientId: 4 }],
    ["an empty search box", { q: "" }],
    ["a zero, which is a value", { methodId: 0 }],
    ["a date range", { from: "2026-03-01", to: "2026-03-31" }],
    [
      "every parameter",
      { q: "INV", clientId: 4, chargeId: 9, methodId: 2, from: "2026-03-01", to: "2026-03-31" },
    ],
  ])("builds the same filter as the hand-written buildWhere for %s", async (_, query) => {
    const declared = await whereSentBy(DeclaredBLL, query);

    expect(declared).toEqual(await whereSentBy(HandWrittenBLL, query));
    expect(paymentFilters.where(query)).toEqual(handWrittenWhere(query));
  });

  it("answers undefined, not an empty $and, when no parameter is present", () => {
    // `{ $and: [] }` is the same filter to a reader and not necessarily to a
    // driver; nothing to filter on has to mean no filter.
    expect(paymentFilters.where({ page: 1, limit: 10 })).toBeUndefined();
    expect(paymentFilters.where(undefined)).toBeUndefined();
  });

  it("answers the bare clause, not a one-element $and, for a single parameter", () => {
    // A one-element `$and` adds parentheses to the emitted SQL; a project that
    // migrates must see its statements unchanged.
    expect(paymentFilters.where({ chargeId: 9 })).toEqual({ chargeId: 9 });
  });

  it("emits the clauses in the order the rules are declared", () => {
    // Order is what makes the output identical to the override it replaces,
    // rather than merely equivalent.
    expect(paymentFilters.where({ to: "2026-03-31", clientId: 4 })).toEqual({
      $and: [
        { clientId: 4 },
        { paymentDate: { lte: new Date("2026-03-31T23:59:59.999Z") } },
      ],
    });
  });

  it("ignores query parameters that have no rule", () => {
    // Paging travels in the same query object and is not a filter.
    expect(paymentFilters.where({ page: 2, limit: 50, sort: "x", clientId: 1 })).toEqual({
      clientId: 1,
    });
    expect(paymentFilters.params).toEqual(["q", "clientId", "chargeId", "methodId", "from", "to"]);
  });
});

describe("contains", () => {
  const search = filtersFor<IPayment>({ q: contains(["reference", "notes"]) });

  it("searches several columns with an $or of the columns and nothing else", () => {
    // The part that used to be assembled by hand, and the reason modules
    // searched only the first column somebody thought of.
    expect(search.where({ q: "rent" })).toEqual({
      $or: [{ reference: { contains: "rent" } }, { notes: { contains: "rent" } }],
    });
  });

  it("emits a bare clause for a single column, whether or not it comes in an array", () => {
    const single = filtersFor<IPayment>({ q: contains(["reference"]) });
    expect(single.where({ q: "rent" })).toEqual({ reference: { contains: "rent" } });
  });

  it("refuses an empty list of columns when the filters are declared", () => {
    // An `$or` of nothing would filter everything away, or nothing, depending
    // on the driver; better to fail where the mistake is written.
    expect(() => contains([])).toThrow(/at least one column/);
  });
});

describe("date boundaries", () => {
  const range = filtersFor<IPayment>({
    from: gte("paymentDate", { boundary: "startOfDay" }),
    to: lte("paymentDate", { boundary: "endOfDay" }),
    after: gt("paymentDate"),
    before: lt("paymentDate"),
  });

  it("takes the first millisecond of the lower day and the last of the upper one, in UTC", () => {
    expect(range.where({ from: "2026-03-01", to: "2026-03-31" })).toEqual({
      $and: [
        { paymentDate: { gte: new Date("2026-03-01T00:00:00.000Z") } },
        { paymentDate: { lte: new Date("2026-03-31T23:59:59.999Z") } },
      ],
    });
  });

  it("reads a Date from z.coerce.date() by its UTC calendar day", () => {
    expect(range.where({ to: new Date("2026-03-31T10:15:00.000Z") })).toEqual({
      paymentDate: { lte: new Date("2026-03-31T23:59:59.999Z") },
    });
  });

  it("refuses a value that is not a calendar date with a 400 naming the parameter", () => {
    // Concatenating the boundary onto a timestamp yields an Invalid Date, which
    // no driver treats as an error — a filter that silently matches nothing.
    expect(() => range.where({ from: "2026-03-01T10:00:00Z" })).toThrow(
      expect.objectContaining({ statusCode: 400, message: expect.stringContaining('"from"') })
    );
    expect(() => range.where({ to: "2026-02-30" })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("passes the value through untouched when no boundary is asked for", () => {
    expect(range.where({ after: "2026-03-01T10:00:00Z", before: 5 })).toEqual({
      $and: [
        { paymentDate: { gt: "2026-03-01T10:00:00Z" } },
        { paymentDate: { lt: 5 } },
      ],
    });
  });
});

describe("allOf", () => {
  it("combines a rule with the declared filters the same three ways", () => {
    const rule: WhereFilter<IPayment> = { methodId: 1 };

    expect(allOf<IPayment>()).toBeUndefined();
    expect(allOf<IPayment>(undefined, rule)).toBe(rule);
    expect(allOf<IPayment>({ clientId: 2 }, rule)).toEqual({ $and: [{ clientId: 2 }, rule] });
  });

  /**
   * The escape hatch the issue keeps: a filter that is logic overrides
   * `buildWhere`, and still gets the declared ones through `super`.
   */
  it("lets an overridden buildWhere add a rule on top of the declared filters", async () => {
    class OverdueBLL extends DeclaredBLL {
      protected override buildWhere(query: unknown): QueryOptions<IPayment>["where"] {
        const { overdue } = (query ?? {}) as { overdue?: boolean };
        const rule = overdue ? { paymentDate: { lt: new Date("2026-01-01") } } : undefined;
        return allOf(super.buildWhere(query), rule);
      }
    }

    await expect(whereSentBy(OverdueBLL, { clientId: 3, overdue: true })).resolves.toEqual({
      $and: [{ clientId: 3 }, { paymentDate: { lt: new Date("2026-01-01") } }],
    });
  });
});

// ------------------------------------------------------------------ types ---

const ROOT = path.resolve(__dirname, "..", "..", "..");
const FILTERS_SOURCE = path.resolve(__dirname, "..", "src", "filter.query");

/**
 * Type-checks `body` with the filter builders in scope, and returns the
 * messages. Jest does not type-check test files, so a compile-time guarantee
 * can only be tested by running the compiler.
 */
function typeErrors(body: string): string[] {
  const file = path.join(__dirname, "__filters-probe__.ts");
  const source =
    `import { filtersFor, eq, contains, gte } from ${JSON.stringify(FILTERS_SOURCE)};\n` +
    `interface IPayment { pkPayment: number; reference: string; clientId: number; paymentDate: Date }\n` +
    body;

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
    // The workspace packages resolve to their sources, as they do for jest:
    // `dist` may not exist, and a stale one would check yesterday's types.
    baseUrl: ROOT,
    paths: { "monolite-*": ["packages/*/src/index.ts"] },
  };

  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);

  host.readFile = (name) => (path.resolve(name) === file ? source : readFile(name));
  host.fileExists = (name) => path.resolve(name) === file || fileExists(name);
  host.getSourceFile = (name, language) =>
    path.resolve(name) === file
      ? ts.createSourceFile(name, source, language)
      : getSourceFile(name, language);

  const program = ts.createProgram([file], options, host);

  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("filtersFor types", () => {
  // Compiling pulls in the data and core sources; generous, not slow.
  jest.setTimeout(60_000);

  it("accepts rules over properties the entity has", () => {
    // The negative control: without it, the tests below would pass just as
    // well if the probe failed to compile for an unrelated reason.
    expect(
      typeErrors(`
        filtersFor<IPayment>({
          q: contains(["reference"]),
          clientId: eq("clientId"),
          from: gte("paymentDate", { boundary: "startOfDay" }),
        });
      `)
    ).toEqual([]);
  });

  it("fails to compile a filter naming a property the entity does not have", () => {
    // The typo, or the column renamed in the entity and not here: caught by the
    // build rather than by a listing that quietly stops filtering.
    expect(typeErrors(`filtersFor<IPayment>({ clientId: eq("clientID") });`)).not.toEqual([]);
    expect(
      typeErrors(`filtersFor<IPayment>({ q: contains(["reference", "memo"]) });`)
    ).not.toEqual([]);
  });

  it("fails to compile a parameter the query type does not have, when one is given", () => {
    // The drift between the schema and the hand-written cast, closed.
    const query = `type Q = { clientId?: number };`;

    expect(typeErrors(`${query} filtersFor<IPayment, Q>({ clientId: eq("clientId") });`)).toEqual(
      []
    );
    expect(
      typeErrors(`${query} filtersFor<IPayment, Q>({ customerId: eq("clientId") });`)
    ).not.toEqual([]);
  });
});
