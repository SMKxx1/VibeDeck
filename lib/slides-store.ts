// Per-slide editable metadata store (server-only): speaker notes + AI grounding
// context, backed by Postgres via lib/db.ts.
//
// GRACEFUL DEGRADATION (mirrors lib/redis.ts in spirit): every read returns a
// safe fallback ([] / {} / null) and NEVER throws when `DATABASE_URL` is unset
// or the DB is unreachable, so callers transparently fall back to the static
// slide context (lib/decks/build-host-website-context.ts) and the embed deck's
// own bridge notes. The build succeeds with no DB.
//
// Seeding is insert-only (ON CONFLICT DO NOTHING) so a redeploy never clobbers a
// presenter's later edits.

import { getPool, isDbReachable, query } from "./db";
import { ensureSchema, SEEDS } from "./schema";
import type { DeckSlideMeta } from "./deck-validator";
import { sanitizeBranches, type SlideBranch } from "./types";

// ensureSchema (the DB boot sequence) and SEEDS both moved to lib/schema.ts to
// break an import cycle: uploaded-deck reads need ensureSchema, which used to live
// here alongside a now-async import of the decks registry. This module just
// consumes them now.

export interface SlideMeta {
  index: number;
  label: string;
  speakerNotes: string;
  aiContext: string;
  /** Branch point (2–4 audience-voted paths), or null — see lib/types.ts. */
  branches: SlideBranch[] | null;
}

// SEEDS (the single source of seed truth) now lives in lib/schema.ts. We still
// need it here to recover a slide's authored label when upserting an edit into a
// row that was never seeded — keeps the grounding header intact.
function seedFor(slug: string) {
  return SEEDS.find((s) => s.slug === slug);
}

// ---- reads (never throw) ----------------------------------------------------

/** Every slide's editable metadata, ordered by index. `[]` when no DB. */
export async function getDeckSlides(slug: string): Promise<SlideMeta[]> {
  await ensureSchema();
  try {
    const res = await query<{
      slide_index: number;
      label: string | null;
      speaker_notes: string;
      ai_context: string;
      branches: unknown;
    }>(
      `SELECT slide_index, label, speaker_notes, ai_context, branches
         FROM deck_slides
        WHERE deck_slug = $1
        ORDER BY slide_index ASC`,
      [slug],
    );
    return res.rows.map((r) => ({
      index: r.slide_index,
      label: r.label ?? "",
      speakerNotes: r.speaker_notes ?? "",
      aiContext: r.ai_context ?? "",
      // Re-sanitize on read: JSONB is schemaless, so a hand-edited row must
      // degrade to "not a branch slide", never to a crashing shape.
      branches: sanitizeBranches(r.branches),
    }));
  } catch {
    return []; // no DB / query error — caller falls back to static data
  }
}

/**
 * The full-deck AI grounding text, reproducing the EXACT format of the static
 * `fullContextText()` but sourced from the DB `ai_context` rows. Returns null
 * when the DB is unavailable or the deck has zero rows, so the caller falls back
 * to the static module.
 */
export async function getFullContextText(slug: string): Promise<string | null> {
  await ensureSchema();
  try {
    const res = await query<{ slide_index: number; label: string | null; ai_context: string }>(
      `SELECT slide_index, label, ai_context
         FROM deck_slides
        WHERE deck_slug = $1
        ORDER BY slide_index ASC`,
      [slug],
    );
    if (res.rows.length === 0) return null;
    return res.rows
      .map((r) => `--- Slide ${r.slide_index + 1}: ${r.label ?? ""} ---\n${r.ai_context}`)
      .join("\n\n");
  } catch {
    return null;
  }
}

/** The AI grounding text for one slide. Null when unavailable / missing. */
export async function getSlideContextText(slug: string, index: number): Promise<string | null> {
  await ensureSchema();
  try {
    const res = await query<{ ai_context: string }>(
      `SELECT ai_context FROM deck_slides WHERE deck_slug = $1 AND slide_index = $2`,
      [slug, index],
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].ai_context;
  } catch {
    return null;
  }
}

/** index → speaker_notes map for the presenter console. `{}` when no DB. */
export async function getSlideNotes(slug: string): Promise<Record<number, string>> {
  await ensureSchema();
  try {
    const res = await query<{ slide_index: number; speaker_notes: string }>(
      `SELECT slide_index, speaker_notes FROM deck_slides WHERE deck_slug = $1`,
      [slug],
    );
    const map: Record<number, string> = {};
    for (const r of res.rows) map[r.slide_index] = r.speaker_notes ?? "";
    return map;
  } catch {
    return {};
  }
}

