import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession, setPresenterIndex, resetLock, heartbeat, isLive } from "@/lib/session";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";

// The live-session channel. Viewers GET the presenter's position (polled);
// the presenter POSTs its position (and can "reset the lock"). Only a valid
// presenter cookie may write.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  const state = await getSession(slug);
  return NextResponse.json({ ...state, live: isLive(state) }, { headers: NO_STORE });
}

interface PostBody {
  slug?: string;
  index?: number;
  reset?: boolean;
  heartbeat?: boolean;
}

export async function POST(req: Request) {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const slug = (body.slug ?? "").toString();
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  const state = body.reset
    ? await resetLock(slug)
    : body.heartbeat
      ? await heartbeat(slug)
      : await setPresenterIndex(slug, Number.isFinite(body.index) ? Number(body.index) : 0);
  return NextResponse.json({ ...state, live: isLive(state) }, { headers: NO_STORE });
}
