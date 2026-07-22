// User + invite store (server-only, Phase 4). Multi-user accounts on top of the
// single-presenter era. Imports ensureSchema (so tables exist) + the pure
// password module; the boot-time admin seeder lives in lib/schema.ts (using
// lib/password directly) to avoid a cycle with this route-facing module.

import { randomBytes } from "crypto";
import { getPool, hasDb, query } from "./db";
import { ensureSchema } from "./schema";
import { verifyPassword } from "./password";
import { getRedis, hasRedis } from "./redis";

export type Role = "admin" | "presenter";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
}

/** A urlsafe random id/token. */
export function randomId(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}

// ---- users ------------------------------------------------------------------

export function canonicalAccountIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function rowToUser(r: {
  id: string;
  email: string;
  password_hash: string;
  role: string;
}): User {
  return { id: r.id, email: r.email, passwordHash: r.password_hash, role: r.role as Role };
}

/** Look up a user by email (case-insensitive). null when absent / no DB. */
export async function getUserByEmail(email: string): Promise<User | null> {
  await ensureSchema();
  try {
    const res = await query<{ id: string; email: string; password_hash: string; role: string }>(
      `SELECT id, email, password_hash, role FROM users WHERE lower(email) = lower($1)`,
      [canonicalAccountIdentifier(email)],
    );
    return res.rows[0] ? rowToUser(res.rows[0]) : null;
  } catch (err) {
    if (hasDb()) throw err;
    return null;
  }
}

