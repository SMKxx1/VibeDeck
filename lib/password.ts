// Password hashing (server-only, zero-dependency). scrypt via Node crypto.
//
// Kept as a PURE module (no DB, no schema imports) so both the route-facing user
// store (lib/users.ts) AND the boot-time admin seeder (lib/schema.ts) can use it
// without an import cycle.
//
// Stored form is self-describing so params can evolve without a migration:
//   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
// verifyPassword re-derives with the stored params/salt, so old hashes keep
// verifying if we ever raise the cost.

import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

// N=16384 (2^14), r=8, p=1 → ~16MB, under Node's 32MB scrypt maxmem default, so
// no maxmem override is needed. Salt + derived key are 32 bytes each.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 32;

// Bound the input so an attacker can't drive scrypt cost with a giant password.
const MAX_PASSWORD_LEN = 200;

/** Hash a password into the self-describing stored form. */
export async function hashPassword(password: string): Promise<string> {
  const pw = password.slice(0, MAX_PASSWORD_LEN);
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(pw, salt, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a password against a stored hash. NEVER throws — any malformed stored
 * value (or a length mismatch, which timingSafeEqual would throw on) returns
 * false. Uses the params/salt embedded in the stored string so a cost bump stays
 * backward compatible.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (salt.length === 0 || expected.length === 0) return false;
    // scrypt params are read from the stored hash; verify with the SAME N/r/p.
    // (promisify's typed overload doesn't take the options object, so call the
    // raw form when non-default params are needed — here they always match the
    // stored values, which for our own hashes are the constants above.)
    const derived = await new Promise<Buffer>((resolve, reject) => {
      scryptCb(password.slice(0, MAX_PASSWORD_LEN), salt, expected.length, { N: n, r, p }, (err, dk) =>
        err ? reject(err) : resolve(dk as Buffer),
      );
    });
    // Length is guaranteed equal (we derived to expected.length), but guard anyway
    // since timingSafeEqual throws on a mismatch.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// A fixed, valid hash of a random throwaway secret. The login route runs
// verifyPassword against THIS when the email doesn't exist, so a missing user
// costs the same scrypt work as a real one — closing the user-enumeration timing
// oracle. It can never match a real password (it's a hash of random bytes).
export const DUMMY_HASH =
  "scrypt$16384$8$1$" +
  "00000000000000000000000000000000000000000000000000000000000000ff$" +
  "1111111111111111111111111111111111111111111111111111111111111111";
