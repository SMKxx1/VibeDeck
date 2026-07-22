import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  MAX_PIN_NAME_LENGTH,
  addPin,
  getPins,
  isValidPinboardSlug,
  normalizeUrl,
} from "@/lib/pinboard";
import { checkRateLimit } from "@/lib/kv";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { isDeckViewable } from "@/lib/publish-store";
import { getDeck } from "@/lib/decks";
import { checkPublicRateLimit } from "@/lib/request-security";

// Resolve whether THIS request carries a valid presenter cookie — presenters can
// reach an unpublished deck's pinboard, non-presenters cannot.
async function isPresenterReq(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

// The showcase pinboard. Viewers POST { name, url } from the input slide; anyone
// GETs the current pins (polled by the pinboard slide). Public on purpose — this
// is a class gallery — but rate-limited per name and URL-validated server-side.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const MAX_POST_BYTES = 8 * 1024;

async function deckIsAccessible(slug: string): Promise<boolean> {
  // isDeckViewable deliberately treats an unknown slug as a static deck. Pair it
  // with the merged registry lookup here so arbitrary attacker-chosen slugs can
  // never allocate pinboard keys.
  if (!(await getDeck(slug))) return false;
  return isDeckViewable(slug, await isPresenterReq());
}

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!isValidPinboardSlug(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400, headers: NO_STORE });
  }

  // Publish gate: an unpublished deck's pins are hidden from non-presenters, with
  // the same indistinguishable-from-unknown 404 shape as the other gated routes.
  if (!(await deckIsAccessible(slug))) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  const pins = await getPins(slug);
  return NextResponse.json({ pins }, { headers: NO_STORE });
}

interface PostBody {
  slug?: string;
  name?: string;
  url?: string;
}

export async function POST(req: Request) {
  const rawLength = req.headers.get("content-length");
  if (!rawLength) {
    return NextResponse.json({ error: "length_required" }, { status: 411, headers: NO_STORE });
  }
  if (!/^\d+$/.test(rawLength)) {
    return NextResponse.json({ error: "bad_content_length" }, { status: 400, headers: NO_STORE });
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return NextResponse.json({ error: "bad_content_length" }, { status: 400, headers: NO_STORE });
  }
  if (contentLength > MAX_POST_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413, headers: NO_STORE });
  }
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415, headers: NO_STORE });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  }
  if (typeof body.slug !== "string" || typeof body.url !== "string") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400, headers: NO_STORE });
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return NextResponse.json({ error: "bad_name" }, { status: 400, headers: NO_STORE });
  }
  const slug = body.slug;
  const name = (body.name ?? "").trim();
  const url = body.url;
  if (!isValidPinboardSlug(slug)) {
    return NextResponse.json({ error: "bad_slug" }, { status: 400, headers: NO_STORE });
  }
  if (name.length > MAX_PIN_NAME_LENGTH) {
    return NextResponse.json({ error: "bad_name" }, { status: 400, headers: NO_STORE });
  }
  if (!normalizeUrl(url)) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400, headers: NO_STORE });
  }

  // Publish gate (same as GET): a non-presenter can't post to an unpublished
  // deck's pinboard — same 404 shape so a hidden deck stays indistinguishable.
  if (!(await deckIsAccessible(slug))) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  // Preserve the low per-name limit for classroom usability behind shared NAT,
  // while also bounding the whole room and each proxy-derived client address.
  const [byName, byRoomAndClient] = await Promise.all([
    checkRateLimit(`pin:${slug}:${name || "anon"}`),
    checkPublicRateLimit(req, "pinboard", slug, { max: 200, windowSeconds: 60 }),
  ]);
  if (!byName.allowed || !byRoomAndClient.allowed) {
    const retryAfter = Math.max(byName.retryAfter, byRoomAndClient.retryAfter);
    return NextResponse.json(
      { error: "rate_limited", retryAfter },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(retryAfter) } },
    );
  }

  const pin = await addPin(slug, name, url);
  if (!pin) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400, headers: NO_STORE });
  }

  const pins = await getPins(slug);
  return NextResponse.json({ ok: true, pin, pins }, { headers: NO_STORE });
}
