import { NextResponse } from "next/server";
import { currentSession } from "@/lib/auth";
import { checkDeckManage } from "@/lib/deck-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { clearDeckLiveState } from "@/lib/live-reset";

// Owner-or-admin gated RESET-SESSION (POST) — wipe ALL live room state for one
// deck slug (slide position, pinboard, Q&A, presence, polls, signals, pulse,
// recap, activity) so the next run starts from a clean room. Gate order mirrors
// the sibling duplicate route: same-origin CSRF (403) → authenticated session
// (401) → OWNERSHIP (checkDeckManage: admin, or the presenter who owns this deck;
// else 404, indistinguishable from a missing slug). Registry decks (owner_id NULL)
// are admin-only — exactly what canManageDeck already encodes, so the seeded deck
// is resettable by an admin but 404s for a plain presenter. This touches ONLY the
// ephemeral room state (see lib/live-reset); the deck, its slides, recaps,
// reports, and assets are durable and left intact.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// slug shape, identical to the upload route (app/api/admin/decks/route.ts):
// lowercase alphanumeric words joined by single hyphens, 1–64 chars. A path param
// that can't be a real slug is a flat 400 before we touch the DB — a real deck's
// slug always matches, so this leaks nothing about which slugs exist.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  // CSRF first (cheap, fails fast), then the session cookie, then OWNERSHIP — a
  // non-owner learns nothing (flat 404) before we do any work.
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  if (!SLUG_RE.test(slug) || slug.length > 64) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }

  const perm = await checkDeckManage(session, slug);
  if (!perm.ok) {
    return NextResponse.json({ error: perm.error }, { status: perm.status });
  }

  // Wipe every piece of live room state for this slug. clearDeckLiveState is
  // best-effort and NEVER throws (allSettled over self-swallowing helpers), so a
  // Redis hiccup can't turn a reset into a 500 — the room is cleared as far as it
  // can be, and the presenter sees success.
  await clearDeckLiveState(slug);

  return NextResponse.json({ slug });
}
