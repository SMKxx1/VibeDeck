import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { staticDecks } from "@/lib/decks/static";
import { deckSlugExists, insertUploadedDeck } from "@/lib/uploaded-decks";
import { validateDeckHtml } from "@/lib/deck-validator";
import { replaceUploadedDeckSlides } from "@/lib/slides-store";

// Presenter-gated deck UPLOAD — THE route that first lets new deck content enter
// the system at runtime. Containment is NOT this route's job: the origin
// isolation + CSP + sandboxed frame (Phase 0.5) is what safely renders whatever
// bytes land here. This route only decides WHO may upload and does cheap
// STRUCTURAL checks (size, slug shape, "looks like markup") — never sanitization
// or a bundle contract (Phase 2). Raw html is stored and served as-is.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 2 MB cap. It lives HERE (the upload validator), never as a column constraint —
// migration 003 keeps html deliberately unconstrained on size. Enforced twice: on
// the raw Content-Length header (before buffering) AND on the parsed html field.
const MAX_BYTES = 2_000_000;
// slug shape: lowercase alphanumeric words joined by single hyphens, no leading/
// trailing/double hyphens. Length is bounded separately (1–64).
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function isPresenter(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

// Static-slug collision, checked DIRECTLY against staticDecks (not via the merged
// getDeck): a compiled registry deck may have no DB row for an ON CONFLICT to
// trip, and static precedence means such a slug could never render as the uploaded
// deck anyway — so it must be rejected here, not left to the DB.
function collidesStatic(slug: string): boolean {
  return staticDecks.some((d) => d.slug === slug);
}

// title → base slug: lowercase, every non-alphanumeric run → one hyphen, trim
// hyphens, cap length leaving room for a numeric suffix. Empty (all-symbol title)
// is handled by the caller's `|| "deck"` fallback.
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

// today as YYYY-MM-DD — the default upload date so a fresh deck sorts to the TOP
// of the newest-first library instead of last (rowToDeck coalesces a null date to
// "", which sorts last). A client-supplied date overrides this.
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Auto-suffix -2/-3/… until a slug collides NOTHING (static OR any DB row). The
// bare base is tried first (no "-1"). Bounded so a pathological namespace can't
// spin forever; the ON CONFLICT insert remains the final race guard regardless.
// deckSlugExists throws on DB error — that propagates to the caller (→ 503) rather
// than handing back a slug we couldn't prove is free.
async function firstFreeSlug(base: string): Promise<string> {
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!collidesStatic(candidate) && !(await deckSlugExists(candidate))) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, 64); // astronomically unlikely to be reached
}

interface PostBody {
  title?: unknown;
  html?: unknown;
  slug?: unknown;
  date?: unknown;
  description?: unknown;
}

export async function POST(req: Request) {
  // Gate order (cheapest/fastest first, per spec): presenter cookie (401) →
  // same-origin CSRF (403) → Content-Length cap (413) → JSON parse (400) →
  // field validation. assertSameOrigin is the same helper every admin write uses.
  if (!(await isPresenter())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Content-Length gate BEFORE req.json(): App Router route handlers have no
  // built-in body-size limit, so reject an oversized (or header-less) request from
  // the RAW header WITHOUT buffering the body into memory. A missing/garbage
  // length is a reject — a real browser upload always sends one.
  const lenHeader = req.headers.get("content-length");
  const len = lenHeader === null ? NaN : Number(lenHeader);
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const html = typeof body.html === "string" ? body.html : "";
  if (!title || !html) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  // Re-check the byte cap on the html FIELD itself: Content-Length measured the
  // whole JSON envelope; this measures the bytes we actually store.
  if (Buffer.byteLength(html, "utf8") > MAX_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  // Conformance gate (Phase 2): the deck must be a well-formed VibeDeck bundle —
  // exactly one <deck-stage>, >=1 <section> slide, no external <script src>, and a
  // valid (or absent) vibedeck-context manifest. This is NOT the security boundary
  // (that's the separate origin + CSP + sandbox); it guarantees the shared runtime
  // can render it and that we can safely derive its slide list + AI grounding.
  // Rejected decks are never stored. `validation.slides` is populated below.
  const validation = validateDeckHtml(html);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid_deck", issues: validation.issues, warnings: validation.warnings },
      { status: 422 },
    );
  }

  const date =
    typeof body.date === "string" && body.date.trim() ? body.date.trim() : todayIso();
  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim()
      : null;

  // --- Slug resolution: honor a client-supplied slug (validated + collision-
  // checked) or generate one from the title. ---
  let slug: string;
  if (typeof body.slug === "string" && body.slug.length > 0) {
    slug = body.slug;
    if (!SLUG_RE.test(slug) || slug.length > 64) {
      return NextResponse.json({ error: "bad_slug" }, { status: 400 });
    }
    if (collidesStatic(slug)) {
      return NextResponse.json({ error: "slug_conflict" }, { status: 409 });
    }
    try {
      if (await deckSlugExists(slug)) {
        return NextResponse.json({ error: "slug_conflict" }, { status: 409 });
      }
    } catch {
      return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }
  } else {
    const base = slugifyTitle(title) || "deck";
    try {
      slug = await firstFreeSlug(base);
    } catch {
      return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }
  }

  // Insert with ON CONFLICT DO NOTHING: rowCount 0 means a slug that raced past the
  // checks above (a concurrent upload of the same slug) — the DB is the final
  // arbiter, so surface that as 409 rather than a 500.
  let result: "ok" | "conflict";
  try {
    result = await insertUploadedDeck({ slug, title, date, description, html });
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  if (result === "conflict") {
    return NextResponse.json({ error: "slug_conflict" }, { status: 409 });
  }

  // Populate the deck's per-slide AI grounding + presenter notes from its
  // validated bundle so it works with the AI tutor immediately (best-effort — a
  // DB hiccup here just leaves grounding empty, it doesn't fail the stored upload).
  await replaceUploadedDeckSlides(slug, validation.slides);

  return NextResponse.json({ slug, warnings: validation.warnings }, { status: 201 });
}
