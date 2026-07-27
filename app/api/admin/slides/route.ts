import { NextResponse } from "next/server";
import { canManageDeck, currentSession } from "@/lib/auth";
import { checkDeckManage } from "@/lib/deck-authz";
import { getDeckOwner } from "@/lib/uploaded-decks";
import { getDeck } from "@/lib/decks";
import { assertSameOrigin } from "@/lib/csrf";
import { isDbReachable } from "@/lib/db";
import { getDeckSlides, updateSlideMeta } from "@/lib/slides-store";
import { sanitizeBranches, type SlideBranch } from "@/lib/types";

// Ownership-gated editor API for per-slide speaker notes + AI grounding context.
// GET reads a deck's slide metadata; PUT saves one slide's edits. READ is broader
// than WRITE by design (S2): any presenter may READ a registry deck's grounding
// (the shared, admin-authored official decks everyone presents) OR any deck they
// manage; WRITE is restricted to canManageDeck, so a presenter can never edit a
// registry deck's or another presenter's notes. Reads/writes go through
// lib/slides-store; we surface a 503 when there's genuinely no DB.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FIELD = 8000;

export async function GET(req: Request) {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  // READ authorization (S2): a registry deck's grounding is shared/readable by any
  // presenter; anything else must be a deck this session manages. getDeckOwner
  // throws on DB error → 503; null → the slug doesn't exist → 404 (don't leak).
  let owner: { ownerId: string | null; kind: string } | null;
  try {
    owner = await getDeckOwner(slug);
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  if (!owner) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (owner.kind !== "registry" && !canManageDeck(session, owner.ownerId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Distinguish "DB down" from "deck simply has no slides" by actually probing
  // reachability — a set-but-unreachable DATABASE_URL must surface, not degrade.
  if (!(await isDbReachable())) {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  const slides = await getDeckSlides(slug);
  return NextResponse.json({ slug, slides });
}

interface PutBody {
  slug?: string;
  index?: number;
  speakerNotes?: string;
  aiContext?: string;
  /** Branch point: null/[] clears it; otherwise 2–4 {label, from, to} paths. */
  branches?: unknown;
}

export async function PUT(req: Request) {
  // CSRF: reject a browser-attested cross-origin write before touching auth or
  // the body (see lib/csrf.ts — Lax cookie + same-site deck subdomain gap).
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const slug = (body.slug ?? "").toString();
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  // WRITE authorization (S2): editing grounding requires manage rights — admin, or
  // the deck's owner. Registry decks (owner NULL) are therefore admin-only to edit.
  const perm = await checkDeckManage(session, slug);
  if (!perm.ok) {
    return NextResponse.json({ error: perm.error }, { status: perm.status });
  }

  const index = body.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "bad_index" }, { status: 400 });
  }

  const patch: { speakerNotes?: string; aiContext?: string; branches?: SlideBranch[] | null } =
    {};
  if (body.branches !== undefined) {
    // null or [] clears the branch point; anything else must sanitize to a valid
    // 2–4 path list (lib/types.ts — the one shared rule) or the save is rejected,
    // so a half-formed branch can never be persisted.
    if (body.branches === null || (Array.isArray(body.branches) && body.branches.length === 0)) {
      patch.branches = null;
    } else {
      // Range-check targets against the deck's real length so an out-of-range
      // path (e.g. a stale from:500 on a 20-slide deck) is dropped, not saved.
      // slideCount from getDeck (slideCount for embed/uploaded, else slides.length),
      // matching how the other routes read a deck's length.
      const deck = await getDeck(slug);
      const slideCount = deck ? deck.slideCount ?? deck.slides.length : undefined;
      const cleaned = sanitizeBranches(body.branches, slideCount);
      if (!cleaned) return NextResponse.json({ error: "bad_branches" }, { status: 400 });
      patch.branches = cleaned;
    }
  }
  if (body.speakerNotes !== undefined) {
    const v = String(body.speakerNotes);
    if (v.length > MAX_FIELD) return NextResponse.json({ error: "too_long" }, { status: 400 });
    patch.speakerNotes = v;
  }
  if (body.aiContext !== undefined) {
    const v = String(body.aiContext);
    if (v.length > MAX_FIELD) return NextResponse.json({ error: "too_long" }, { status: 400 });
    patch.aiContext = v;
  }

  const result = await updateSlideMeta(slug, index, patch);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "database_unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
