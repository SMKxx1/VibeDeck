// Forward-only schema migration runner (server-only), split out of slides-store
// so lib/db.ts stays a pure connection layer and slides-store keeps owning DATA
// (seeding), not DDL.
//
// WHY A RUNNER AT ALL: the old `CREATE TABLE IF NOT EXISTS` block silently
// no-ops on an already-existing table, so a later change like `ADD COLUMN` would
// never run against a live DB. Tracked, ordered, forward-only migrations fix
// that: each runs exactly once and is recorded in `schema_migrations`.
//
// CRITICAL LIVE-DB CONSTRAINT: local dev and Railway production point at the SAME
// physical Postgres, and `decks`/`deck_slides` already exist there with real,
// presenter-edited rows. Migration 001 therefore reproduces the EXACT current
// DDL verbatim under `IF NOT EXISTS`, so adopting the pre-existing schema as the
// baseline touches zero rows. Re-running the whole runner is a genuine no-op.

import type { Pool, PoolClient } from "pg";

// A migration runs its DDL through the ONE dedicated client that holds the
// advisory lock (see runMigrations) — never via pool.query(), because advisory
// locks are connection-scoped and a pooled query could land on a different
// client that doesn't hold the lock. `up` may issue multiple statements / guards
// / backfills, which is why it's a function, not a raw {id, sql} string.
export type Migration = { id: string; up(client: PoolClient): Promise<void> };

// Fixed 64-bit advisory-lock key, documented as derived from
// hashtext('vibedeck:migrations') but hardcoded so it can never drift between
// deploys. Two concurrent booters (e.g. a local run + a prod boot against the
// shared DB) serialize on this key: the second blocks, then finds every
// migration already applied and no-ops.
const LOCK_KEY = 4242000001n;

