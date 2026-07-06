import { NextResponse } from "next/server";
import { addPin, getPins } from "@/lib/pinboard";
import { checkRateLimit } from "@/lib/kv";

// The showcase pinboard. Viewers POST { name, url } from the input slide; anyone
// GETs the current pins (polled by the pinboard slide). Public on purpose — this
// is a class gallery — but rate-limited per name and URL-validated server-side.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  const pins = await getPins(slug);
  return NextResponse.json({ pins }, { headers: NO_STORE });
}

interface PostBody {
  slug?: string;
  name?: string;
  url?: string;
}

export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const slug = (body.slug ?? "").toString();
  const name = (body.name ?? "").toString();
  const url = (body.url ?? "").toString();
  if (!slug || !url) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const rl = await checkRateLimit(`pin:${name || "anon"}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: "rate_limited", retryAfter: rl.retryAfter }, { status: 429 });
  }

  const pin = await addPin(slug, name, url);
  if (!pin) return NextResponse.json({ error: "invalid_url" }, { status: 400 });

  const pins = await getPins(slug);
  return NextResponse.json({ ok: true, pin, pins }, { headers: NO_STORE });
}
