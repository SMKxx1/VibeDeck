import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, getSession } from "@/lib/auth";
import { checkDeckManage } from "@/lib/deck-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { deleteUploadedDeck, replaceUploadedDeckHtml } from "@/lib/uploaded-decks";
import { validateDeckHtml } from "@/lib/deck-validator";
import { clearDeckLiveState } from "@/lib/live-reset";

// Ownership-gated REPLACE (PUT) and DELETE for an already-uploaded deck. Gate
// order: authenticated session (401) → CSRF (403) → OWNERSHIP (checkDeckManage:
// admin, or the presenter who owns this deck; else 404, indistinguishable from a
// missing slug) → size/validation. Every write is ALSO scoped to kind='uploaded'
// at the SQL level, so a registry slug can never be mutated or removed here
// regardless of what the caller passes.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 2_000_000;

async function currentSession() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return getSession(token);
}

interface PutBody {
  // title is validated for parity with the upload form, but a replace is
  // CONTENT-ONLY — the UPDATE touches html alone (see below), never the title.
  title?: unknown;
  html?: unknown;
}

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { slug } = await params;
  // Ownership BEFORE we validate (or even read) the body: a presenter who doesn't
  // own this deck gets a flat 404 without us doing any work on their payload, and
  // learns nothing about whether the slug exists.
  const perm = await checkDeckManage(session, slug);
  if (!perm.ok) {
    return NextResponse.json({ error: perm.error }, { status: perm.status });
  }

  // Content-Length cap before req.json() — same reasoning as POST (no built-in
  // body limit; reject from the raw header without buffering an unbounded body).
  const lenHeader = req.headers.get("content-length");
  const len = lenHeader === null ? NaN : Number(lenHeader);
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const html = typeof body.html === "string" ? body.html : "";
  if (!title || !html) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (Buffer.byteLength(html, "utf8") > MAX_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  // Same conformance gate as upload (see app/api/admin/decks/route.ts): the new
  // content must be a valid VibeDeck bundle. A malformed replacement is rejected
  // and the deck's existing stored html is left untouched.
  const validation = validateDeckHtml(html);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid_deck", issues: validation.issues, warnings: validation.warnings },
      { status: 422 },
    );
  }

  // rowCount 0 → the slug doesn't exist OR is a registry slug: undistinguished 404
  // (don't leak which). The store's UPDATE deliberately does NOT touch
  // publish_status — replacing bytes must not silently re-expose or hide a deck a
  // presenter deliberately set to a given visibility.
  let result: "ok" | "not_found";
  try {
    result = await replaceUploadedDeckHtml(
      slug,
      html,
      validation.slides,
      validation.slideCount,
    );
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  if (result === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ slug, warnings: validation.warnings });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { slug } = await params;

  // Ownership gate first: a non-owner (or a presenter aiming at a registry slug)
  // gets 404 before we reveal anything about the deck. An admin passes and may hit
  // the 409s below (registry decks and the 'main' deck still can't be deleted here).
  const perm = await checkDeckManage(session, slug);
  if (!perm.ok) {
    return NextResponse.json({ error: perm.error }, { status: perm.status });
  }

  // The store locks the row and checks main status in the same transaction as
  // deletion, so promotion cannot race this guard.
  let result: Awaited<ReturnType<typeof deleteUploadedDeck>>;
  try {
    result = await deleteUploadedDeck(slug); // deck_slides cascade via the FK
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  // The main deck must be EXPLICITLY demoted first (via /api/admin/publish) — we
  // never auto-demote as a delete side effect. This app prefers explicit state
  // transitions to implicit cascades, and an implicit demote here would silently
  // blank "/" as a bonus surprise.
  if (result === "main") {
    return NextResponse.json({ error: "demote_first" }, { status: 409 });
  }
  if (result === "not_found") {
    // Registry slug, missing row, or a concurrent delete → not managed here.
    return NextResponse.json({ error: "not_deletable" }, { status: 409 });
  }

  // Best-effort: purge ALL live-room Redis state keyed by this slug (the same
  // composite the reset-session route uses) so a later deck that reuses the freed
  // slug can't inherit stale position / pins / poll / recap / etc. clearDeckLive
  // State is allSettled over self-swallowing helpers, so a cleanup error NEVER
  // fails the delete — the row is already gone, this is just hygiene.
  await clearDeckLiveState(slug);

  return NextResponse.json({ slug });
}
