import { NextResponse } from "next/server";
import { currentSession } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { deckSlugExists } from "@/lib/uploaded-decks";
import { validateDeckHtml } from "@/lib/deck-validator";
import {
  SLUG_RE,
  allocateSlug,
  collidesStatic,
  slugifyTitle,
  storeUploadedDeck,
  todayIso,
} from "@/lib/deck-create";

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

// Slug shape/collision/insert rules live in lib/deck-create.ts, shared verbatim
// with the Markdown-import and duplicate routes — a fork must never be able to
// mint a slug an upload would have rejected. currentSession (not the boolean gate)
// because a created deck's owner_id is the creator's user id, so the person who
// uploads a deck can later manage it (Phase 4).

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
  const session = await currentSession();
  if (!session) {
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
    const allocated = await allocateSlug(base);
    if (!allocated.ok) {
      return NextResponse.json({ error: allocated.error }, { status: allocated.status });
    }
    slug = allocated.slug;
  }

  // storeUploadedDeck inserts with ON CONFLICT DO NOTHING: rowCount 0 means a slug
  // that raced past the checks above (a concurrent upload of the same slug) — the
  // DB is the final arbiter, so that surfaces as 409 rather than a 500.
  const stored = await storeUploadedDeck({
    slug,
    title,
    date,
    description,
    html,
    ownerId: session.userId, // null for a legacy admin cookie — an admin can manage anything anyway
    slideCount: validation.slideCount,
    slides: validation.slides,
  });
  if (!stored.ok) {
    return NextResponse.json({ error: stored.error }, { status: stored.status });
  }

  return NextResponse.json({ slug, warnings: validation.warnings }, { status: 201 });
}
