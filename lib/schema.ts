// DB boot sequence (server-only): run schema migrations, then seed the initial
// rows, once per process. Relocated OUT of lib/slides-store.ts so the ordering is:
//   lib/schema (ensureSchema) → { lib/slides-store, lib/publish-store, lib/uploaded-decks }
// i.e. every store depends on schema, and schema depends on NONE of them. This is
// what breaks the cycle: uploaded-deck reads need ensureSchema(), and ensureSchema
// used to live in slides-store, which used to import the (now async, uploaded-aware)
// decks registry — a loop. schema.ts imports only the PURE staticDecks array plus
// the seed data, so no store ever re-enters it.
//
// GRACEFUL DEGRADATION: ensureSchema resolves WITHOUT throwing when there's no DB
// or any error occurs — callers that follow it with a read/write take their own
// static fallback. Memoized so the advisory lock is taken at most once per process.

import { randomBytes } from "crypto";
import type { Pool } from "pg";
import { getPool } from "./db";
import { runMigrations } from "./migrations";
import { hashPassword } from "./password";
import { buildHostWebsiteSeed, type DeckSeed } from "./decks/build-host-website-seed";
import { staticDecks } from "./decks/static";

// Every deck we know how to seed with rich per-slide authored content. Today that's
// just the embed workshop deck. Exported so slides-store can look up a slide's seed
// label without redefining the list (it stays the single source of seed truth).
export const SEEDS: DeckSeed[] = [buildHostWebsiteSeed];

let schemaPromise: Promise<void> | null = null;

// Seed each known deck. This is DATA, not schema, and deliberately runs on EVERY
// boot (after migrations) rather than being baked into a one-time migration: the
// INSERT...ON CONFLICT DO NOTHING is inherently re-runnable and the SEEDS array
// is expected to grow (a newly-added deck must populate on the next boot). Only
// missing rows are ever filled — a presenter's later edits are never overwritten
// on redeploy.
async function seedDecks(pool: Pool): Promise<void> {
  for (const seed of SEEDS) {
    await pool.query(
      `INSERT INTO decks (slug, title, date, description, embed_url, slide_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO NOTHING`,
      [seed.slug, seed.title, seed.date, seed.description, seed.embedUrl, seed.slideCount],
    );
    for (const s of seed.slides) {
      await pool.query(
        `INSERT INTO deck_slides (deck_slug, slide_index, label, speaker_notes, ai_context)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (deck_slug, slide_index) DO NOTHING`,
        [seed.slug, s.index, s.label, s.speakerNotes, s.aiContext],
      );
    }
  }
}

// Guarantee a lightweight `decks` row for EVERY registry deck. Loops staticDecks
// DIRECTLY, never the merged registry (listDecks): uploaded rows own themselves and
// must never be re-touched by this static-seeding pass — re-INSERTing an uploaded
// slug here (even ON CONFLICT DO NOTHING) has no purpose and the html-NOT-NULL
// invariant means we couldn't supply the columns anyway. Distinct from seedDecks():
// that owns rich per-SLIDE content for the SEEDS array; this only ensures the
// top-level row exists so publish_status has somewhere to live — aws-lodge-demo and
// slide-system-tour have NO seed. INSERT-only (ON CONFLICT DO NOTHING): never
// touches an existing row, so it can't clobber a presenter's title or publish_status.
async function ensureDeckRows(pool: Pool): Promise<void> {
  for (const d of staticDecks) {
    await pool.query(
      `INSERT INTO decks (slug, title, date, description, embed_url, slide_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO NOTHING`,
      [
        d.slug,
        d.title,
        d.date,
        d.description ?? null,
        d.embedUrl ?? null,
        d.slideCount ?? d.slides.length,
      ],
    );
  }
}

// Pick the initial "main" deck AFTER the rows exist — ONLY if no deck is main yet.
// The single-statement `... AND NOT EXISTS (SELECT 1 ... WHERE publish_status='main')`
// guard makes this atomic (no check-then-act race) and naturally idempotent: the
// first boot on a fresh DB promotes the env's live deck; once ANY deck is main —
// whether from this backfill or a presenter's later dashboard choice — every
// future call matches zero rows and no-ops, so a redeploy NEVER clobbers a
// presenter's choice. $1 mirrors app/page.tsx's exact fallback literal.
async function ensureMainSet(pool: Pool): Promise<void> {
  const slug = process.env.NEXT_PUBLIC_LIVE_DECK_SLUG || "build-host-website";
  await pool.query(
    `UPDATE decks SET publish_status = 'main'
      WHERE slug = $1 AND NOT EXISTS (SELECT 1 FROM decks WHERE publish_status = 'main')`,
    [slug],
  );
}

// Seed the initial ADMIN user (Phase 4) from PRESENTER_USERNAME/PASSWORD so the
// pre-accounts credential becomes a real DB-backed admin — the existing login
// keeps working, now as an account. CHECK-FIRST (avoids paying scrypt on every
// boot once seeded) with ON CONFLICT (email) DO NOTHING as the concurrent-boot
// race backstop (two boots can't create two admins). Never re-hashes or clobbers
// an existing row, so a later password change survives a redeploy. Uses the same
// resolved dev defaults the old credential check used, so local dev still has a
// working login. Runs after migrations (the users table exists).
async function ensureAdminUser(pool: Pool): Promise<void> {
  const username = process.env.PRESENTER_USERNAME || "presenter";
  const password = process.env.PRESENTER_PASSWORD || "present";
  const existing = await pool.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [
    username,
  ]);
  if (existing.rows.length > 0) return; // already seeded — don't re-hash or clobber
  const id = randomBytes(18).toString("base64url");
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO NOTHING`,
    [id, username, hash],
  );
}

/**
 * Run schema migrations (versioned, advisory-locked, forward-only — from
 * lib/migrations.ts) then seed initial rows, once per process. Resolves WITHOUT
 * throwing when there's no DB or any error occurs.
 *
 * ORDER MATTERS: runMigrations (schema) → seedDecks (per-slide authored content)
 * → ensureDeckRows (a top-level row for EVERY registry deck) → ensureMainSet
 * (choose the initial main deck). ensureDeckRows must precede ensureMainSet so the
 * target row actually exists to be UPDATEd; both run after migrations so the
 * publish_status column exists.
 */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const pool = await getPool();
      if (!pool) return; // no DATABASE_URL / pg missing — nothing to do
      try {
        await runMigrations(pool); // DDL: versioned + advisory-locked
        await seedDecks(pool); // DATA: idempotent insert-only per-slide seed
        await ensureDeckRows(pool); // DATA: a decks row for every registry deck
        await ensureMainSet(pool); // DATA: pick the initial main deck if none yet
        await ensureAdminUser(pool); // DATA: seed the initial admin (Phase 4)
      } catch (err) {
        // Log once, then degrade: reads/writes will fall back on their own.
        console.error("[schema] ensureSchema failed — using static fallback:", err);
      }
    })();
  }
  return schemaPromise;
}
