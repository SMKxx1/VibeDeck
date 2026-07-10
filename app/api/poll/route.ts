import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { openPoll, revealPoll, closePoll, getLiveTally } from "@/lib/poll";

// Live poll control — PRESENTER ONLY.
//   POST { action: "open" | "reveal" | "close", ... } drives the poll lifecycle.
//   GET  ?slug= returns the current poll + its LIVE tally (only the presenter polls
//        this; viewers receive the poll via /api/session and see the tally only
//        after reveal). Any valid presenter cookie may run a poll for the deck
//        they're presenting — this is a live-session action, not deck management.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

async function isPresenter(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

interface PostBody {
  slug?: string;
  action?: string;
  question?: string;
  options?: unknown;
  correctIndex?: number;
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await isPresenter())) {
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
  const action = (body.action ?? "").toString();

  if (action === "open") {
    const question = (body.question ?? "").toString().trim();
    const options = Array.isArray(body.options)
      ? body.options.map((o) => (o ?? "").toString())
      : [];
    const cleaned = options.map((o) => o.trim()).filter((o) => o.length > 0);
    if (!question) return NextResponse.json({ error: "missing_question" }, { status: 400 });
    if (cleaned.length < 2) return NextResponse.json({ error: "need_options" }, { status: 400 });
    const correctIndex =
      typeof body.correctIndex === "number" ? body.correctIndex : null;
    const poll = await openPoll(slug, { question, options, correctIndex });
    return NextResponse.json({ poll, tally: new Array(poll.options.length).fill(0), total: 0 }, { headers: NO_STORE });
  }

  if (action === "reveal") {
    const poll = await revealPoll(slug);
    if (!poll) return NextResponse.json({ error: "no_poll" }, { status: 404 });
    return NextResponse.json({ poll, tally: poll.tally ?? [], total: poll.total ?? 0 }, { headers: NO_STORE });
  }

  if (action === "close") {
    await closePoll(slug);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}

export async function GET(req: Request) {
  if (!(await isPresenter())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  const live = await getLiveTally(slug);
  if (!live) return NextResponse.json({ poll: null }, { headers: NO_STORE });
  return NextResponse.json(
    { poll: live.poll, tally: live.tally, total: live.total },
    { headers: NO_STORE },
  );
}