/** Look up a user by id. null when absent / no DB. */
export async function getUserById(id: string): Promise<User | null> {
  await ensureSchema();
  try {
    const res = await query<{ id: string; email: string; password_hash: string; role: string }>(
      `SELECT id, email, password_hash, role FROM users WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? rowToUser(res.rows[0]) : null;
  } catch {
    return null;
  }
}

// ---- login rate limit (dedicated + stricter than the AI limiter) ------------
// Keyed by the attempted username so guessing ONE account is capped, regardless
// of the shared AI limit. Redis when available, per-instance memory otherwise.
// Checked BEFORE scrypt so the hash cost can't be used as a DoS on this unauth
// endpoint.
const LOGIN_MAX = 8;
const LOGIN_WINDOW = 300; // 5 min
const loginBuckets = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_BUCKETS = 5_000;
const LOGIN_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return count
`;

export async function checkLoginRateLimit(key: string): Promise<boolean> {
  const redis = await getRedis();
  if (redis) {
    try {
      const k = `login:${canonicalAccountIdentifier(key).slice(0, 320)}`;
      const n = Number(await redis.eval(LOGIN_LIMIT_SCRIPT, [k], [LOGIN_WINDOW]));
      return n <= LOGIN_MAX;
    } catch {
      if (process.env.NODE_ENV === "production") return false;
    }
  } else if (hasRedis() && process.env.NODE_ENV === "production") {
    return false;
  }
  const now = Date.now();
  for (const [bucketKey, bucket] of loginBuckets) {
    if (bucket.resetAt <= now) loginBuckets.delete(bucketKey);
  }
  while (loginBuckets.size >= MAX_LOGIN_BUCKETS) {
    const oldest = loginBuckets.keys().next().value as string | undefined;
    if (!oldest) break;
    loginBuckets.delete(oldest);
  }
  const normalizedKey = canonicalAccountIdentifier(key).slice(0, 320);
  const b = loginBuckets.get(normalizedKey);
  if (!b || now >= b.resetAt) {
    loginBuckets.set(normalizedKey, { count: 1, resetAt: now + LOGIN_WINDOW * 1000 });
    return true;
  }
  b.count += 1;
  return b.count <= LOGIN_MAX;
}

// Re-export so callers verify a password in one place.
export { verifyPassword };

// ---- invites ----------------------------------------------------------------

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Invite {
  token: string;
  email: string | null;
  role: Role;
  usedBy: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Admin mints an invite. Returns the token (the caller builds the signup URL). */
export async function createInvite(
  role: Role,
  email: string | null,
  createdBy: string | null,
): Promise<{ ok: boolean; token?: string; error?: string }> {
  await ensureSchema();
  const token = randomId(24);
  const expires = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  try {
    await query(
      `INSERT INTO invites (token, email, role, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [token, email ? canonicalAccountIdentifier(email) : null, role, createdBy, expires],
    );
    return { ok: true, token };
  } catch (err) {
    console.error("[users] createInvite failed:", err);
    return { ok: false, error: "database_unavailable" };
  }
}

/** List invites (admin view), newest first. */
export async function listInvites(): Promise<Invite[]> {
  await ensureSchema();
  try {
    const res = await query<{
      token: string;
      email: string | null;
      role: string;
      used_by: string | null;
      created_at: string;
      expires_at: string;
    }>(
      `SELECT token, email, role, used_by, created_at, expires_at
         FROM invites ORDER BY created_at DESC LIMIT 200`,
    );
    return res.rows.map((r) => ({
      token: r.token,
      email: r.email,
      role: r.role as Role,
      usedBy: r.used_by,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  } catch {
    return [];
  }
}

/** Revoke (delete) an UNUSED invite. A used invite is left as an audit record. */
export async function revokeInvite(token: string): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema();
  try {
    const res = await query(`DELETE FROM invites WHERE token = $1 AND used_by IS NULL`, [token]);
    return (res.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, error: "not_found" };
  } catch {
    return { ok: false, error: "database_unavailable" };
  }
}

/**
 * Sign up with an invite — the atomic single-use path. In ONE transaction on a
 * pinned client: lock the invite row (FOR UPDATE), validate it (exists, unused,
 * not expired, email matches if pinned), INSERT the user with the invite's role
 * (NEVER a client-supplied role), then mark the invite used. Any failure rolls
 * back the whole thing, so a token can't be redeemed twice and a failed signup
 * never leaves a half-created user. The password is hashed by the CALLER before
 * this runs so scrypt doesn't hold the transaction open.
 */
export async function signupWithInvite(params: {
  token: string;
  email: string;
  passwordHash: string;
}): Promise<{ ok: true; userId: string; role: Role } | { ok: false; error: string }> {
  await ensureSchema();
  const email = canonicalAccountIdentifier(params.email);
  const pool = await getPool();
  if (!pool) return { ok: false, error: "database_unavailable" };

  let client;
  try {
    client = await pool.connect();
  } catch {
    return { ok: false, error: "database_unavailable" };
  }
  try {
    await client.query("BEGIN");
    const inv = await client.query<{ email: string | null; role: string; used_by: string | null; expired: boolean }>(
      `SELECT email, role, used_by, (expires_at <= now()) AS expired
         FROM invites WHERE token = $1 FOR UPDATE`,
      [params.token],
    );
    const row = inv.rows[0];
    if (!row || row.used_by || row.expired) {
      await client.query("ROLLBACK");
      return { ok: false, error: "invalid_invite" };
    }
    if (row.email && canonicalAccountIdentifier(row.email) !== email) {
      await client.query("ROLLBACK");
      return { ok: false, error: "email_mismatch" };
    }
    const role = row.role as Role; // role comes from the invite row, not the request
    const userId = randomId();
    try {
      await client.query(
        `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)`,
        [userId, email, params.passwordHash, role],
      );
    } catch (err) {
      await client.query("ROLLBACK");
      // 23505 = unique_violation on email
      if ((err as { code?: string })?.code === "23505") {
        return { ok: false, error: "email_taken" };
      }
      throw err;
    }
    await client.query(`UPDATE invites SET used_by = $1 WHERE token = $2`, [userId, params.token]);
    await client.query("COMMIT");
    return { ok: true, userId, role };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[users] signupWithInvite failed:", err);
    return { ok: false, error: "database_unavailable" };
  } finally {
    client.release();
  }
}
