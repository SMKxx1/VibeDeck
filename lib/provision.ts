// Account provisioning (server-only). approveRequest is THE ONE place an
// account_requests row becomes a real account — everything else (the Telegram
// webhook, the admin view) funnels here, so the invariants live in exactly one
// transaction:
//
//   SELECT ... FOR UPDATE the request  → concurrent approvals serialize;
//   already decided → {ok:false, already:true}  → approving twice = one account;
//   reuse the users row if the email already has one, else INSERT a fresh
//   presenter whose password_hash is scrypt(random-throwaway) — a valid hash
//   that no typed password can ever match, so a Google-provisioned account has
//   NO working password path (mirrors lib/password DUMMY_HASH's trick, but
//   per-user salted);
//   link the external identity  → the next Google sign-in resolves directly;
//   flip the request to 'approved'  — all in one COMMIT, so a crash mid-way
//   leaves the request pending and safely re-approvable.
//
// Same transaction discipline as lib/users signupWithInvite: pinned client,
// BEGIN/COMMIT/ROLLBACK, scrypt paid BEFORE the transaction opens so the hash
// cost never holds row locks. Writes surface errors; nothing here fails open.

import { getPool } from "./db";
import { ensureSchema } from "./schema";
import { hashPassword } from "./password";
import { linkIdentityOn } from "./identities";
import { setDecision } from "./account-requests";
import { randomId, type Role } from "./users";

export type ApproveResult =
  | { ok: true; userId: string; role: Role }
  | { ok: false; already?: boolean; error?: string };

/** Approve a pending request and provision (or reuse) its account. Idempotent. */
export async function approveRequest(
  requestId: string,
  decidedBy: string | null,
): Promise<ApproveResult> {
  await ensureSchema();
  const pool = await getPool();
  if (!pool) return { ok: false, error: "database_unavailable" };

  // Paid up front (outside the transaction) — see module comment. Hashing a
  // fresh randomId() makes the password path unusable: verifyPassword can only
  // succeed for the throwaway string, which is never stored or shown to anyone.
  const unusableHash = await hashPassword(randomId(24));

  let client;
  try {
    client = await pool.connect();
  } catch {
    return { ok: false, error: "database_unavailable" };
  }
  try {
    await client.query("BEGIN");
    const req = await client.query<{
      provider: string;
      provider_id: string;
      email: string;
      status: string;
    }>(
      `SELECT provider, provider_id, email, status
         FROM account_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    const row = req.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, error: "not_found" };
    }
    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false, already: true };
    }

    // Reuse an existing account for this email (e.g. an invited presenter who
    // now signs in with Google) — approval then just LINKS, never duplicates.
    const existing = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM users WHERE lower(email) = lower($1)`,
      [row.email],
    );
    let userId: string;
    let role: Role;
    if (existing.rows[0]) {
      userId = existing.rows[0].id;
      role = existing.rows[0].role as Role;
    } else {
      userId = randomId();
      role = "presenter"; // provisioned accounts are never admins
      await client.query(
        `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'presenter')`,
        [userId, row.email, unusableHash],
      );
    }

    await linkIdentityOn(client, row.provider, row.provider_id, userId, row.email);

    // Same atomic pending-only transition as setDecision, but INSIDE this
    // transaction (setDecision runs on the pool, which would escape it). The
    // FOR UPDATE lock above guarantees the row is still pending here.
    await client.query(
      `UPDATE account_requests
          SET status = 'approved', decided_at = now(), decided_by = $2
        WHERE id = $1 AND status = 'pending'`,
      [requestId, decidedBy],
    );

    await client.query("COMMIT");
    return { ok: true, userId, role };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[provision] approveRequest failed:", err);
    return { ok: false, error: "database_unavailable" };
  } finally {
    client.release();
  }
}

/**
 * Reject a pending request. Same idempotency contract as approveRequest:
 * only a still-'pending' row transitions; a second tap reports already:true.
 * No transaction needed — a rejection is a single guarded UPDATE.
 */
export async function rejectRequest(
  requestId: string,
  decidedBy: string | null,
): Promise<{ ok: boolean; already?: boolean }> {
  const changed = await setDecision(requestId, "rejected", decidedBy);
  return changed ? { ok: true } : { ok: false, already: true };
}
