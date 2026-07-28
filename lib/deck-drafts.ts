// DRAFTS (VDML Workbench, migration 008) — server-only.
// The in-app editor's working copy lives in decks.draft_html, DISTINCT from the
// published `html` that /d-content serves live. Saving a draft never touches the
// live bytes; Publish validates and atomically swaps draft→html. Same conventions
// as lib/uploaded-decks.ts, whose published-deck half this is the mirror of: reads
// fail CLOSED (null on any DB error — a draft is still untrusted stored content),
// writes THROW so the route can surface a 503.
//
// Imports lib/db + lib/schema (ensureSchema) + the pure deck-validator + the
// slides-store, exactly like uploaded-decks — deliberately NOT lib/decks and NOT
// uploaded-decks itself, so the graph stays acyclic.

import { getPool, query } from "./db";
import { ensureSchema } from "./schema";
import { validateDeckHtml } from "./deck-validator";
import { replaceUploadedDeckSlidesOnClient } from "./slides-store";

/**
 * The in-progress draft HTML for an uploaded deck, or null when there is no draft
 * / the slug is missing or a registry deck / the DB errored (fail closed, all
 * indistinguishable). A caller falls back to the published html for "no draft".
 */
export async function getDraftHtml(slug: string): Promise<string | null> {
  await ensureSchema();
  try {
    const res = await query<{ draft_html: string | null }>(
      `SELECT draft_html FROM decks WHERE slug = $1 AND kind = 'uploaded'`,
      [slug],
    );
    return res.rows[0]?.draft_html ?? null;
  } catch {
    return null;
  }
}

/**
 * The bytes the DRAFT-PREVIEW serve path renders: the working draft when one
 * exists, else the published html (previewing with no draft just shows the live
 * deck). The ONLY other place that SELECTs deck html besides getUploadedDeckHtml,
 * for the same reason: only /d-content needs the bytes. `kind = 'uploaded'` in
 * the WHERE + fail-CLOSED null on any DB error, exactly like getUploadedDeckHtml
 * — this feeds untrusted-content serving, so it must never leak or 500.
 */
export async function getDraftServeHtml(slug: string): Promise<{ html: string } | null> {
  await ensureSchema();
  try {
    const res = await query<{ html: string }>(
      `SELECT COALESCE(draft_html, html) AS html FROM decks WHERE slug = $1 AND kind = 'uploaded'`,
      [slug],
    );
    const r = res.rows[0];
    return r ? { html: r.html } : null;
  } catch {
    return null; // fail closed — never serve, never leak, on a DB error
  }
}

/**
 * Save the working draft. DELIBERATELY UNVALIDATED — a draft may be mid-edit and
 * broken; validateDeckHtml gates only the publish swap. Does NOT touch
 * updated_at (that timestamp orders PUBLISHED content; a private draft keystroke
 * must not reshuffle the library). `AND kind = 'uploaded'` → a registry/missing
 * slug is "not_found", indistinguishable. Throws on DB error (caller → 503).
 */
export async function saveDraftHtml(slug: string, html: string): Promise<"ok" | "not_found"> {
  await ensureSchema();
  const res = await query(
    `UPDATE decks SET draft_html = $2 WHERE slug = $1 AND kind = 'uploaded'`,
    [slug, html],
  );
  return (res.rowCount ?? 0) === 0 ? "not_found" : "ok";
}

/** Discard the working draft (draft_html → NULL); the published html is untouched.
 *  Throws on DB error (caller → 503). */
export async function discardDraft(slug: string): Promise<"ok" | "not_found"> {
  await ensureSchema();
  const res = await query(
    `UPDATE decks SET draft_html = NULL WHERE slug = $1 AND kind = 'uploaded'`,
    [slug],
  );
  return (res.rowCount ?? 0) === 0 ? "not_found" : "ok";
}

// publishDraft outcomes. "invalid" carries the validator's issues verbatim so the
// route can return a 422 the editor renders inline (same shape as the upload route).
export type PublishDraftResult =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: "not_found" | "no_draft" }
  | { ok: false; reason: "invalid"; issues: string[]; warnings: string[] };

/**
 * Validate the draft and atomically promote it to the live bytes. Runs on ONE
 * client inside a transaction with the row locked (FOR UPDATE), so the html that
 * goes live is EXACTLY the html that passed validateDeckHtml — a concurrent
 * saveDraftHtml blocks until the swap commits rather than slipping unvalidated
 * bytes into `html`. On success the draft is cleared and the validated
 * slide_count + deck_slides rows commit in the SAME transaction as the live HTML.
 * Deliberately does NOT touch publish_status — publishing bytes must never
 * silently re-expose or hide a deck (same rule as replaceUploadedDeckHtml).
 * Throws on DB error (caller → 503).
 */
export async function publishDraft(slug: string): Promise<PublishDraftResult> {
  await ensureSchema();
  const pool = await getPool();
  if (!pool) throw new Error("publishDraft: no database configured");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ draft_html: string | null }>(
      `SELECT draft_html FROM decks WHERE slug = $1 AND kind = 'uploaded' FOR UPDATE`,
      [slug],
    );
    const row = res.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (row.draft_html === null) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "no_draft" };
    }

    // Same conformance gate as upload/replace: only a valid VibeDeck bundle may
    // become the live bytes. Never throws (a parse failure is an issue).
    const validation = validateDeckHtml(row.draft_html);
    if (!validation.ok) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "invalid", issues: validation.issues, warnings: validation.warnings };
    }

    await client.query(
      `UPDATE decks
          SET html = draft_html,
              draft_html = NULL,
              slide_count = $2,
              updated_at = now()
       WHERE slug = $1 AND kind = 'uploaded'`,
      [slug, validation.slideCount],
    );
    await replaceUploadedDeckSlidesOnClient(
      client,
      slug,
      validation.slides,
      validation.slideCount,
    );
    await client.query("COMMIT");
    return { ok: true, warnings: validation.warnings };
  } catch (err) {
    // Surface the write failure (route → 503) — but never leave the transaction
    // open on the pooled client.
    try {
      await client.query("ROLLBACK");
    } catch {
      // the connection is gone; release below returns it for destruction
    }
    throw err;
  } finally {
    client.release();
  }
}
