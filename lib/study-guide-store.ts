// Published AI study-guide handouts (server-only): presenter-CURATED Markdown
// study guides, frozen into Postgres (table `deck_recaps`, migration 007) and
// shared via an unguessable token that IS the capability — the public
// /study/<token> page (and its offline .html download) resolves it here.
//
// PRIVACY (slide-system-rules.md §§0.5, 9): everything persisted here was
// reviewed and edited by the PRESENTER before publishing — the AI draft is never
// auto-saved (the /api/study-guide draft action returns markdown and writes
// nothing). So the strict AI rule (persist only {name,timestamp,token_count})
// holds trivially: no viewer name/question/prompt/answer can reach this table
// unless the presenter deliberately typed it into their own handout.
//
// Mirrors lib/session-reports.ts conventions: reads fail OPEN to a safe fallback
// (null / []) and NEVER throw; writes surface errors so the API can 503.

import { randomBytes } from "crypto";
import { isDbReachable, query } from "./db";
import { ensureSchema } from "./schema";

// Caps enforced on the way IN (createRecap) and re-applied on the way OUT so a
// hand-edited row can never balloon a response. The markdown cap comfortably
// fits a long handout while keeping a row far below any Postgres/page limit.
export const MAX_GUIDE_TITLE = 160;
export const MAX_GUIDE_MARKDOWN = 60_000;

export interface StudyGuide {
  token: string;
  deckSlug: string;
  /** Presenter-chosen handout title; "" when they left it blank (render a generic heading). */
  title: string;
  markdown: string;
  /** Epoch ms the guide was published (row default now()). */
  createdAt: number;
}

/** The list shape for the edit-page panel — everything except the (large) markdown body. */
export interface StudyGuideSummary {
  token: string;
  title: string;
  createdAt: number;
}

// The share token: same construction as lib/poll.ts newId but LONGER (24 random
// bytes → 32 base64url chars, 192 bits) because this one is a durable public
// capability, not a session-scoped id — it must stay unguessable forever.
function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function cleanTitle(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim().slice(0, MAX_GUIDE_TITLE);
}

/**
 * Persist one presenter-curated guide and mint its share token. A WRITE, so it
 * surfaces failure for the API to 503 — silently dropping a handout the
 * presenter just reviewed would lose their curation work.
 */
export async function createRecap(input: {
  deckSlug: string;
  title: string;
  markdown: string;
  /** The publishing user's id, or null for a legacy-admin session (users row absent). */
  createdBy: string | null;
}): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const markdown = (input.markdown ?? "").trim();
  if (!markdown) return { ok: false, error: "empty_markdown" };
  if (markdown.length > MAX_GUIDE_MARKDOWN) return { ok: false, error: "too_long" };
  await ensureSchema();
  if (!(await isDbReachable())) return { ok: false, error: "database_unavailable" };
  const token = newToken();
  try {
    await query(
      `INSERT INTO deck_recaps (token, deck_slug, title, markdown, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [token, input.deckSlug, cleanTitle(input.title) || null, markdown, input.createdBy],
    );
    return { ok: true, token };
  } catch (err) {
    console.error("[study-guide] createRecap failed:", err);
    return { ok: false, error: "database_unavailable" };
  }
}

/**
 * Resolve a share token to its guide, or null (unknown token / DB unavailable —
 * a read, so it fails open and the public page renders a plain 404 either way;
 * an attacker can't distinguish "no such guide" from "DB down").
 */
export async function getRecap(token: string): Promise<StudyGuide | null> {
  // Cheap shape gate before touching the DB: real tokens are 32-char base64url.
  if (!token || token.length > 64 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  await ensureSchema();
  try {
    const res = await query<{
      token: string;
      deck_slug: string;
      title: string | null;
      markdown: string;
      created_at: Date;
    }>(
      `SELECT token, deck_slug, title, markdown, created_at
         FROM deck_recaps
        WHERE token = $1`,
      [token],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      token: r.token,
      deckSlug: r.deck_slug,
      title: (r.title ?? "").slice(0, MAX_GUIDE_TITLE),
      markdown: (r.markdown ?? "").slice(0, MAX_GUIDE_MARKDOWN),
      createdAt: r.created_at.getTime(),
    };
  } catch {
    return null; // no DB / query error — the page 404s, never crashes
  }
}

/**
 * A deck's published guides, newest first (bounded) — for the edit-page panel.
 * `[]` when the DB is unavailable, like every other store read.
 */
export async function listRecapsForDeck(deckSlug: string, limit = 20): Promise<StudyGuideSummary[]> {
  await ensureSchema();
  try {
    const res = await query<{ token: string; title: string | null; created_at: Date }>(
      `SELECT token, title, created_at
         FROM deck_recaps
        WHERE deck_slug = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [deckSlug, Math.max(1, Math.min(50, Math.floor(limit)))],
    );
    return res.rows.map((r) => ({
      token: r.token,
      title: (r.title ?? "").slice(0, MAX_GUIDE_TITLE),
      createdAt: r.created_at.getTime(),
    }));
  } catch {
    return []; // the panel just shows no published guides
  }
}
