import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken, createPreviewToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { getUploadedDeck } from "@/lib/uploaded-decks";

// Presenter-only: mint a short-lived signed token that opens the fail-closed
// /d-content gate for an UNPUBLISHED uploaded deck, so a presenter can preview it
// before publishing. The token (lib/auth createPreviewToken) is the only thing
// that reaches that content, because the isolated DECK_ORIGIN has no session
// cookie to authenticate against. Same presenter-gate + CSRF idiom as every other
// admin route (see app/api/admin/publish/route.ts) — CSRF first so a browser-
// attested cross-origin caller is rejected before we touch auth or mint anything.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The absolute origin that serves uploaded-deck HTML (see lib/uploaded-decks).
// Without it there is nowhere to point the preview, so we fail loudly rather than
// hand back a broken URL.
const DECK_ORIGIN = process.env.DECK_ORIGIN;

async function isPresenter(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await isPresenter())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { slug } = await params;

  // Only uploaded decks are previewable this way — a registry slug (or a missing
  // one) has no /d-content page to open, so minting a token for it is meaningless.
  const deck = await getUploadedDeck(slug);
  if (!deck) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!DECK_ORIGIN) {
    return NextResponse.json({ error: "deck_origin_unset" }, { status: 503 });
  }

  const token = createPreviewToken(slug);
  return NextResponse.json({ url: `${DECK_ORIGIN}/d-content/${slug}?t=${token}` });
}
