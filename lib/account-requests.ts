// Account-request store (server-only). A Google sign-in from an identity we
// don't know parks here as a 'pending' row (migration 011_account_requests)
// until the owner approves or rejects it — via the Telegram inline buttons
// (lib/telegram.ts) or the admin view. This module is pure request-row CRUD;
// the ONE place a request becomes an account is lib/provision.ts.
//
// House degrade rules: reads fail-open (null / []), writes surface errors.
// Server-only — never import from a "use client" component.

import { query } from "./db";
import { ensureSchema } from "./schema";
import { randomId } from "./users";

export type RequestStatus = "pending" | "approved" | "rejected";

export interface AccountRequest {
  id: string;
  provider: string;
  providerId: string;
  email: string;
  name: string | null;
  status: RequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  notifyChatId: string | null;
  notifyMessageId: string | null;
}

interface RequestRow {
  id: string;
  provider: string;
  provider_id: string;
  email: string;
  name: string | null;
  status: string;
  requested_at: string | Date;
  decided_at: string | Date | null;
  decided_by: string | null;
  notify_chat_id: string | null;
  notify_message_id: string | null;
}

const ROW_COLS = `id, provider, provider_id, email, name, status,
  requested_at, decided_at, decided_by, notify_chat_id, notify_message_id`;

function rowToRequest(r: RequestRow): AccountRequest {
  return {
    id: r.id,
    provider: r.provider,
    providerId: r.provider_id,
    email: r.email,
    name: r.name,
    status: r.status as RequestStatus,
    requestedAt: new Date(r.requested_at).toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    decidedBy: r.decided_by,
    notifyChatId: r.notify_chat_id,
    notifyMessageId: r.notify_message_id,
  };
}

/** Look up a request by id. null when absent / no DB. */
export async function getRequest(id: string): Promise<AccountRequest | null> {
  await ensureSchema();
  try {
    const res = await query<RequestRow>(
      `SELECT ${ROW_COLS} FROM account_requests WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? rowToRequest(res.rows[0]) : null;
  } catch {
    return null;
  }
}

/** The still-open request for an external identity, if any. null otherwise / no DB. */
export async function getPendingByProvider(
  provider: string,
  providerId: string,
): Promise<AccountRequest | null> {
  await ensureSchema();
  try {
    const res = await query<RequestRow>(
      `SELECT ${ROW_COLS} FROM account_requests
        WHERE provider = $1 AND provider_id = $2 AND status = 'pending'`,
      [provider, providerId],
    );
    return res.rows[0] ? rowToRequest(res.rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Create (or return the existing) pending request for an external identity.
 * Deduplication is enforced by the DB, not a check-then-act: the INSERT
 * arbitrates on migration 011's partial unique index (provider, provider_id)
 * WHERE status='pending' with ON CONFLICT DO NOTHING, so two racing sign-ins
 * collapse onto one row — the loser simply re-reads the winner's row. This is a
 * WRITE, so failures surface as {ok:false} (a requester must see "try later",
 * not a silent void).
 */
export async function createRequest(params: {
  provider: string;
  providerId: string;
  email: string;
  name?: string | null;
}): Promise<{ ok: true; request: AccountRequest } | { ok: false; error: string }> {
  await ensureSchema();
  const id = randomId();
  try {
    const inserted = await query<RequestRow>(
      `INSERT INTO account_requests (id, provider, provider_id, email, name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, provider_id) WHERE status = 'pending' DO NOTHING
       RETURNING ${ROW_COLS}`,
      [id, params.provider, params.providerId, params.email, params.name ?? null],
    );
    if (inserted.rows[0]) return { ok: true, request: rowToRequest(inserted.rows[0]) };
    // Conflict: a pending request already exists — return that one.
    const existing = await query<RequestRow>(
      `SELECT ${ROW_COLS} FROM account_requests
        WHERE provider = $1 AND provider_id = $2 AND status = 'pending'`,
      [params.provider, params.providerId],
    );
    if (existing.rows[0]) return { ok: true, request: rowToRequest(existing.rows[0]) };
    // Vanishingly rare: the winner was decided between our INSERT and re-read.
    return { ok: false, error: "conflict" };
  } catch (err) {
    console.error("[account-requests] createRequest failed:", err);
    return { ok: false, error: "database_unavailable" };
  }
}

/**
 * Record a decision — the idempotency guard for the whole approval flow. ONLY
 * transitions a still-'pending' row (the WHERE clause is the atomic
 * check-and-set); returns false when the row was already decided, is absent, or
 * the DB is down, so a double-tapped Telegram button can never re-decide.
 * NOTE: lib/provision.ts approveRequest does this same transition INLINE inside
 * its transaction — this pool-path helper serves rejections and other
 * non-provisioning decisions.
 */
export async function setDecision(
  id: string,
  status: "approved" | "rejected",
  decidedBy: string | null,
): Promise<boolean> {
  await ensureSchema();
  try {
    const res = await query(
      `UPDATE account_requests
          SET status = $2, decided_at = now(), decided_by = $3
        WHERE id = $1 AND status = 'pending'`,
      [id, status, decidedBy],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    console.error("[account-requests] setDecision failed:", err);
    return false;
  }
}

/**
 * Remember where the Telegram ping landed (chat + message id) so the approval
 * webhook can later edit that exact message to ✅/❌. Best-effort refs on a
 * best-effort channel: failure is logged but not surfaced — the request itself
 * is already safely persisted.
 */
export async function setNotifyRefs(
  id: string,
  chatId: string,
  messageId: string,
): Promise<void> {
  await ensureSchema();
  try {
    await query(
      `UPDATE account_requests SET notify_chat_id = $2, notify_message_id = $3 WHERE id = $1`,
      [id, chatId, messageId],
    );
  } catch (err) {
    console.error("[account-requests] setNotifyRefs failed:", err);
  }
}

/** Pending requests, oldest first (admin view). [] on any failure. */
export async function listPending(): Promise<AccountRequest[]> {
  await ensureSchema();
  try {
    const res = await query<RequestRow>(
      `SELECT ${ROW_COLS} FROM account_requests
        WHERE status = 'pending' ORDER BY requested_at LIMIT 200`,
    );
    return res.rows.map(rowToRequest);
  } catch {
    return [];
  }
}
