import { NextResponse } from "next/server";
import { markPresent, getRoster } from "@/lib/presence";
import { isPresenterRequest } from "@/lib/auth";
import { NO_STORE, cleanName } from "@/lib/api-helpers";
import { assertSameOrigin } from "@/lib/csrf";
import { isDeckViewable } from "@/lib/publish-store";
import { checkRateLimit } from "@/lib/kv";
import { checkPublicRateLimit, isValidDeckSlug } from "@/lib/request-security";

// Live presence / roster (#1).
//   POST — a VIEWER heartbeat: "I'm here, on slide N, following=Y". Records
//          presence and returns the current headcount so the viewer's "N watching"
//          chip updates without a second request. Uses dedicated heartbeat limits
//          (not the AI limiter); writes and roster cardinality are bounded.
//   GET  — the PRESENTER reads the full roster (names + each viewer's slide +
//          follow state). Presenter-gated so the room's name list is a presenter
//          tool, not public.
// Both are publish-gated: presence only exists for a deck the caller may view.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (!isValidDeckSlug(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }

  // Publish gate: no presence on a deck the caller can't view (indistinguishable
  // 404, matching the other live routes).
  if (!(await isDeckViewable(slug, await isPresenterRequest()))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const name = cleanName(body.name);
  const index = body.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 10_000) {
    return NextResponse.json({ error: "bad_index" }, { status: 400 });
  }
  const [publicLimit, identityLimit] = await Promise.all([
    checkPublicRateLimit(req, "presence", `${slug}:${name}`, {
      max: 30_000,
      windowSeconds: 60,
    }),
    checkRateLimit(`presence:${slug}:${name}`, { max: 120, windowSeconds: 60 }),
  ]);
  if (!publicLimit.allowed || !identityLimit.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        retryAfter: Math.max(publicLimit.retryAfter, identityLimit.retryAfter),
      },
      { status: 429 },
    );
  }
  let result: Awaited<ReturnType<typeof markPresent>>;
  try {
    result = await markPresent(slug, name, index, body.follow === true);
  } catch {
    return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
  }
  if (result.status === "full") {
    return NextResponse.json({ error: "roster_full" }, { status: 429 });
  }
  return NextResponse.json({ watching: result.watching }, { headers: NO_STORE });
}

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!isValidDeckSlug(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }

  // Presenter-only: the detailed roster (names + positions) is a presenter tool.
  if (!(await isPresenterRequest())) {
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
