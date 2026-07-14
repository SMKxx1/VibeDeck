import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getDeckBranches } from "@/lib/slides-store";

// Branch points, for the PRESENTER surfaces (console + uploaded-deck presenter
// overlay): which slides of this deck are branch points, and their paths. Fetched
// once on mount so the "Open branch vote" affordance can appear on the right
// slides. Presenter-gated by cookie only — running a branch vote is a
// live-session action, not deck management, so any valid presenter may see the
// paths of the deck they're presenting (same stance as GET /api/poll). Viewers
// never need this: they get the labels via the poll itself.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(req: Request) {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  // {} when the DB is unavailable or the deck has no branch points — the client
  // simply shows no branch affordance (graceful degrade, never an error).
  const branches = await getDeckBranches(slug);
  return NextResponse.json({ branches }, { headers: NO_STORE });
}
