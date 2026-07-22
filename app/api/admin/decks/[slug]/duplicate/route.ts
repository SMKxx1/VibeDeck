import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, getSession } from "@/lib/auth";
import { checkDeckManage } from "@/lib/deck-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { staticDecks } from "@/lib/decks/static";
import {
  deckSlugExists,
  getUploadedDeck,
  getUploadedDeckHtml,
  insertUploadedDeck,
} from "@/lib/uploaded-decks";
import { validateDeckHtml } from "@/lib/deck-validator";
import { copyAssets } from "@/lib/deck-assets";

// Owner-gated DUPLICATE (POST) — fork an existing uploaded deck into a brand-new
// one owned by the CURRENT session. Gate order mirrors the sibling PUT/DELETE
// route: same-origin CSRF (403) → authenticated session (401) → OWNERSHIP
// (checkDeckManage: admin, or the presenter who owns the SOURCE deck; else 404,
// indistinguishable from a missing slug). Only uploaded decks are forkable — a
// registry slug (no stored html) 404s. The fork is minted under session.userId
// (NOT the original owner) and lands 'unpublished' (insertUploadedDeck forces
// that), so a duplicate is never instantly public and is always managed by the
// person who created it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function currentSession() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return getSession(token);
}

// --- slug helpers, replicated from the create route (app/api/admin/decks/route.ts)
// so a fork picks a free, well-shaped slug by the same rules an upload does. ---

// Static-slug collision, checked directly against the compiled registry (a
// registry slug may have no DB row for an ON CONFLICT to trip).
function collidesStatic(slug: string): boolean {
  return staticDecks.some((d) => d.slug === slug);
}

// title → base slug: lowercase, every non-alphanumeric run → one hyphen, trim
// hyphens, cap length leaving room for a numeric suffix.
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

// today as YYYY-MM-DD — the default date so a fresh fork sorts to the TOP of the
// newest-first library (same as a new upload).
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Auto-suffix -2/-3/… until a slug collides NOTHING (static OR any DB row). The
// bare base is tried first (no "-1"). ON CONFLICT insert remains the final race
// guard. deckSlugExists throws on DB error → propagates to the caller (→ 503).
async function firstFreeSlug(base: string): Promise<string> {
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!collidesStatic(candidate) && !(await deckSlugExists(candidate))) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, 64); // astronomically unlikely to be reached
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  // CSRF first (cheap, fails fast), then the session cookie, then OWNERSHIP of the
  // SOURCE deck — a non-owner learns nothing (flat 404) before we do any work.
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  const perm = await checkDeckManage(session, slug);
  if (!perm.ok) {
    return NextResponse.json({ error: perm.error }, { status: perm.status });
  }

  // Load the source: the bytes AND its title/description. Only an uploaded deck has
  // stored html — a registry/missing slug returns null here → 404 (only uploaded
  // decks are forkable, and this stays indistinguishable from "no such deck").
  const source = await getUploadedDeckHtml(slug);
  const meta = await getUploadedDeck(slug);
  if (!source || !meta) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Re-validate the stored bytes before re-inserting them. It was valid when
  // stored, but a re-check keeps the fork honest and lets us derive the copied
  // grounding from the same validated slides. A rare !ok is a hard 422.
  const validation = validateDeckHtml(source.html);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid_deck", issues: validation.issues, warnings: validation.warnings },
      { status: 422 },
    );
  }

  // Derive the new slug from the source title + "copy" by the create route's rules
  // (slugifyTitle caps at 60), then auto-suffix past any collision.
  const base = slugifyTitle(`${meta.title} copy`) || "deck-copy";
  let newSlug: string;
  try {
    newSlug = await firstFreeSlug(base);
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  // Re-home the fork's vault-asset URLs onto the NEW slug BEFORE storing them, so
  // the fork's <img src="/d-assets/<newSlug>/…"> tags resolve against its OWN
  // copied rows (see copyAssets below) rather than the source deck's. The path
  // shape is fixed, so a plain global replace of the exact /d-assets/<slug>/
  // prefix is exact and preserves validity (only the slug segment changes).
  const forkHtml = source.html.split(`/d-assets/${slug}/`).join(`/d-assets/${newSlug}/`);

  // Insert the fork under the CURRENT user (not the original owner). insertUploaded
  // Deck forces publish_status 'unpublished', so a fork is never instantly public.
  // ON CONFLICT DO NOTHING → "conflict" if the slug raced past firstFreeSlug (409).
  let result: "ok" | "conflict";
  try {
    result = await insertUploadedDeck({
      slug: newSlug,
      title: `${meta.title} (copy)`,
      date: todayIso(),
      description: meta.description ?? null,
      html: forkHtml,
      ownerId: session.userId, // the fork belongs to whoever duplicated it
      slideCount: validation.slideCount,
      slides: validation.slides,
    });
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  if (result === "conflict") {
    return NextResponse.json({ error: "slug_conflict" }, { status: 409 });
  }

  // Copy the source's stored vault assets onto the fork so it owns its OWN
  // deck_assets rows (the html above already points at /d-assets/<newSlug>/…).
  // Best-effort like the grounding copy: copyAssets throws on a DB error, but the
  // fork is already stored, so a hiccup here must not fail the request.
  try {
    await copyAssets(slug, newSlug);
  } catch {
    // swallow — the fork is stored; its assets can be re-copied later.
  }

  return NextResponse.json({ slug: newSlug }, { status: 201 });
}
