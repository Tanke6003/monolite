/**
 * PostgreSQL and MongoDB in one application, as two named layers (#43).
 *
 * The in-memory tests show the wiring; this shows it holds where it matters:
 * each module served by its own engine through the stores an application
 * injects, a transaction that rolls back on PostgreSQL leaving the MongoDB
 * write in place, and `/health` answering for both.
 *
 * It runs when both engines are selected and is skipped otherwise — narrowing
 * `MONOLITE_IT_ENGINES` to one engine is a deliberate choice, not a missing
 * container.
 */
import type { IHealthProbe } from "monolite-core";
import { Transactional } from "monolite-crud";
import {
  ddlDialectFor,
  defineEntity,
  emitSchema,
  type IGenericRepository,
  type ISqlExecutor,
} from "monolite-data";
import { createContainer, registerPersistence, storeToken, TOKENS } from "monolite-di";
import { ENGINES, integrationLogger, selectedEngines } from "./support/engines";

interface IAccount {
  pkAccount: number;
  name: string;
  balanceCents: number;
}

interface IEvent {
  pkEvent: number;
  kind: string;
  accountId: number;
}

const ACCOUNT = defineEntity<IAccount>({
  table: "IT_LAYER_ACCOUNTS",
  primaryKey: "pkAccount",
  identity: true,
  columns: {
    pkAccount: { name: "PK_ACCOUNT", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string", length: 80, nullable: false },
    balanceCents: { name: "BALANCE_CENTS", kind: "number", nullable: false, default: "0" },
  },
});

// The account it refers to lives in the other layer, so the key is a plain
// column: a relation would be refused at start-up.
const EVENT = defineEntity<IEvent>({
  table: "IT_LAYER_EVENTS",
  primaryKey: "pkEvent",
  identity: true,
  columns: {
    pkEvent: { name: "PK_EVENT", kind: "number", insertable: false, updatable: false },
    kind: { name: "KIND", kind: "string", length: 40, nullable: false },
    accountId: { name: "ACCOUNT_ID", kind: "number", nullable: false },
  },
});

const selected = new Set(selectedEngines().map((engine) => engine.id));
const both = selected.has("postgres") && selected.has("mongodb");
const engine = (id: string) => ENGINES.find((one) => one.id === id)!;

(both ? describe : describe.skip)("two layers: PostgreSQL and MongoDB side by side", () => {
  const container = createContainer();
  const logger = integrationLogger();

  const records = registerPersistence({
    container,
    name: "records",
    dataSource: "postgres",
    logger,
    sequelize: engine("postgres").connection as never,
    entities: [{ name: "ACCOUNTS", metadata: ACCOUNT }],
  });
  const documents = registerPersistence({
    container,
    name: "documents",
    dataSource: "mongodb",
    logger,
    mongo: engine("mongodb").connection as never,
    entities: [{ name: "EVENTS", metadata: EVENT }],
  });

  const accounts = container.resolve<IGenericRepository<IAccount>>(storeToken("ACCOUNTS"));
  const events = container.resolve<IGenericRepository<IEvent>>(storeToken("EVENTS"));
  const sql = records.connection as unknown as ISqlExecutor;

  beforeAll(async () => {
    await records.connection!.authenticate();
    await documents.connection!.authenticate();

    await sql.execute(`DROP TABLE IF EXISTS ${ACCOUNT.table}`, {}, { expects: "none" });
    for (const statement of emitSchema([ACCOUNT], ddlDialectFor("postgres")!).split(";")) {
      const body = statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (body) await sql.execute(body, {}, { expects: "none" });
    }
  });

  beforeEach(async () => {
    await sql.execute(`DELETE FROM ${ACCOUNT.table}`, {}, { expects: "none" });
    await events.hardDeleteWhere({} as never);
  });

  afterAll(async () => {
    await records.connection?.close();
    await documents.connection?.close();
  });

  it("serves each module from its own engine", async () => {
    const account = await accounts.insert({ name: "ana", balanceCents: 100 });
    await events.insert({ kind: "opened", accountId: account.pkAccount });

    // Read back with SQL, past the store: the row is in PostgreSQL.
    const { rows } = await sql.execute(`SELECT * FROM ${ACCOUNT.table}`, {}, { expects: "rows" });
    expect(rows).toHaveLength(1);
    await expect(events.find({ where: { accountId: account.pkAccount } })).resolves.toHaveLength(1);
  });

  it("rolls back on PostgreSQL and keeps what the same method wrote to MongoDB", async () => {
    class Accounts {
      constructor(
        readonly accounts: IGenericRepository<IAccount>,
        readonly events: IGenericRepository<IEvent>
      ) {}

      @Transactional("records")
      async open(name: string): Promise<void> {
        const account = await this.accounts.insert({ name, balanceCents: 0 });
        await this.events.insert({ kind: "opened", accountId: account.pkAccount });
        throw new Error("the rest of the work failed");
      }
    }

    await expect(new Accounts(accounts, events).open("luis")).rejects.toThrow("failed");

    await expect(accounts.find({ where: { name: "luis" } })).resolves.toHaveLength(0);
    // The event outlived the transaction it was written in. That is the
    // boundary: two engines do not share a commit.
    await expect(events.find({ where: { kind: "opened" } })).resolves.toHaveLength(1);
  });

  it("commits on MongoDB on its own when that is the layer named", async () => {
    class Audit {
      constructor(readonly events: IGenericRepository<IEvent>) {}

      @Transactional("documents")
      async record(): Promise<void> {
        await this.events.insert({ kind: "a", accountId: 1 });
        await this.events.insert({ kind: "b", accountId: 1 });
        throw new Error("boom");
      }
    }

    await expect(new Audit(events).record()).rejects.toThrow("boom");
    await expect(events.count({ accountId: 1 })).resolves.toBe(0);
  });

  it("reports both layers on the health probe", async () => {
    const report = await container.resolve<IHealthProbe>(TOKENS.IHealthProbe).report();

    expect(report).toMatchObject({
      ready: true,
      database: "up",
      layers: {
        records: { dataSource: "postgres", database: "up" },
        documents: { dataSource: "mongodb", database: "up" },
      },
    });
  });
});
