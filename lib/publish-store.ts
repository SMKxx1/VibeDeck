// Publish-status store (server-only): the three-state publish model per deck —
// 'main' (the single deck shown at "/"), 'normal' (public at /d/<slug>), and
// 'unpublished' (presenter/admin-only; a non-presenter hitting /d/<slug> gets a
// 404, not a login redirect, to avoid slug enumeration).
//
// Mirrors lib/slides-store.ts's conventions: every read returns a safe fallback
// and NEVER throws when DATABASE_URL is unset or the DB is unreachable. The
// column + uniqueness index live in migration 002; the initial main deck is
// chosen by ensureMainSet() in the boot sequence (lib/slides-store.ts).

import { getPool, isDbReachable, query } from "./db";
import { ensureSchema } from "./slides-store";

export type PublishStatus = "main" | "normal" | "unpublished";

/**
 * The slug of the current main deck, or null when none is set OR the DB is
 * unreachable. The caller (app/page.tsx) decides the fallback — it can't be
 * decided here, since "no main" and "DB down" both legitimately want the same
 * env-based fallback deck.
 */
export async function getMainDeckSlug(): Promise<string | null> {
  await ensureSchema();
  try {
    const res = await query<{ slug: string }>(
      `SELECT slug FROM decks WHERE publish_status = 'main' LIMIT 1`,
    );
    return res.rows[0]?.slug ?? null;
  } catch {
    return null; // no DB / query error — caller falls back to the env live slug
  }
}

/** slug → publish_status for every deck row, for the dashboard. `{}` when no DB. */
export async function getPublishStatusMap(): Promise<Record<string, PublishStatus>> {
  await ensureSchema();
  try {
    const res = await query<{ slug: string; publish_status: PublishStatus }>(
      `SELECT slug, publish_status FROM decks`,
    );
    const map: Record<string, PublishStatus> = {};
    for (const r of res.rows) map[r.slug] = r.publish_status;
    return map;
  } catch {
    return {};
  }
}

/**
 * Whether a NON-presenter may view this deck. Presenters can always view.
 *
 * FAIL-OPEN on purpose. For a non-presenter: only publish_status='unpublished'
 * hides the deck (→ false). EVERYTHING ELSE returns true — including "the deck
 * has no DB row at all" and "the DB is unreachable". This deliberately matches
 * the app's whole graceful-degradation philosophy (lib/db.ts isDbReachable,
 * lib/slides-store.ts's static fallbacks): a transient DB hiccup mid-class must
 * degrade to the OLD pre-feature behavior (no gate, every deck viewable) rather
 * than hiding every deck and taking the live site down. The only thing this gate
 * protects is content a presenter EXPLICITLY marked unpublished, and that record
 * only exists in a reachable DB — so if the DB is down there is nothing to hide.
 */
export async function isDeckViewable(slug: string, isPresenter: boolean): Promise<boolean> {
  if (isPresenter) return true;
  await ensureSchema();
  try {
    const res = await query<{ publish_status: PublishStatus }>(
      `SELECT publish_status FROM decks WHERE slug = $1`,
      [slug],
    );
    // No row → not tracked → treat as viewable (pre-feature behavior). Only an
    // explicit 'unpublished' hides it.
    if (res.rows.length === 0) return true;
    return res.rows[0].publish_status !== "unpublished";
  } catch {
    return true; // DB down — fail open (see the doc comment above)
  }
}

/**
 * Set a deck's publish status. Returns the fresh full status map on success so
 * the dashboard can re-render without a second round-trip.
 *
 * The 'main' case is the interesting one: at most one deck may be main (enforced
 * by the `one_main` partial unique index from migration 002). We DEMOTE the
 * current main and PROMOTE this slug inside ONE transaction on ONE pinned client
 * so the pair is atomic. If two presenters race to promote different decks, one
 * transaction wins and the other trips the unique index (Postgres 23505) on
 * COMMIT — we ROLLBACK and return the CURRENT reality instead of a 500, because
 * the loser should simply see the winner's choice, not an error.
 *
 * For 'normal'/'unpublished' there's no main invariant to maintain, so a single
 * UPDATE of that one row suffices (no demotion, no transaction).
 */
export async function setPublishStatus(
  slug: string,
  status: PublishStatus,
): Promise<{ ok: boolean; error?: string; statusMap?: Record<string, PublishStatus> }> {
  await ensureSchema();
  if (!(await isDbReachable())) return { ok: false, error: "database_unavailable" };

  const pool = await getPool();
  if (!pool) return { ok: false, error: "database_unavailable" };

  if (status !== "main") {
    // Simple path: no main invariant to protect — update the one row.
    try {
      await pool.query(`UPDATE decks SET publish_status = $2 WHERE slug = $1`, [slug, status]);
      return { ok: true, statusMap: await getPublishStatusMap() };
    } catch (err) {
      console.error("[publish-store] setPublishStatus failed:", err);
      return { ok: false, error: "database_unavailable" };
    }
  }

  // Promote-to-main: demote the incumbent + promote this slug atomically on one
  // pinned client (a transaction spans multiple statements on a single connection).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE decks SET publish_status = 'normal' WHERE publish_status = 'main' AND slug <> $1`,
      [slug],
    );
    await client.query(`UPDATE decks SET publish_status = 'main' WHERE slug = $1`, [slug]);
    await client.query("COMMIT");
    return { ok: true, statusMap: await getPublishStatusMap() };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback error — the connection is being released regardless */
    }
    // 23505 = unique_violation on the `one_main` index: a genuine concurrent-
    // promote race we lost. That's not a server error — return current reality.
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      return { ok: true, statusMap: await getPublishStatusMap() };
    }
    console.error("[publish-store] setPublishStatus (main) failed:", err);
    return { ok: false, error: "database_unavailable" };
  } finally {
    client.release();
  }
}
