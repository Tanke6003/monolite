import type { ICache } from "monolite-core";
import type { ITokenRevocation, TokenClaims } from "./contracts.js";

export interface CacheTokenRevocationOptions {
  /**
   * Prefix for every key this writes. Defaults to `"auth:"`, under whatever
   * prefix the cache itself applies (`REDIS_KEY_PREFIX` for Redis).
   */
  prefix?: string;
  /**
   * The longest lifetime, in seconds, of any token this application accepts.
   *
   * It is how long `revokeAllFor` has to be remembered: after that, every token
   * issued before it has expired on its own. Without it the mark is kept until
   * deleted — one small key per user that was ever cut off, which is cheap but
   * not nothing. A token with no `exp` revoked by `revoke` is kept that long as
   * well.
   */
  maxTokenLifetime?: number;
}

/** A claim read as a number, or `undefined` when it is not one. */
function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `ITokenRevocation` in an `ICache`: a denylist of `jti`s, and a "not before"
 * mark per subject.
 *
 * Both expire. A revoked `jti` is kept exactly as long as its token had left to
 * live, so the list never holds an entry for a token that would be refused
 * anyway; the per-subject mark is kept for `maxTokenLifetime`. With
 * `CACHE_DRIVER=redis` every replica sees the same list; with the in-memory
 * cache a sign-out holds only on the instance that received it, which is what a
 * single-process deployment is.
 *
 * The per-subject mark is compared against `iat`, which is in whole seconds. A
 * token issued in the very second the mark was written is still accepted —
 * the alternative is refusing the fresh token handed out right after a password
 * change, which is the common case, to close a window of under a second.
 */
export class CacheTokenRevocation implements ITokenRevocation {
  private readonly prefix: string;
  private readonly maxTokenLifetime?: number;

  constructor(
    private readonly cache: ICache,
    options: CacheTokenRevocationOptions = {}
  ) {
    this.prefix = options.prefix ?? "auth:";
    this.maxTokenLifetime = options.maxTokenLifetime;
  }

  async revoke(claims: TokenClaims): Promise<void> {
    const jti = text(claims.jti);
    if (!jti) throw new Error("[CacheTokenRevocation] The token has no `jti` to revoke it by.");

    const exp = numeric(claims.exp);
    if (exp === undefined) {
      await this.cache.set(this.revokedKey(jti), true, this.maxTokenLifetime);
      return;
    }

    // Already expired: the guard refuses it on `exp` alone, and a TTL of zero
    // or less is not one `ICache` accepts.
    const remaining = exp - Date.now() / 1000;
    if (remaining <= 0) return;

    await this.cache.set(this.revokedKey(jti), true, remaining);
  }

  async revokeAllFor(subject: string): Promise<void> {
    await this.cache.set(
      this.notBeforeKey(subject),
      Math.floor(Date.now() / 1000),
      this.maxTokenLifetime
    );
  }

  async isRevoked(claims: TokenClaims): Promise<boolean> {
    const jti = text(claims.jti);
    const sub = text(claims.sub);

    // Two reads, side by side: this runs on every guarded request.
    const [revoked, notBefore] = await Promise.all([
      jti ? this.cache.get<boolean>(this.revokedKey(jti)) : null,
      sub ? this.cache.get<number>(this.notBeforeKey(sub)) : null,
    ]);

    if (revoked) return true;
    if (typeof notBefore !== "number") return false;

    // A token with no `iat` cannot prove it came after the mark, so it is
    // treated as if it came before.
    const iat = numeric(claims.iat);
    return iat === undefined || iat < notBefore;
  }

  private revokedKey(jti: string): string {
    return `${this.prefix}revoked:${jti}`;
  }

  private notBeforeKey(subject: string): string {
    return `${this.prefix}not-before:${subject}`;
  }
}
