import type { ClientSession, Collection, Db, Document, MongoClient } from "mongodb";
import type { ILogger } from "monolite-core";
import type { DbEngine, IDbPlugin } from "../contracts/db-plugin.js";
import { loadOptionalDriver } from "./optional-driver.js";

/**
 * `MongoClient` is a value, not only a type, so a static import of it would
 * load the driver for anybody who imports this package — including the projects
 * on PostgreSQL that never installed it. The types above stay static: `import
 * type` is erased and costs nothing.
 */
function mongoClient(): typeof MongoClient {
  return loadOptionalDriver<{ MongoClient: typeof MongoClient }>("mongodb", "MongoDB").MongoClient;
}

export interface MongoConnectionConfig {
  host: string;
  port: number;
  database: string;
  /**
   * Optional credentials: unlike the four SQL engines, a development MongoDB
   * container usually runs without authentication, so having none is the normal
   * case locally.
   */
  username?: string;
  password?: string;
  /**
   * Anything else the connection string can carry, appended as its query.
   *
   * It exists because without it there is no way to reach a replica set that
   * does not advertise an address you can route to — which is every set behind
   * a port mapping, a tunnel or a load balancer, and therefore every one a
   * developer runs locally. The driver discovers the set's members and then
   * dials the address the set names itself by, so a container advertising
   * `localhost:27017` is unreachable from a host that mapped it elsewhere.
   * `{ directConnection: true }` is the answer, and it could not be said.
   *
   * That mattered more than it looks: a transaction on MongoDB **requires** a
   * replica set, so the engine's own transaction support was documented while
   * the standard way of running one could not be connected to.
   *
   * Also the way to `replicaSet`, `tls`, `readPreference` and `authSource`
   * when the default guess is wrong.
   */
  options?: Record<string, string | number | boolean>;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * MongoDB connector over the official `mongodb` driver.
 *
 * It implements `IDbPlugin` —and not `ISqlDbPlugin`— because there are no
 * statements to run here: what the generic repository consumes is a collection
 * and a session. That is exactly the boundary `db-plugin.ts` describes: the
 * lifecycle is shared with the SQL engines, the way of talking to the database
 * is not.
 *
 * The client is created lazily and memoized, just like `OracleConnector`'s pool:
 * the first operation that arrives opens it and the rest wait on that same
 * promise, so a start-up with several requests in parallel does not open several
 * clients.
 */
export class MongoConnector implements IDbPlugin {
  readonly engine: DbEngine = "mongodb";

  private client: MongoClient | null = null;
  private pending: Promise<MongoClient> | null = null;
  private closed = false;

  constructor(
    private readonly config: MongoConnectionConfig,
    private readonly logger: ILogger
  ) {}

  // --------------------------------------------------------------- client ---

  /**
   * Connection URI.
   *
   * User and password are encoded: a password containing `@`, `:` or `/`
   * —perfectly legal— would split the URI in the wrong place and the driver
   * would end up looking for a different host. Without credentials the
   * authentication part is not written at all, which is what an open mongod
   * expects.
   */
  private buildUri(): string {
    const { host, port, database, username, password, options } = this.config;
    const credentials = username
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? "")}@`
      : "";

    const entries = Object.entries(options ?? {});
    // Encoded for the same reason the password is: a value with an `&` in it
    // would otherwise become two options, one of them invented.
    const query = entries.length
      ? `?${entries
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
          .join("&")}`
      : "";

    return `mongodb://${credentials}${host}:${port}/${database}${query}`;
  }

  private getClient(): Promise<MongoClient> {
    if (this.client) return Promise.resolve(this.client);
    if (this.closed) throw new Error("[MongoConnector] The client has already been closed.");

    if (!this.pending) {
      const Client = mongoClient();
      const client = new Client(this.buildUri(), {
        // The official image's admin user lives in `admin`, not in the
        // application database; without credentials the option is not used.
        ...(this.config.username ? { authSource: "admin" } : {}),
      });

      this.pending = client
        .connect()
        .then((connected) => {
          this.client = connected;
          this.logger.info("MongoDB client created", {
            host: this.config.host,
            port: this.config.port,
            database: this.config.database,
          });
          return connected;
        })
        .catch((err) => {
          // Without this, a transient failure (the replica set still electing a
          // primary) would leave the rejected promise cached forever.
          this.pending = null;
          this.logger.error("Could not connect to MongoDB", { err: toMessage(err) });
          throw new Error(`[MongoConnector] connect failed: ${toMessage(err)}`, { cause: err });
        });
    }

    return this.pending;
  }

  private async database(): Promise<Db> {
    return (await this.getClient()).db(this.config.database);
  }

  /**
   * Collection by name. It is everything the generic repository needs from the
   * connector in order to read and write; the document <-> entity mapping is its
   * own business.
   */
  async collection<TDoc extends Document = Document>(name: string): Promise<Collection<TDoc>> {
    return (await this.database()).collection<TDoc>(name);
  }

  async authenticate(): Promise<void> {
    try {
      const database = await this.database();
      await database.command({ ping: 1 });
      this.logger.info("Connection to MongoDB established successfully.");
    } catch (err) {
      this.logger.error("Could not connect to MongoDB", { err: toMessage(err) });
      throw new Error(`[MongoConnector] authenticate failed: ${toMessage(err)}`, { cause: err });
    }
  }

  /**
   * Runs `work` inside a multi-document transaction: commit at the end,
   * rollback if it throws.
   *
   * `withTransaction` retries the operation on transient server errors, so
   * `work` may run more than once and must not carry side effects outside the
   * database. The session is always closed, even if the block blows up, so it is
   * not left hanging on the server.
   *
   * It requires the mongod to run as a replica set —hence the `--replSet rs0` in
   * the development compose file—: a standalone node has no oplog and rejects
   * the transaction.
   */
  async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    const session = client.startSession();

    try {
      return await session.withTransaction((active) => work(active));
    } catch (err) {
      this.logger.error("Transaction rolled back", { err: toMessage(err) });
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async close(): Promise<void> {
    if (!this.client) return;

    await this.client.close();
    this.client = null;
    this.pending = null;
    this.closed = true;
    this.logger.info("MongoDB client closed.");
  }
}