/** One slide's branch point, or null (not a branch slide / unavailable). */
export async function getSlideBranches(slug: string, index: number): Promise<SlideBranch[] | null> {
  await ensureSchema();
  try {
    const res = await query<{ branches: unknown }>(
      `SELECT branches FROM deck_slides WHERE deck_slug = $1 AND slide_index = $2`,
      [slug, index],
    );
    if (res.rows.length === 0) return null;
    return sanitizeBranches(res.rows[0].branches);
  } catch {
    return null;
  }
}

/** index → branches map for a deck's branch-point slides. `{}` when no DB. */
export async function getDeckBranches(slug: string): Promise<Record<number, SlideBranch[]>> {
  await ensureSchema();
  try {
    const res = await query<{ slide_index: number; branches: unknown }>(
      `SELECT slide_index, branches FROM deck_slides
        WHERE deck_slug = $1 AND branches IS NOT NULL`,
      [slug],
    );
    const map: Record<number, SlideBranch[]> = {};
    for (const r of res.rows) {
      const b = sanitizeBranches(r.branches);
      if (b) map[r.slide_index] = b;
    }
    return map;
  } catch {
    return {};
  }
}

// ---- write ------------------------------------------------------------------

export interface SlideMetaPatch {
  speakerNotes?: string;
  aiContext?: string;
  /** null clears the branch point; a valid 2–4 list sets it. */
  branches?: SlideBranch[] | null;
}

/**
 * Update the provided columns for one slide (parameterized). Sets updated_at.
 * If the row doesn't exist yet, inserts it (upsert) so an edit never silently
 * no-ops. Returns `{ ok:false, error }` when the DB is unavailable so the API
 * can surface a 503.
 */
export async function updateSlideMeta(
  slug: string,
  index: number,
  patch: SlideMetaPatch,
): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema();
  if (!(await isDbReachable())) return { ok: false, error: "database_unavailable" };

  const sets: string[] = [];
  const values: unknown[] = [];
  let n = 1;
  if (patch.speakerNotes !== undefined) {
    sets.push(`speaker_notes = $${n++}`);
    values.push(patch.speakerNotes);
  }
  if (patch.aiContext !== undefined) {
    sets.push(`ai_context = $${n++}`);
    values.push(patch.aiContext);
  }
  if (patch.branches !== undefined) {
    sets.push(`branches = $${n++}`);
    // Stringify rather than passing the array: node-postgres would serialize a
    // JS array as a Postgres ARRAY literal, not JSONB. PG casts the text for us.
    values.push(patch.branches === null ? null : JSON.stringify(patch.branches));
  }
  if (sets.length === 0) return { ok: true }; // nothing to change

  sets.push(`updated_at = now()`);
  const slugParam = `$${n++}`;
  const indexParam = `$${n++}`;
  values.push(slug, index);

  try {
    const res = await query(
      `UPDATE deck_slides SET ${sets.join(", ")}
        WHERE deck_slug = ${slugParam} AND slide_index = ${indexParam}`,
      values,
    );
    if (res.rowCount && res.rowCount > 0) return { ok: true };

    // Row didn't exist — insert it so the edit takes effect. Pull the label from
    // the seed when we know it (keeps the grounding header intact). On a
    // concurrent insert (ON CONFLICT) only overwrite the column(s) THIS patch
    // actually carries — otherwise a racing partial write of the other column
    // would be silently blanked back to "" (a lost update). The VALUES defaults
    // ("") only ever apply to a genuinely brand-new row.
    const label = seedFor(slug)?.slides.find((s) => s.index === index)?.label ?? null;
    const conflictSets: string[] = [];
    if (patch.speakerNotes !== undefined) {
      conflictSets.push("speaker_notes = EXCLUDED.speaker_notes");
    }
    if (patch.aiContext !== undefined) {
      conflictSets.push("ai_context = EXCLUDED.ai_context");
    }
    if (patch.branches !== undefined) {
      conflictSets.push("branches = EXCLUDED.branches");
    }
    conflictSets.push("updated_at = now()");
    await query(
      `INSERT INTO deck_slides (deck_slug, slide_index, label, speaker_notes, ai_context, branches, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (deck_slug, slide_index) DO UPDATE
         SET ${conflictSets.join(", ")}`,
      [
        slug,
        index,
        label,
        patch.speakerNotes ?? "",
        patch.aiContext ?? "",
        patch.branches ? JSON.stringify(patch.branches) : null,
      ],
    );
    return { ok: true };
  } catch (err) {
    console.error("[slides-store] updateSlideMeta failed:", err);
    return { ok: false, error: "database_unavailable" };
  }
}

