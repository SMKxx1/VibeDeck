// External identity links (server-only). Maps a third-party identity —
// provider='google', provider_id = Google's stable `sub` claim — onto a users
// row (see migration 010_user_identities). Lookups go by (provider, provider_id)
// ONLY, never by email: an email can be reassigned at the provider; `sub` cannot.
//
// House degrade rules: reads fail-open (null / []) so a DB blip never breaks a
// render; writes surface errors ({ok:false}) so a failed link is never silently
// swallowed. This module is server-only — never import it from a "use client"
// component.

import type { PoolClient } from "pg";
import { query } from "./db";
import { ensureSchema } from "./schema";

export interface Identity {
  provider: string;
  providerId: string;
  userId: string;
  email: string | null;
  createdAt: string;
}

// ON CONFLICT DO NOTHING with NO target on purpose: it arbitrates on BOTH
// uniques from migration 010 — the (provider, provider_id) PK (identity already
// claimed → keep the existing link) AND the (user_id, provider) index (user
// already has an identity for this provider → keep the existing one). Either
// way a re-link is an idempotent no-op, which is exactly what an idempotent
// approval flow needs (approving twice must not throw).
const LINK_SQL = `
  INSERT INTO user_identities (provider, provider_id, user_id, email)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT DO NOTHING
`;

/** The user an external identity resolves to, or null (absent / no DB). */
export async function getIdentity(
  provider: string,
  providerId: string,
): Promise<{ userId: string } | null> {
  await ensureSchema();
  try {
    const res = await query<{ user_id: string }>(
      `SELECT user_id FROM user_identities WHERE provider = $1 AND provider_id = $2`,
      [provider, providerId],
    );
    return res.rows[0] ? { userId: res.rows[0].user_id } : null;
  } catch {
    return null;
  }
}

/**
 * Link an external identity to a user (idempotent — see LINK_SQL). Pool path;
 * inside a transaction use linkIdentityOn with the pinned client instead.
 */
export async function linkIdentity(
  provider: string,
  providerId: string,
  userId: string,
  email: string | null,
): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema();
  try {
    await query(LINK_SQL, [provider, providerId, userId, email]);
    return { ok: true };
  } catch (err) {
    console.error("[identities] linkIdentity failed:", err);
    return { ok: false, error: "database_unavailable" };
  }
}

/**
 * Transaction variant: the SAME idempotent INSERT, run on the caller's pinned
 * client so it joins the caller's transaction (lib/provision.ts approveRequest).
 * THROWS on failure — inside a transaction the caller's catch must roll the
 * whole thing back, so this one deliberately does NOT absorb errors.
 */
export async function linkIdentityOn(
  client: PoolClient,
  provider: string,
  providerId: string,
  userId: string,
  email: string | null,
): Promise<void> {
  await client.query(LINK_SQL, [provider, providerId, userId, email]);
}

/** All external identities linked to a user (account settings). [] on any failure. */
export async function listIdentitiesForUser(userId: string): Promise<Identity[]> {
  await ensureSchema();
  try {
    const res = await query<{
      provider: string;
      provider_id: string;
      user_id: string;
      email: string | null;
      created_at: string | Date;
    }>(
      `SELECT provider, provider_id, user_id, email, created_at
         FROM user_identities WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return res.rows.map((r) => ({
      provider: r.provider,
      providerId: r.provider_id,
      userId: r.user_id,
      email: r.email,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  } catch {
    return [];
  }
}
