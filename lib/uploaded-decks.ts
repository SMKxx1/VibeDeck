// Reads for uploaded decks (server-only): the runtime `decks` rows with kind =
// 'uploaded', each carrying its OWN self-contained HTML. Distinct from the compiled
// registry (lib/decks/static) — these live only in the DB and are served, framed
// and sandboxed, from the isolated DECK_ORIGIN, never the trusted first-party path.
//
// GRACEFUL DEGRADATION (mirrors every other store module): every read returns a
// safe fallback ([] / undefined) and NEVER throws when the DB is unavailable, so a
// DB blip degrades to "no uploaded decks" rather than taking the library down.
//
// Imports ONLY lib/db + lib/schema (ensureSchema) — deliberately NOT lib/decks —
// so the merged registry (lib/decks/index) can import THIS without a cycle.

import { query } from "./db";
import { ensureSchema } from "./schema";
import type { Deck } from "./types";

// The absolute origin that serves uploaded-deck HTML. A NEW env var, distinct from
// middleware's bare-hostname DECK_HOST: this is a full origin like
// "https://decks.wss-lodge.com". Unset → contentUrl is undefined and the deck lists
// as unavailable (the view layer decides how to surface that) rather than crashing.
const DECK_ORIGIN = process.env.DECK_ORIGIN;

function contentUrlFor(slug: string): string | undefined {
  return DECK_ORIGIN ? `${DECK_ORIGIN}/d-content/${slug}` : undefined;
}

// Row → Deck. Deliberately NO html column here (see the SELECTs): a list/lookup
// never needs the bytes, and pulling potentially-large HTML into every library
// render would be wasteful. slides is [] (uploaded decks have no canonical Slide[]
// model — deck_slides starts empty) and embedUrl is undefined (they render via
// contentUrl's sandboxed frame, never the trusted embed path). date may be NULL in
// the DB but Deck.date is a plain string, so coalesce to "".
interface UploadedRow {
  slug: string;
  title: string;
  date: string | null;
  description: string | null;
  slide_count: number | null;
}

function rowToDeck(r: UploadedRow): Deck {
  return {
    slug: r.slug,
    title: r.title,
    date: r.date ?? "",
    description: r.description ?? undefined,
    slides: [],
    embedUrl: undefined,
    slideCount: r.slide_count ?? 0,
    kind: "uploaded",
    contentUrl: contentUrlFor(r.slug),
  };
}

const COLS = "slug, title, date, description, slide_count";

/** Every uploaded deck as a Deck. `[]` when the DB is unavailable. */
export async function getUploadedDecks(): Promise<Deck[]> {
  await ensureSchema();
  try {
    const res = await query<UploadedRow>(
      `SELECT ${COLS} FROM decks WHERE kind = 'uploaded'`,
    );
    return res.rows.map(rowToDeck);
  } catch {
    return []; // no DB / query error — the library just shows the static decks
  }
}

