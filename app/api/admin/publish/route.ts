import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
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
  if (!getDeck(slug)) return NextResponse.json({ error: "unknown_deck" }, { status: 400 });

  const status = (body.status ?? "").toString();
  if (!VALID.includes(status as PublishStatus)) {
    return NextResponse.json({ error: "bad_status" }, { status: 400 });
  }

  const result = await setPublishStatus(slug, status as PublishStatus);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "database_unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, statusMap: result.statusMap });
}
