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

import type { PoolClient } from "pg";
import { getPool, isDbReachable, query } from "./db";
import { ensureSchema, SEEDS, safeRead, safeWrite } from "./schema";
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
// All of these take the READ posture from lib/db.ts safeRead: boot the schema,
// query, and on any failure hand back the fallback in the signature — no DB /
// query error means "caller uses static data", never an exception.

/** Every slide's editable metadata, ordered by index. `[]` when no DB. */
export async function getDeckSlides(slug: string): Promise<SlideMeta[]> {
  return safeRead(async () => {
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
  }, []);
}

/**
 * The full-deck AI grounding text, reproducing the EXACT format of the static
 * `fullContextText()` but sourced from the DB `ai_context` rows. Returns null
 * when the DB is unavailable or the deck has zero rows, so the caller falls back
 * to the static module.
 */
export async function getFullContextText(slug: string): Promise<string | null> {
  return safeRead<string | null>(async () => {
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
  }, null);
}

/** The AI grounding text for one slide. Null when unavailable / missing. */
export async function getSlideContextText(slug: string, index: number): Promise<string | null> {
  return safeRead<string | null>(async () => {
    const res = await query<{ ai_context: string }>(
      `SELECT ai_context FROM deck_slides WHERE deck_slug = $1 AND slide_index = $2`,
      [slug, index],
    );
    return res.rows.length === 0 ? null : res.rows[0].ai_context;
  }, null);
}

/** index → speaker_notes map for the presenter console. `{}` when no DB. */
export async function getSlideNotes(slug: string): Promise<Record<number, string>> {
  return safeRead(async () => {
    const res = await query<{ slide_index: number; speaker_notes: string }>(
      `SELECT slide_index, speaker_notes FROM deck_slides WHERE deck_slug = $1`,
      [slug],
    );
    const map: Record<number, string> = {};
    for (const r of res.rows) map[r.slide_index] = r.speaker_notes ?? "";
    return map;
  }, {});
}

/** One slide's branch point, or null (not a branch slide / unavailable). */
export async function getSlideBranches(slug: string, index: number): Promise<SlideBranch[] | null> {
  return safeRead<SlideBranch[] | null>(async () => {
    const res = await query<{ branches: unknown }>(
      `SELECT branches FROM deck_slides WHERE deck_slug = $1 AND slide_index = $2`,
      [slug, index],
    );
    return res.rows.length === 0 ? null : sanitizeBranches(res.rows[0].branches);
  }, null);
}

/** index → branches map for a deck's branch-point slides. `{}` when no DB. */
export async function getDeckBranches(slug: string): Promise<Record<number, SlideBranch[]>> {
  return safeRead(async () => {
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
  }, {});
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
  return safeWrite<{ ok: boolean; error?: string }>(
    "[slides-store] updateSlideMeta",
    async () => {
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
    },
    { ok: false, error: "database_unavailable" },
  );
}

/**
 * Join an existing transaction and replace an uploaded deck's derived slide
 * metadata. The caller owns BEGIN/COMMIT/ROLLBACK so it can commit these rows
 * together with the deck HTML and slide_count.
 *
 * Empty notes/context and absent branches intentionally preserve presenter edits,
 * matching the previous upload/replace behavior. On a shrink, every retained
 * branch list is revalidated against the new count so it cannot point at a slide
 * that no longer exists.
 */
export async function replaceUploadedDeckSlidesOnClient(
  client: PoolClient,
  slug: string,
  slides: DeckSlideMeta[],
  slideCount: number,
): Promise<void> {
  if (
    !Number.isInteger(slideCount) ||
    slideCount < 0 ||
    slides.length !== slideCount ||
    slides.some((slide, index) => slide.index !== index)
  ) {
    throw new Error("replaceUploadedDeckSlidesOnClient: inconsistent slide metadata");
  }

  // Drop grounding rows for slides removed by a replacement/draft publish.
  await client.query(`DELETE FROM deck_slides WHERE deck_slug = $1 AND slide_index >= $2`, [
    slug,
    slideCount,
  ]);

  if (slides.length > 0) {
    // Build one multi-row INSERT ... ON CONFLICT DO UPDATE. Params per row:
    // (deck_slug, slide_index, label, speaker_notes, ai_context, branches).
    const rows: string[] = [];
    const values: unknown[] = [];
    let n = 1;
    for (const slide of slides) {
      rows.push(`($${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++})`);
      const branches = sanitizeBranches(slide.branches, slideCount);
      values.push(
        slug,
        slide.index,
        slide.label,
        slide.speakerNotes,
        slide.aiContext,
        branches ? JSON.stringify(branches) : null,
      );
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

  // HTML validation knows the new slide count but does not carry manually edited
  // branches. Re-sanitize retained JSONB after the upsert so preserved branches
  // cannot retain out-of-range destinations after a shrink.
  const branchRows = await client.query<{ slide_index: number; branches: unknown }>(
    `SELECT slide_index, branches
       FROM deck_slides
      WHERE deck_slug = $1 AND branches IS NOT NULL`,
    [slug],
  );
  for (const row of branchRows.rows) {
    const branches = sanitizeBranches(row.branches, slideCount);
    await client.query(
      `UPDATE deck_slides
          SET branches = $3, updated_at = now()
        WHERE deck_slug = $1 AND slide_index = $2`,
      [slug, row.slide_index, branches ? JSON.stringify(branches) : null],
    );
  }
}

/**
 * Legacy best-effort wrapper for callers that only replace slide metadata. New
 * deck create/replace/publish paths use replaceUploadedDeckSlidesOnClient inside
 * their own transaction so HTML, slide_count, and deck_slides cannot diverge.
 */
export async function replaceUploadedDeckSlides(
  slug: string,
  slides: DeckSlideMeta[],
): Promise<void> {
  await ensureSchema();
  const pool = await getPool();
  if (!pool) return;

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error("[slides-store] replaceUploadedDeckSlides: could not acquire a connection:", err);
    return;
  }
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE decks SET slide_count = $2 WHERE slug = $1 AND kind = 'uploaded'`,
      [slug, slides.length],
    );
    await replaceUploadedDeckSlidesOnClient(client, slug, slides, slides.length);
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
