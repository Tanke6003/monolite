import { MongoClient } from "mongodb";
import { MongoConnector, type MongoConnectionConfig } from "@monolite/data";

// The real driver would open an actual connection; here the only thing that
// matters is what the connector asks it for and how it translates its answers.
jest.mock("mongodb", () => ({ MongoClient: jest.fn() }));

const CONFIG: MongoConnectionConfig = { host: "localhost", port: 27017, database: "testdb" };

const logger = {
  log: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
} as never;

describe("MongoConnector", () => {
  let database: any;
  let session: any;
  let client: any;

  beforeEach(() => {
    jest.clearAllMocks();

    database = {
      command: jest.fn().mockResolvedValue({ ok: 1 }),
      collection: jest.fn((name: string) => ({ name })),
    };
    session = {
      withTransaction: jest.fn((work: (s: unknown) => Promise<unknown>) => work(session)),
      endSession: jest.fn(),
    };
    client = {
      connect: jest.fn().mockImplementation(() => Promise.resolve(client)),
      db: jest.fn().mockReturnValue(database),
      startSession: jest.fn().mockReturnValue(session),
      close: jest.fn(),
    };

    (MongoClient as unknown as jest.Mock).mockImplementation(() => client);
  });

  const connector = (config = CONFIG) => new MongoConnector(config, logger);
  const uriOf = () => (MongoClient as unknown as jest.Mock).mock.calls[0][0] as string;
  const optionsOf = () =>
    (MongoClient as unknown as jest.Mock).mock.calls[0][1] as Record<string, unknown>;

  describe("identity", () => {
    it("announces itself as mongodb, which is the DATA_SOURCE value", () => {
      expect(connector().engine).toBe("mongodb");
    });
  });

  describe("client", () => {
    it("is created lazily and only once", async () => {
      const mongo = connector();
      expect(MongoClient).not.toHaveBeenCalled();

      await Promise.all([mongo.collection("USERS"), mongo.collection("BRANCHES")]);

      // Two operations in parallel wait on the same connection promise: without
      // that, start-up would open several clients.
      expect(MongoClient).toHaveBeenCalledTimes(1);
      expect(client.connect).toHaveBeenCalledTimes(1);
    });

    it("without credentials the URI carries no authentication part", async () => {
      await connector().authenticate();

      expect(uriOf()).toBe("mongodb://localhost:27017/testdb");
      expect(optionsOf()).toEqual({});
    });

    it("with credentials it encodes them and authenticates against admin", async () => {
      // A password containing `@` or `/` would split the URI in the wrong place.
      await connector({ ...CONFIG, username: "app user", password: "p@ss/word" }).authenticate();

      expect(uriOf()).toBe("mongodb://app%20user:p%40ss%2Fword@localhost:27017/testdb");
      expect(optionsOf()).toEqual({ authSource: "admin" });
    });

    it("does not cache a failed connection: a transient failure can be retried", async () => {
      client.connect
        .mockRejectedValueOnce(new Error("replica set with no primary"))
        .mockImplementation(() => Promise.resolve(client));

      const mongo = connector();
      await expect(mongo.authenticate()).rejects.toThrow(/connect failed/);
      await expect(mongo.authenticate()).resolves.toBeUndefined();
    });

    it("wraps the failure keeping the cause, which is what the global handler walks", async () => {
      const cause = new Error("ECONNREFUSED");
      client.connect.mockRejectedValueOnce(cause);

      await expect(connector().collection("USERS")).rejects.toMatchObject({ cause });
    });
  });

  describe("authenticate", () => {
    it("checks the database with a ping", async () => {
      await connector().authenticate();

      expect(database.command).toHaveBeenCalledWith({ ping: 1 });
    });

    it("wraps the ping failure", async () => {
      database.command.mockRejectedValueOnce(new Error("not authorized"));

      await expect(connector().authenticate()).rejects.toThrow(/authenticate failed/);
    });
  });

  describe("collection", () => {
    it("resolves the collection on the configured database", async () => {
      await expect(connector().collection("USERS")).resolves.toEqual({ name: "USERS" });
      expect(client.db).toHaveBeenCalledWith("testdb");
    });
  });

  describe("transaction", () => {
    it("runs the block inside the session and always closes it", async () => {
      const mongo = connector();

      const result = await mongo.transaction(async (active) => {
        expect(active).toBe(session);
        return "committed";
      });

      expect(result).toBe("committed");
      expect(session.withTransaction).toHaveBeenCalledTimes(1);
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it("propagates the block's error and closes the session all the same", async () => {
      session.withTransaction.mockRejectedValueOnce(new Error("transaction aborted"));

      await expect(connector().transaction(async () => "x")).rejects.toThrow("transaction aborted");
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("close", () => {
    it("closes the client and does not reopen it afterwards", async () => {
      const mongo = connector();
      await mongo.authenticate();
      await mongo.close();

      expect(client.close).toHaveBeenCalledTimes(1);
      await expect(mongo.collection("USERS")).rejects.toThrow(/has already been closed/);
    });

    it("closing without having connected does nothing", async () => {
      await expect(connector().close()).resolves.toBeUndefined();
      expect(client.close).not.toHaveBeenCalled();
    });
  });
});