// 001_baseline: adopt the pre-existing production schema into version control.
// These two statements are the EXACT DDL the old ensureSchema() ran, verbatim.
// Because the tables already exist in the shared DB, both are no-ops — but the
// runner still records ('001_baseline') so the live schema is registered as the
// applied baseline WITHOUT writing a single row. `IF NOT EXISTS` is kept HERE
// ONLY because 001 must tolerate the tables pre-existing; every future migration
// is unconditional, forward-only DDL.
const migration001: Migration = {
  id: "001_baseline",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS decks (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        date TEXT,
        description TEXT,
        embed_url TEXT,
        slide_count INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS deck_slides (
        deck_slug TEXT NOT NULL REFERENCES decks(slug) ON DELETE CASCADE,
        slide_index INTEGER NOT NULL,
        label TEXT,
        speaker_notes TEXT NOT NULL DEFAULT '',
        ai_context TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (deck_slug, slide_index)
      )
    `);
  },
};

// 002_publish_status: add the three-state publish model to `decks`.
//
// DELIBERATELY DATA-FREE. Migrations run BEFORE seedDecks()/ensureDeckRows() in
// the boot sequence (see lib/slides-store.ts ensureSchema()), so on a genuinely
// fresh DB the `decks` table has ZERO rows when this runs — any UPDATE to pick a
// "main" deck here would silently no-op and the workshop deck would later default
// to whatever the column DEFAULT is. So this migration ONLY shapes the schema;
// choosing the initial main deck is done AFTER seeding by ensureMainSet().
//
// DEFAULT 'normal' (not 'unpublished') preserves today's behavior exactly: every
// registry deck is currently publicly viewable with no gate, so anything not
// explicitly set otherwise must stay viewable. A future upload feature can insert
// new decks as 'unpublished' at creation time; the column default serves the
// existing/backfill case, not that one.
//
// The partial unique index on the constant expression `(true)` WHERE
// publish_status='main' enforces AT MOST ONE main deck at the database level:
// every "main" row indexes the identical key `true`, so a second one violates
// uniqueness (Postgres 23505). This is the atomic backstop behind setPublishStatus.
const migration002: Migration = {
  id: "002_publish_status",
  async up(client) {
    await client.query(`
      ALTER TABLE decks ADD COLUMN publish_status TEXT NOT NULL DEFAULT 'normal'
        CHECK (publish_status IN ('main','normal','unpublished'))
    `);
    await client.query(`
      CREATE UNIQUE INDEX one_main ON decks ((true)) WHERE publish_status = 'main'
    `);
  },
};

// 003_uploaded_decks: let a `decks` row carry its OWN self-contained HTML so an
// uploaded deck is a runtime row, not a compiled registry entry.
//
// DELIBERATELY SCHEMA-ONLY (same discipline as 002). DEFAULT 'registry' backfills
// every existing row with ZERO writes — the column simply reads 'registry' for all
// three pre-existing decks, so this is a genuine no-op against the live DB and
// changes no behavior on its own. The byte-size cap on `html` lives in the upload
// validator (a route concern), NOT as a column constraint — the only DB-level
// invariant worth enforcing is that an 'uploaded' deck can never exist WITHOUT its
// html (the CHECK below), since serving a null-bodied uploaded deck would 500.
const migration003: Migration = {
  id: "003_uploaded_decks",
  async up(client) {
    await client.query(`
      ALTER TABLE decks ADD COLUMN kind TEXT NOT NULL DEFAULT 'registry'
        CHECK (kind IN ('registry','uploaded'))
    `);
    await client.query(`ALTER TABLE decks ADD COLUMN html TEXT`); // NULL for registry decks
    await client.query(`
      ALTER TABLE decks ADD CONSTRAINT uploaded_has_html
        CHECK (kind <> 'uploaded' OR html IS NOT NULL)
    `);
  },
};

// 004_accounts: multi-user accounts (Phase 4) — users, invites, and per-deck
// ownership. Schema-only. `decks.owner_id` is NULLABLE and backfills every
// existing row to NULL with zero writes: a NULL owner means a registry/system
// deck, which only an admin manages (uploaded decks get their creator's id going
// forward). ON DELETE SET NULL so removing a user orphans their decks to the
// admin-managed pool rather than cascading a delete. password_hash stores a
// self-describing scrypt string (see lib/users.ts).
const migration004: Migration = {
  id: "004_accounts",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'presenter' CHECK (role IN ('admin','presenter')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS invites (
        token       TEXT PRIMARY KEY,
        email       TEXT,
        role        TEXT NOT NULL DEFAULT 'presenter' CHECK (role IN ('admin','presenter')),
        created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
        used_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at  TIMESTAMPTZ NOT NULL
      )
    `);
    // ADD COLUMN IF NOT EXISTS (not a bare ADD COLUMN): the runner records a
    // migration only AFTER up() succeeds and does NOT wrap up() in a transaction,
    // so if this ALTER succeeds but the follow-up INSERT into schema_migrations
    // fails transiently, the next boot re-runs 004 — a bare ADD COLUMN would then
    // die on "column already exists" and wedge boot permanently. IF NOT EXISTS
    // makes the whole migration safely re-runnable (the CREATE TABLEs already are).
    await client.query(
      `ALTER TABLE decks ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id) ON DELETE SET NULL`,
    );
  },
};

// Ordered migration list. Order is array order; ids are also lexically sortable
// as a defense. Append new migrations here — never edit or reorder applied ones.
export const MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004];

// Bootstrap DDL for the tracking table itself — the one irreducible statement we
// must run every boot before we can consult it. Safe to re-run. `checksum` is
// nullable and advisory only (drift detection); the baseline's checksum is
// meaningless against pre-existing tables, so a mismatch only ever warns.
async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    TEXT
    )
  `);
}

// Apply every not-yet-applied migration, in order, under a session-level
// advisory lock held on a single dedicated client.
//
// SESSION lock (pg_advisory_lock), NOT transaction lock (pg_advisory_xact_lock):
// each migration commits independently, so a later failure can't roll back an
// earlier good migration that was already recorded. An xact lock would force all
// pending migrations into one surrounding transaction (all-or-nothing); a
// session lock spans multiple statements/transactions on the one client and is
// released explicitly in finally. `client.release()` in the outer finally
// guarantees the connection returns to the pool — and, if unlock somehow failed,
// the session-scoped lock drops when the session ends — even if a migration
// throws.
export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY.toString()]);
    await ensureMigrationsTable(client);

    const res = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(res.rows.map((r) => r.id));

    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await m.up(client);
      await client.query(
        "INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [m.id, null],
      );
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY.toString()]);
    } finally {
      client.release();
    }
  }
}
