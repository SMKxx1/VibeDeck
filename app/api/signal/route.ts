import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { addSignal, getSignals, isSignalKind } from "@/lib/signals";
import { checkRateLimit } from "@/lib/kv";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { isDeckViewable } from "@/lib/publish-store";

// Viewer→presenter backchannel (#2).
//   POST — a VIEWER sends one signal (👍 up / 🎉 party / 🐢 slow / 🙋 hand /
//          "I'm lost"). Rate-limited on a DEDICATED bucket (never the AI limiter)
//          so a viewer can't spam the presenter, and enum-only so there's nothing
//          to moderate.
//   GET  — the PRESENTER polls recent signals to render floating reactions and a
//          decaying "N feel lost" meter. Presenter-gated.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const RECENT_MS = 30_000; // signals surfaced to the presenter
const HELP_MS = 15_000; // window for the live "lost / slow-down" meter

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
  kind?: string;
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
  const kind = (body.kind ?? "").toString();
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  if (!isSignalKind(kind)) return NextResponse.json({ error: "bad_kind" }, { status: 400 });

  if (!(await isDeckViewable(slug, await isPresenterReq()))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const name = cleanName(body.name);
  // Dedicated rate-limit bucket (`rl:signal:*`), distinct from the AI limiter, so
  // reacting never counts against a viewer's chat budget and vice-versa.
  const rl = await checkRateLimit(`signal:${name}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: "rate_limited", retryAfter: rl.retryAfter }, { status: 429 });
  }

  await addSignal(slug, name, kind);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  if (!(await isPresenterReq())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const signals = await getSignals(slug, RECENT_MS);
  const now = Date.now();
  // The live "help" meter: distinct viewers signalling lost/slow in the last 15s.
  const lostNames = new Set<string>();
  const slowNames = new Set<string>();
  for (const s of signals) {
    if (now - s.at > HELP_MS) continue;
    if (s.kind === "lost") lostNames.add(s.name);
    else if (s.kind === "slow") slowNames.add(s.name);
  }
  return NextResponse.json(
    {
      signals, // newest-first, last 30s — the console animates new ones
      lost: lostNames.size,
      slow: slowNames.size,
    },
    { headers: NO_STORE },
  );
}
