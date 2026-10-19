import type { CounterValue, ICache, ILogger, IncrementOptions } from "monolite-core";
import type { createClient, RedisClientType } from "redis";
import { loadOptionalDriver } from "./optional-driver.js";

/**
 * `ICache` on Redis: one store every replica sees, which is the reason to have
 * it. A rate limit counted here is the limit across all of them, and a key one
 * instance `add`s is a key no other one can.
 *
 * It lives with the database connectors because it is the same kind of thing —
 * a driver the application installs only if it uses it — and it stays out of
 * `IGenericRepository` because it is not the same kind of store: no `WHERE`, no
 * soft delete, no audit trail. `redis` is an optional peer dependency, required
 * when the cache is built rather than when this module is imported.
 *
 * Values are stored as JSON, which is what `ICache` promises everywhere. Every
 * key goes under `keyPrefix`, so two applications can share a server without
 * reading each other's keys, and `deletePrefix` can never reach outside it.
 */

export interface RedisCacheConfig {
  /** `redis://[[user]:password@]host[:port][/db]`, or `rediss://` for TLS. */
  url: string;
  /** Put in front of every key. An application sharing a server sets its own. */
  keyPrefix?: string;
}

type RedisDriver = { createClient: typeof createClient };
type Client = RedisClientType;

const CACHE = {
  area: "cache",
  otherwise: "set CACHE_DRIVER=memory to keep the cache in the process",
};

/**
 * Add, and set the expiry only if this call created the key — in one round
 * trip and atomically, which two commands from the client would not be: a
 * second replica could hit between them and the window would never close.
 */
const INCREMENT = `
local created = redis.call('EXISTS', KEYS[1]) == 0
local value = redis.call('INCRBY', KEYS[1], ARGV[1])
if created and ARGV[2] ~= '' then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return { value, redis.call('PTTL', KEYS[1]) }
`;

/** `SCAN MATCH` takes a glob, so a prefix holding `*` or `[` has to be escaped. */
function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, "\\$&");
}

function ttlToMs(ttlSeconds: number | undefined): number | null {
  if (ttlSeconds === undefined) return null;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError(`[cache] ttlSeconds must be a positive number; received ${ttlSeconds}.`);
  }
  return Math.max(1, Math.round(ttlSeconds * 1000));
}

function toJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError(`[cache] the value must be serialisable to JSON; received ${String(value)}.`);
  }
  return json;
}

export class RedisCache implements ICache {
  private readonly client: Client;
  private readonly prefix: string;
  private connecting: Promise<unknown> | null = null;

  constructor(
    config: RedisCacheConfig,
    private readonly logger: ILogger
  ) {
    const redis = loadOptionalDriver<RedisDriver>("redis", "Redis", CACHE);
    this.prefix = config.keyPrefix ?? "";
    this.client = redis.createClient({ url: config.url }) as unknown as Client;

    // An `error` event nobody listens to takes the process down. The client
    // reconnects on its own; what is worth doing here is saying so.
    this.client.on("error", (err: unknown) => {
      this.logger.error("Redis connection error", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ------------------------------------------------------- the connection ----

  /**
   * Opens the connection and checks it answers. `warmUp` calls it, so a cache
   * that cannot be reached stops the start-up instead of the first request.
   */
  async authenticate(): Promise<void> {
    await this.ping();
    this.logger.info("Connection to Redis established successfully.");
  }

  /**
   * Checks the server answers, without saying so in the log: the health probe
   * calls it every few seconds, and `authenticate`'s line would bury the rest.
   */
  async ping(): Promise<void> {
    await (await this.ready()).ping();
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }

  /** Connected, opening the connection the first time anything needs it. */
  private async ready(): Promise<Client> {
    if (this.client.isReady) return this.client;
    if (!this.client.isOpen) {
      this.connecting ??= this.client.connect().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
    return this.client;
  }

  // ----------------------------------------------------------- the cache ----

  async get<T>(key: string): Promise<T | null> {
    const json = await (await this.ready()).get(this.prefix + key);
    return json === null ? null : (JSON.parse(String(json)) as T);
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const json = toJson(value);
    const ttl = ttlToMs(ttlSeconds);
    await (await this.ready()).set(
      this.prefix + key,
      json,
      ttl === null ? undefined : { expiration: { type: "PX", value: ttl } }
    );
  }

  async delete(key: string): Promise<void> {
    await (await this.ready()).unlink(this.prefix + key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    const client = await this.ready();
    const match = `${escapeGlob(this.prefix + prefix)}*`;

    // SCAN rather than KEYS: KEYS blocks the server while it walks the whole
    // keyspace, and the server is shared with every replica.
    for await (const keys of client.scanIterator({ MATCH: match, COUNT: 500 })) {
      if (keys.length > 0) await client.unlink(keys);
    }
  }

  async add<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    const json = toJson(value);
    const ttl = ttlToMs(ttlSeconds);
    const reply = await (await this.ready()).set(this.prefix + key, json, {
      condition: "NX",
      ...(ttl === null ? {} : { expiration: { type: "PX", value: ttl } }),
    });
    return reply === "OK";
  }

  async increment(key: string, options: IncrementOptions = {}): Promise<CounterValue> {
    const by = options.by ?? 1;
    if (!Number.isInteger(by)) {
      throw new TypeError(`[cache] increment takes a whole number; received ${by}.`);
    }
    const ttl = ttlToMs(options.ttlSeconds);

    const [value, remainingMs] = (await (await this.ready()).eval(INCREMENT, {
      keys: [this.prefix + key],
      arguments: [String(by), ttl === null ? "" : String(ttl)],
    })) as [number, number];

    return {
      value: Number(value),
      // PTTL answers -1 for a key with no expiry.
      expiresAt: remainingMs >= 0 ? new Date(Date.now() + Number(remainingMs)) : null,
    };
  }
}
