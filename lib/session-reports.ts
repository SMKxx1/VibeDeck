// Session-report store (server-only): the Insight Engine's end-of-session
// snapshots — frozen confusion-pulse aggregates + the AI teaching debrief —
// backed by Postgres (table `session_reports`, migration 006).
//
// STRICT PRIVACY (slide-system-rules.md §§0.5, 9): a report contains ONLY
// numeric per-slide aggregates and the model's debrief text about the DECK.
// Never any viewer name, question, prompt, or answer — the aggregates are
// re-validated on the way in AND out so nothing else can ever ride along.
//
// Mirrors lib/publish-store.ts's conventions: reads fail OPEN to a safe
// fallback ([]) and NEVER throw; writes surface errors so the API can 503.

import { isDbReachable, query } from "./db";
import { ensureSchema } from "./schema";
import type { PulseSlide } from "./pulse";

export interface SessionReport {
  id: string;
  deckSlug: string;
  /** Epoch ms of the run's first struggle signal, or null when unknown. */
  startedAt: number | null;
  /** Epoch ms the snapshot was taken (row default now()). */
  endedAt: number;
  /** Frozen numeric per-slide aggregates — counts only, never content. */
  aggregates: PulseSlide[];
  /** The AI debrief, or null when generation failed but the snapshot was kept. */
  debrief: string | null;
}

// JSONB is schemaless, so validate the aggregates shape on read (same rationale
// as sanitizeBranches): a hand-edited row must degrade to [], never crash a
// render — and must never smuggle non-numeric content into a response.
function sanitizeAggregates(raw: unknown): PulseSlide[] {
  if (!Array.isArray(raw)) return [];
  const out: PulseSlide[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Partial<PulseSlide>;
    if (typeof o.index !== "number" || !Number.isInteger(o.index) || o.index < 0) continue;
    const num = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    const s: PulseSlide = {
      index: o.index,
      ask: num(o.ask),
      explain: num(o.explain),
      catchup: num(o.catchup),
      lost: num(o.lost),
      pollWrong: num(o.pollWrong),
      total: 0,
    };
    s.total = s.ask + s.explain + s.catchup + s.lost + s.pollWrong;
    if (s.total > 0) out.push(s);
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Persist one snapshot. A WRITE, so it surfaces failure (`ok:false`) for the
 * API to report — silently dropping a presenter's end-of-session record would
 * be a lost teaching artifact, not a graceful degrade.
 */
export async function saveReport(input: {
  id: string;
  deckSlug: string;
  startedAt: number | null;
  aggregates: PulseSlide[];
  debrief: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  await ensureSchema();
  if (!(await isDbReachable())) return { ok: false, error: "database_unavailable" };
  try {
    await query(
      `INSERT INTO session_reports (id, deck_slug, started_at, aggregates, debrief)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.id,
        input.deckSlug,
        input.startedAt ? new Date(input.startedAt) : null,
        // Stringify rather than passing the array: node-postgres would serialize
        // a JS array as a Postgres ARRAY literal, not JSONB (see slides-store).
        JSON.stringify(sanitizeAggregates(input.aggregates)),
        input.debrief,
      ],
    );
    return { ok: true };
  } catch (err) {
    console.error("[session-reports] saveReport failed:", err);
    return { ok: false, error: "database_unavailable" };
  }
}

/**
 * A deck's reports, newest first (bounded). `[]` when the DB is unavailable —
 * a read, so it fails open like every other store read.
 */
export async function listReports(deckSlug: string, limit = 10): Promise<SessionReport[]> {
  await ensureSchema();
  try {
    const res = await query<{
      id: string;
      deck_slug: string;
      started_at: Date | null;
      ended_at: Date;
      aggregates: unknown;
      debrief: string | null;
    }>(
      `SELECT id, deck_slug, started_at, ended_at, aggregates, debrief
         FROM session_reports
        WHERE deck_slug = $1
        ORDER BY ended_at DESC
        LIMIT $2`,
      [deckSlug, Math.max(1, Math.min(50, Math.floor(limit)))],
    );
    return res.rows.map((r) => ({
      id: r.id,
      deckSlug: r.deck_slug,
      startedAt: r.started_at ? r.started_at.getTime() : null,
      endedAt: r.ended_at.getTime(),
      aggregates: sanitizeAggregates(r.aggregates),
      debrief: r.debrief,
    }));
  } catch {
    return []; // no DB / query error — the panel just shows no history
  }
}
