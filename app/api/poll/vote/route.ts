import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { NO_STORE, cleanName } from "@/lib/api-helpers";
import { assertSameOrigin } from "@/lib/csrf";
import { isDeckViewable } from "@/lib/publish-store";
import { checkRateLimit } from "@/lib/kv";
import { vote } from "@/lib/poll";
import { checkPublicRateLimit, isValidDeckSlug } from "@/lib/request-security";

// A VIEWER casts (or changes) their vote on the current poll. Publish-gated like
// the other viewer live routes; the poll's own state machine enforces one vote per
// name and rejects a stale/closed poll. Dedicated rate-limit bucket (never the AI
// limiter).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIVE_ID_RE = /^[A-Za-z0-9_-]{12}$/;

interface PostBody {
  slug?: string;
  pollId?: string;
  optionIndex?: number;
  name?: string;
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
  const pollId = (body.pollId ?? "").toString();
  const optionIndex = Number(body.optionIndex);
  if (!isValidDeckSlug(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400 });
  }
  if (!LIVE_ID_RE.test(pollId)) {
    return NextResponse.json({ error: "bad_poll_id" }, { status: 400 });
  }
  if (!Number.isInteger(optionIndex) || optionIndex < 0) {
    return NextResponse.json({ error: "bad_option" }, { status: 400 });
  }

  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  const isPresenter = verifySessionToken(token);
  if (!(await isDeckViewable(slug, isPresenter))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const name = cleanName(body.name);
  // A generous per-address ceiling accommodates classrooms sharing NAT; the
  // tighter room+display-name bucket still stops one identity from hammering.
  const [publicLimit, identityLimit] = await Promise.all([
    checkPublicRateLimit(req, "poll-vote", `${slug}:${name}`, {
      max: 1_000,
      windowSeconds: 60,
    }),
    checkRateLimit(`vote:${slug}:${name}`, { max: 30, windowSeconds: 60 }),
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

  let result;
  try {
    result = await vote(slug, pollId, name, optionIndex);
  } catch {
    return NextResponse.json({ error: "live_state_unavailable" }, { status: 503 });
  }
  if (!result.ok) {
    if (result.error === "full") {
      return NextResponse.json({ error: "poll_full" }, { status: 429 });
    }
    // no_poll / closed / bad_option — a stale client; 409 so the UI can refetch.
    return NextResponse.json({ error: result.error }, { status: 409 });
  }
  return NextResponse.json({ ok: true, optionIndex }, { headers: NO_STORE });
}
