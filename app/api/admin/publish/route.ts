import { NextResponse } from "next/server";
import { currentSession } from "@/lib/auth";
import { checkDeckManage } from "@/lib/deck-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { getDeck } from "@/lib/decks";
import { setPublishStatus, type PublishStatus } from "@/lib/publish-store";

// Ownership-gated mutator for a deck's publish status (main | normal |
// unpublished). Authorization is TIERED (S3): promoting a deck to 'main' repoints
// the shared home page "/" for every viewer, so it is ADMIN-ONLY; 'normal' and
// 'unpublished' only affect the deck's own visibility, so the deck's owner (or an
// admin) may set them. On success returns the fresh { statusMap } so the dashboard
// re-renders without a second round-trip.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: readonly PublishStatus[] = ["main", "normal", "unpublished"];

interface PostBody {
  slug?: string;
  status?: string;
}

export async function POST(req: Request) {
  // CSRF: reject a browser-attested cross-origin write before touching auth or
  // the body (see lib/csrf.ts — Lax cookie + same-site deck subdomain gap).
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const slug = (body.slug ?? "").toString();
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  const status = (body.status ?? "").toString();
  if (!VALID.includes(status as PublishStatus)) {
    return NextResponse.json({ error: "bad_status" }, { status: 400 });
  }

  // AUTHORIZATION BEFORE ANY EXISTENCE CHECK (S10 non-enumeration). Doing getDeck
  // first would return a distinct 400 unknown_deck for a missing slug while an
  // existing-but-unauthorized slug fell through to 403/404 — letting a presenter
  // enumerate other users' (incl. Hidden) deck slugs by the status difference.
  // Every other per-deck route authorizes first for exactly this reason; publish
  // now matches. Tiered (S3):
  //  - 'main' repoints the shared home page "/" → ADMIN ONLY. A presenter is
  //    refused 403 UNIFORMLY, before we ever look up the slug, so existence never
  //    leaks. (Leaking existence to an admin is moot — an admin sees every deck.)
  //  - 'normal'/'unpublished' → owner or admin via checkDeckManage, which returns a
  //    single 404 for BOTH missing and unauthorized (and 503 on DB error) — no
  //    oracle. It also confirms the deck exists (a decks row), replacing the old
  //    getDeck existence guard for this branch.
  if (status === "main") {
    if (session.role !== "admin") {
      return NextResponse.json({ error: "admin_only" }, { status: 403 });
    }
    // Admin-only path: NOW we may look up the deck (existence + embeddability).
    // Only slugs that actually exist can be published, and "/" can only render a
    // main deck it knows how to show — via an embedUrl (the first-party workshop
    // deck, iframed same-origin) OR, for an uploaded deck, a contentUrl (app/page
    // renders it via UploadedDeckFrame). A canonical React Slide[] deck has
    // neither, so marking one 'main' would succeed yet leave "/" blank. Refuse when
    // both paths are absent. (contentUrl is undefined when DECK_ORIGIN is unset, so
    // an uploaded deck with no reachable origin is rejected too.) The dashboard
    // disables the control, but a direct POST bypasses that, so this server check
    // is what actually holds. 'normal'/'unpublished' render via /d/<slug> and need
    // neither, so only 'main' is gated on embeddability.
    const deck = await getDeck(slug);
    if (!deck) return NextResponse.json({ error: "unknown_deck" }, { status: 400 });
    if (!deck.embedUrl && !(deck.kind === "uploaded" && deck.contentUrl)) {
      return NextResponse.json(
        {
          error: "not_embeddable",
          message:
            "Only self-contained HTML decks (with an embedUrl) can be shown on the home page ( / ).",
        },
        { status: 400 },
      );
    }
  } else {
    const perm = await checkDeckManage(session, slug);
    if (!perm.ok) {
      return NextResponse.json({ error: perm.error }, { status: perm.status });
    }
  }

  const result = await setPublishStatus(slug, status as PublishStatus);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "database_unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, statusMap: result.statusMap });
}
