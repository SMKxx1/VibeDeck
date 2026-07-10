import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { isDeckViewable } from "@/lib/publish-store";
import { checkRateLimit } from "@/lib/kv";
import { vote } from "@/lib/poll";

// A VIEWER casts (or changes) their vote on the current poll. Publish-gated like
// the other viewer live routes; the poll's own state machine enforces one vote per
// name and rejects a stale/closed poll. Dedicated rate-limit bucket (never the AI
// limiter).

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
  if (!slug || !pollId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  const isPresenter = verifySessionToken(token);
  if (!(await isDeckViewable(slug, isPresenter))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const name = cleanName(body.name);
  const rl = await checkRateLimit(`vote:${name}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: "rate_limited", retryAfter: rl.retryAfter }, { status: 429 });
  }

  const result = await vote(slug, pollId, name, optionIndex);
  if (!result.ok) {
    // no_poll / closed / bad_option — a stale client; 409 so the UI can refetch.
    return NextResponse.json({ error: result.error }, { status: 409 });
  }
  return NextResponse.json({ ok: true, optionIndex }, { headers: NO_STORE });
}
