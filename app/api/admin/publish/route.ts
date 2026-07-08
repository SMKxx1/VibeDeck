import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { getDeck } from "@/lib/decks";
import { setPublishStatus, type PublishStatus } from "@/lib/publish-store";

// Presenter-gated mutator for a deck's publish status (main | normal |
// unpublished). Same auth idiom as app/api/admin/slides/route.ts: a valid
// presenter cookie is required; everyone else gets 401. On success returns the
// fresh { statusMap } so the dashboard re-renders without a second round-trip.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID: readonly PublishStatus[] = ["main", "normal", "unpublished"];

async function isPresenter(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

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
  if (!(await isPresenter())) {
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
  // Only slugs that actually exist in the registry can be published — otherwise
  // a typo would create/flip a status row for a deck that renders nowhere.
  const deck = await getDeck(slug);
  if (!deck) return NextResponse.json({ error: "unknown_deck" }, { status: 400 });

  const status = (body.status ?? "").toString();
  if (!VALID.includes(status as PublishStatus)) {
    return NextResponse.json({ error: "bad_status" }, { status: 400 });
  }

  // Guard the "/"-invariant at the true boundary: "/" can only render a main deck
  // that it actually knows how to show, and there are now TWO such paths. Either
  // an embedUrl (the first-party workshop deck, iframed same-origin) OR — for an
  // uploaded deck — a contentUrl (app/page.tsx renders it via UploadedDeckFrame off
  // deck.contentUrl). A canonical React Slide[] deck has neither, so marking one
  // 'main' would succeed here yet leave "/" blank with no hint why — exactly the
  // gap a presenter hit. Refuse ONLY when both paths are absent. (contentUrl is
  // undefined when DECK_ORIGIN is unset, so an uploaded deck with no reachable
  // origin is correctly rejected too.) The dashboard also disables the control,
  // but a direct POST (curl) bypasses that, so this server check is what actually
  // holds. 'normal'/'unpublished' render via /d/<slug> and need neither, so only
  // gate 'main'.
  if (status === "main" && !deck.embedUrl && !(deck.kind === "uploaded" && deck.contentUrl)) {
    return NextResponse.json(
      {
        error: "not_embeddable",
        message:
          "Only self-contained HTML decks (with an embedUrl) can be shown on the home page ( / ).",
      },
      { status: 400 },
    );
  }

  const result = await setPublishStatus(slug, status as PublishStatus);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "database_unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, statusMap: result.statusMap });
}