/** One uploaded deck by slug, or undefined when missing / DB unavailable. */
export async function getUploadedDeck(slug: string): Promise<Deck | undefined> {
  await ensureSchema();
  try {
    const res = await query<UploadedRow>(
      `SELECT ${COLS} FROM decks WHERE slug = $1 AND kind = 'uploaded'`,
      [slug],
    );
    const r = res.rows[0];
    return r ? rowToDeck(r) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The actual stored HTML for one uploaded deck, plus its publish_status so the
 * caller can gate on it. The ONE place that SELECTs the html column — every other
 * read deliberately omits it (see COLS / rowToDeck) because only /d-content, which
 * serves the bytes, needs them. `kind = 'uploaded'` is in the WHERE so a registry
 * slug (which never has html) can never be served here and, critically, is
 * INDISTINGUISHABLE from a missing slug to the caller (both → null → bare 404), so
 * this route can't be used to probe whether a registry slug exists.
 *
 * Returns null on missing/registry slug AND on any DB error — this is the module's
 * one intentional break from the fail-OPEN convention elsewhere: /d-content serves
 * UNTRUSTED stored content, so a DB blip must fail CLOSED (null → 404), never leak.
 */
export async function getUploadedDeckHtml(
  slug: string,
): Promise<{ html: string; publishStatus: string } | null> {
  await ensureSchema();
  try {
    const res = await query<{ html: string; publish_status: string }>(
      `SELECT html, publish_status FROM decks WHERE slug = $1 AND kind = 'uploaded'`,
      [slug],
    );
    const r = res.rows[0];
    return r ? { html: r.html, publishStatus: r.publish_status } : null;
  } catch {
    return null; // fail closed — never serve, never leak, on a DB error
  }
}

// --- WRITES (upload / replace / delete) ---------------------------------------
// Deliberately UNLIKE the reads above: these do NOT swallow DB errors. A read can
// degrade to "no uploaded decks"; a write that silently no-ops would look like
// success while nothing persisted. They let the error propagate so the admin route
// can surface a 503 rather than lie. ensureSchema() still runs first so migration
// 003's columns exist.

/**
 * True if ANY decks row already owns this slug — an uploaded deck OR the
 * lightweight row ensured for each registry deck (lib/schema ensureDeckRows). Used
 * ONLY to pick a free auto-suffixed slug at upload time; the authoritative race
 * guard is insertUploadedDeck's ON CONFLICT. Throws on DB error (caller → 503):
 * a slug we can't verify as free must fail the upload, never mint a collision.
 */
export async function deckSlugExists(slug: string): Promise<boolean> {
  await ensureSchema();
  const res = await query(`SELECT 1 FROM decks WHERE slug = $1`, [slug]);
  return res.rows.length > 0;
}

/**
 * Insert a new uploaded deck. publish_status is 'unpublished' EXPLICITLY — an
 * upload must never be instantly public (never defaulted to anything else).
 * embed_url is NULL (uploaded decks render via the sandboxed contentUrl frame,
 * never the trusted embed path) and slide_count starts 0 (deck_slides is empty —
 * no AI grounding authored yet). ON CONFLICT (slug) DO NOTHING + rowCount 0 →
 * "conflict": a slug that raced past the caller's staticDecks/DB pre-checks, which
 * the DB is the final arbiter of. Throws on DB error (caller → 503).
 */
export async function insertUploadedDeck(fields: {
  slug: string;
  title: string;
  date: string;
  description: string | null;
  html: string;
  ownerId: string | null; // the creating user (Phase 4). NULL for a legacy-admin session.
}): Promise<"ok" | "conflict"> {
  await ensureSchema();
  const res = await query(
    `INSERT INTO decks (slug, title, date, description, kind, publish_status, html, embed_url, slide_count, owner_id)
     VALUES ($1, $2, $3, $4, 'uploaded', 'unpublished', $5, NULL, 0, $6)
     ON CONFLICT (slug) DO NOTHING`,
    [fields.slug, fields.title, fields.date, fields.description, fields.html, fields.ownerId],
  );
  return (res.rowCount ?? 0) === 0 ? "conflict" : "ok";
}

/**
 * The owner + kind of ANY deck (registry or uploaded) for authorization, or null
 * if the slug genuinely doesn't exist. Registry decks have owner_id NULL
 * (admin-managed). A route loads this, then applies canManageDeck(session,
 * ownerId) before mutating. Freshly queried (not a cached Deck) so ownership can't
 * be stale.
 *
 * Deliberately THROWS on a DB error rather than returning null: an authorization
 * gate must be able to tell "no such deck" (→ 404) apart from "database down"
 * (→ 503). Collapsing both into null would 404 a legit owner's edit during a DB
 * blip. Neither outcome leaks deck existence (a prober sees 503 for every slug
 * while the DB is down, 404 for both missing and unauthorized when it's up).
 */
export async function getDeckOwner(
  slug: string,
): Promise<{ ownerId: string | null; kind: string } | null> {
  await ensureSchema();
  const res = await query<{ owner_id: string | null; kind: string }>(
    `SELECT owner_id, kind FROM decks WHERE slug = $1`,
    [slug],
  );
  const r = res.rows[0];
  return r ? { ownerId: r.owner_id, kind: r.kind } : null;
}

/**
 * slug → owner_id for EVERY decks row (uploaded decks AND the lightweight rows
 * ensured for each registry deck). Lets the dashboard compute per-deck manage
 * rights in ONE query instead of N getDeckOwner round-trips. Registry rows carry
 * owner_id NULL. Returns {} on DB error — the dashboard then treats every deck as
 * unmanageable (shows no owner-only controls) rather than crashing; harmless
 * because the server routes still enforce authorization on every real mutation.
 */
export async function getAllDeckOwners(): Promise<Record<string, string | null>> {
  await ensureSchema();
  try {
    const res = await query<{ slug: string; owner_id: string | null }>(
      `SELECT slug, owner_id FROM decks`,
    );
    const map: Record<string, string | null> = {};
    for (const r of res.rows) map[r.slug] = r.owner_id;
    return map;
  } catch {
    return {};
  }
}

/**
 * Replace an uploaded deck's HTML in place. `AND kind = 'uploaded'` means a
 * registry slug (or a missing one) matches zero rows → "not_found",
 * INDISTINGUISHABLE in the response so this can't probe registry existence.
 * Deliberately does NOT touch publish_status — replacing content must never
 * silently re-expose or hide a deck a presenter set one way. Throws on DB error.
 */
export async function replaceUploadedDeckHtml(
  slug: string,
  html: string,
): Promise<"ok" | "not_found"> {
  await ensureSchema();
  const res = await query(
    `UPDATE decks SET html = $2, updated_at = now() WHERE slug = $1 AND kind = 'uploaded'`,
    [slug, html],
  );
  return (res.rowCount ?? 0) === 0 ? "not_found" : "ok";
}

/**
 * The delete-time facts about a slug: whether it's a deletable uploaded deck and
 * its current publish_status (so the route can refuse to delete the 'main' deck
 * without an explicit prior demotion, rather than blanking "/" as a side effect).
 * null → not an uploaded deck (registry or missing) → route returns 409
 * not_deletable. Throws on DB error (caller → 503).
 */
export async function getUploadedDeckDeletionInfo(
  slug: string,
): Promise<{ publishStatus: string } | null> {
  await ensureSchema();
  const res = await query<{ publish_status: string }>(
    `SELECT publish_status FROM decks WHERE slug = $1 AND kind = 'uploaded'`,
    [slug],
  );
  const r = res.rows[0];
  return r ? { publishStatus: r.publish_status } : null;
}

/**
 * Hard-delete an uploaded deck row; its deck_slides rows cascade via the FK ON
 * DELETE CASCADE (migration 001). `AND kind = 'uploaded'` is defense-in-depth — a
 * registry slug can never be deleted here even if a caller's prior guard regressed.
 * Returns false when nothing matched (already gone / not uploaded). Throws on DB error.
 */
export async function deleteUploadedDeck(slug: string): Promise<boolean> {
  await ensureSchema();
  const res = await query(`DELETE FROM decks WHERE slug = $1 AND kind = 'uploaded'`, [slug]);
  return (res.rowCount ?? 0) > 0;
}
