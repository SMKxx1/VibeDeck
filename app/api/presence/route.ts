import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { markPresent, getRoster } from "@/lib/presence";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { isDeckViewable } from "@/lib/publish-store";

// Live presence / roster (#1).
//   POST — a VIEWER heartbeat: "I'm here, on slide N, following=Y". Records
//          presence and returns the current headcount so the viewer's "N watching"
//          chip updates without a second request. Deliberately NOT rate-limited:
//          it's an interval heartbeat (not a user-triggered action), and sharing
//          the per-name AI limiter would starve the tutor. Writes are a cheap
//          per-field hset and the roster is bounded + freshness-pruned.
//   GET  — the PRESENTER reads the full roster (names + each viewer's slide +
//          follow state). Presenter-gated so the room's name list is a presenter
//          tool, not public.
// Both are publish-gated: presence only exists for a deck the caller may view.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function cleanName(raw: unknown): string {
  return (
    (raw ?? "")
      .toString()
      .replace(/[^\p{L}\p{N} .,'-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40) || "anonymous"
  );
}

async function isPresenterReq(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

interface PostBody {
  slug?: string;
  name?: string;
  index?: number;
  follow?: boolean;
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
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

  // Publish gate: no presence on a deck the caller can't view (indistinguishable
  // 404, matching the other live routes).
  if (!(await isDeckViewable(slug, await isPresenterReq()))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const name = cleanName(body.name);
  const index = Number.isFinite(body.index) ? Number(body.index) : 0;
  await markPresent(slug, name, index, body.follow === true);
  const roster = await getRoster(slug);
  return NextResponse.json({ watching: roster.length }, { headers: NO_STORE });
}

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  // Presenter-only: the detailed roster (names + positions) is a presenter tool.
  if (!(await isPresenterReq())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const roster = await getRoster(slug);
  return NextResponse.json(
    {
      count: roster.length,
      viewers: roster.map((v) => ({ name: v.name, index: v.index, follow: v.follow })),
    },
    { headers: NO_STORE },
  );
}