/**
 * Replace an UPLOADED deck's per-slide grounding wholesale from its validated
 * bundle (label + AI context + speaker notes derived by lib/deck-validator from
 * the deck's <section>s and its vibedeck-context manifest). Called on upload and
 * on replace.
 *
 * Unlike updateSlideMeta (a presenter's partial edit of ONE slide), this is the
 * author RE-DECLARING the whole deck, so it overwrites every field for every
 * slide and — critically — deletes any stale rows at indices beyond the new
 * slide count (a replace that shrinks the deck must not leave orphaned grounding
 * that /api/ask's getFullContextText would still feed to the model). The delete
 * + multi-row upsert run in ONE transaction on a pinned client so a concurrent
 * read never sees a half-applied deck. Batched into a single INSERT (not N
 * round-trips) so a 300-slide deck is one query, not 300.
 *
 * Best-effort by design: returns void and swallows on no-DB / error. A missing
 * DB just means the deck has no authored grounding yet (generic AI answers),
 * which is a graceful degrade, not an upload failure — the deck HTML itself is
 * already stored by the caller regardless.
 */
export async function replaceUploadedDeckSlides(
  slug: string,
  slides: DeckSlideMeta[],
): Promise<void> {
  await ensureSchema();
  const pool = await getPool();
  if (!pool) return;

  // Acquire the pinned client OUTSIDE the transaction try, guarded: pool.connect()
  // itself can reject (pool exhausted past connectionTimeoutMillis, or the DB
  // dropped between the html write and here). This function is best-effort — the
  // deck's html is ALREADY stored by the caller — so a failure to acquire must
  // swallow and return, never propagate as a 5xx that falsely fails a request
  // whose durable work already succeeded.
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error("[slides-store] replaceUploadedDeckSlides: could not acquire a connection:", err);
    return;
  }
  try {
    await client.query("BEGIN");
    // Drop any grounding rows at indices this deck no longer has.
    await client.query(`DELETE FROM deck_slides WHERE deck_slug = $1 AND slide_index >= $2`, [
      slug,
      slides.length,
    ]);
    if (slides.length > 0) {
      // Build one multi-row INSERT ... ON CONFLICT DO UPDATE. Params per row:
      // (deck_slug, slide_index, label, speaker_notes, ai_context, branches).
      // Preserve DB-authored values the incoming source can't represent: an
      // absent branches binds to SQL NULL (see the push below — sanitizeBranches
      // returns null for the HTML-publish path, which the validator never emits
      // branches for), and empty speaker_notes/ai_context mean "the HTML carried
      // none", so both COALESCE/CASE back to the row's existing value. The
      // markdown importer supplies a real branches array (non-null) and non-empty
      // notes, so those still overwrite.
      const rows: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      for (const s of slides) {
        rows.push(`($${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++})`);
        const branches = sanitizeBranches(s.branches);
        values.push(slug, s.index, s.label, s.speakerNotes, s.aiContext, branches ? JSON.stringify(branches) : null);
      }
      await client.query(
        `INSERT INTO deck_slides (deck_slug, slide_index, label, speaker_notes, ai_context, branches)
         VALUES ${rows.join(", ")}
         ON CONFLICT (deck_slug, slide_index) DO UPDATE
           SET label = EXCLUDED.label,
               speaker_notes = CASE WHEN EXCLUDED.speaker_notes IS NULL OR EXCLUDED.speaker_notes = '' THEN deck_slides.speaker_notes ELSE EXCLUDED.speaker_notes END,
               ai_context = CASE WHEN EXCLUDED.ai_context IS NULL OR EXCLUDED.ai_context = '' THEN deck_slides.ai_context ELSE EXCLUDED.ai_context END,
               branches = COALESCE(EXCLUDED.branches, deck_slides.branches),
               updated_at = now()`,
        values,
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore — connection released regardless */
    }
    console.error("[slides-store] replaceUploadedDeckSlides failed:", err);
  } finally {
    client.release();
  }
}
