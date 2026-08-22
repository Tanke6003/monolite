import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type BinaryLike,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";
import type { IPasswordHasher } from "./contracts.js";

/**
 * `crypto.scrypt` returns its key through a callback and has two overloads, so
 * the promisified function is annotated rather than inferred: without this,
 * TypeScript picks whichever overload it matched first and the `options`
 * argument — where the cost parameters live — disappears from the signature.
 */
const derive = promisify(scrypt) as (
  password: BinaryLike,
  salt: BinaryLike,
  keyLength: number,
  options: ScryptOptions
) => Promise<Buffer>;

/**
 * Marker at the head of every stored hash. It exists so that a future hasher
 * can recognise, and refuse, a hash that is not its own instead of silently
 * comparing nonsense.
 */
const SCHEME = "scrypt";

/**
 * Defaults for the cost parameters.
 *
 * `cost` (N) is the work factor and has to be a power of two; `blockSize` (r)
 * drives how much memory each attempt needs; `parallelization` (p) is left at 1
 * because Node's implementation does not thread it anyway. At N = 2^15 and
 * r = 8 a single derivation costs about 32 MB of memory, which is what makes
 * scrypt expensive to attack on a GPU — the whole point of choosing it over a
 * plain hash. OWASP's current guidance is N = 2^17; raise it when the process
 * has the memory headroom for it (each concurrent login pays that cost), and
 * note that old hashes keep verifying because their own parameters travel
 * inside them.
 */
const DEFAULTS = {
  cost: 2 ** 15,
  blockSize: 8,
  parallelization: 1,
  keyLength: 64,
  saltLength: 16,
} as const;

export interface ScryptPasswordHasherOptions {
  /** N, the CPU/memory cost. Must be a power of two. Default 2^15. */
  cost?: number;
  /** r, the block size. Default 8. */
  blockSize?: number;
  /** p, the parallelisation factor. Default 1. */
  parallelization?: number;
  /** Length of the derived key, in bytes. Default 64. */
  keyLength?: number;
  /** Length of the per-password salt, in bytes. Default 16. */
  saltLength?: number;
}

/**
 * Node refuses to derive a key when the parameters would need more memory than
 * `maxmem`, whose default is 32 MB — exactly what N = 2^15, r = 8 asks for, so
 * the default settings would sit on the edge of failing. The budget is computed
 * from the parameters instead of configured, with room to spare, so that
 * raising the cost never means also remembering to raise a second, unrelated
 * knob.
 */
function memoryBudget(cost: number, blockSize: number): number {
  return Math.max(32 * 1024 * 1024, 256 * cost * blockSize);
}

/**
 * Password hashing on top of Node's built-in `crypto.scrypt`.
 *
 * **Why scrypt.** It ships with Node, so this package hashes passwords without
 * pulling in a dependency — and a hashing dependency is not an ordinary one:
 * bcrypt and argon2 are native modules that need a toolchain to build, break on
 * Node upgrades and have to be rebuilt per platform, which is a real cost to
 * impose on every application that only wanted a login. scrypt is memory-hard
 * (RFC 7914), which is the property that matters against GPU cracking, and it
 * is an algorithm OWASP explicitly accepts for password storage. It is a
 * defensible default, not a claim that it is the best available.
 *
 * **Swapping it out.** Everything in this package talks to `IPasswordHasher`,
 * never to this class. An application that wants argon2id writes twenty lines
 * implementing `hash` and `verify` over the `argon2` package and passes that to
 * `AuthBLL` instead; nothing else changes. The encoded hashes carry their
 * scheme at the front precisely so both can coexist while stored passwords are
 * migrated on next login.
 *
 * **Storage format.** `scrypt$N$r$p$salt$hash`, with salt and key in base64.
 * The parameters live inside each hash rather than in configuration so that
 * raising the cost does not invalidate every password already stored: an old
 * hash still verifies with the parameters it was made with.
 */
export class ScryptPasswordHasher implements IPasswordHasher {
  private readonly cost: number;
  private readonly blockSize: number;
  private readonly parallelization: number;
  private readonly keyLength: number;
  private readonly saltLength: number;

  constructor(options: ScryptPasswordHasherOptions = {}) {
    this.cost = options.cost ?? DEFAULTS.cost;
    this.blockSize = options.blockSize ?? DEFAULTS.blockSize;
    this.parallelization = options.parallelization ?? DEFAULTS.parallelization;
    this.keyLength = options.keyLength ?? DEFAULTS.keyLength;
    this.saltLength = options.saltLength ?? DEFAULTS.saltLength;
  }

  async hash(plain: string): Promise<string> {
    // A salt per password, never a global one: without it two users with the
    // same password get the same hash, which both leaks that fact and lets one
    // precomputed table cover the entire table of users.
    const salt = randomBytes(this.saltLength);
    const key = await derive(plain, salt, this.keyLength, {
      N: this.cost,
      r: this.blockSize,
      p: this.parallelization,
      maxmem: memoryBudget(this.cost, this.blockSize),
    });

    return [
      SCHEME,
      this.cost,
      this.blockSize,
      this.parallelization,
      salt.toString("base64"),
      key.toString("base64"),
    ].join("$");
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    const parsed = parse(hash);
    if (!parsed) return false;

    try {
      const derived = await derive(plain, parsed.salt, parsed.key.length, {
        N: parsed.cost,
        r: parsed.blockSize,
        p: parsed.parallelization,
        maxmem: memoryBudget(parsed.cost, parsed.blockSize),
      });

      // Constant time on purpose. A plain `===` bails out at the first byte
      // that differs, and the time it took to bail is a measurement of how much
      // of the hash was guessed right — enough, over many attempts, to
      // reconstruct it byte by byte.
      return timingSafeEqual(derived, parsed.key);
    } catch {
      // Any failure here — parameters the platform rejects, a key length of
      // zero — means this password does not check out against this hash. The
      // contract says so: `false`, never a throw.
      return false;
    }
  }
}

interface ParsedHash {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  key: Buffer;
}

/**
 * Reads a stored hash back. `null` for anything that is not one of ours, which
 * covers the two cases that matter: a column holding a hash from a different
 * algorithm, and a column holding garbage.
 */
function parse(hash: string): ParsedHash | null {
  const parts = hash.split("$");
  if (parts.length !== 6 || parts[0] !== SCHEME) return null;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (![cost, blockSize, parallelization].every((n) => Number.isInteger(n) && n > 0)) return null;

  // `Buffer.from(..., "base64")` never throws — it drops what it cannot read —
  // so an empty result is the only signal that the field was not base64 at all.
  const salt = Buffer.from(parts[4], "base64");
  const key = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || key.length === 0) return null;

  return { cost, blockSize, parallelization, salt, key };
}
