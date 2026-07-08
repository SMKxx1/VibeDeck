import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import {
  deleteUploadedDeck,
  getUploadedDeckDeletionInfo,
  replaceUploadedDeckHtml,
} from "@/lib/uploaded-decks";
import { clearSession } from "@/lib/session";
import { clearPinboard } from "@/lib/pinboard";

// Presenter-gated REPLACE (PUT) and DELETE for an already-uploaded deck. Same
// cheapest-first gate order as POST (presenter → CSRF → size). Every write is
// scoped to kind='uploaded' at the SQL level, so a registry slug can never be
// mutated or removed through this route regardless of what the caller passes.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 2_000_000;

async function isPresenter(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

interface PutBody {
  // title is validated for parity with the upload form, but a replace is
  // CONTENT-ONLY — the UPDATE touches html alone (see below), never the title.
  title?: unknown;
  html?: unknown;
}

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!(await isPresenter())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Content-Length cap before req.json() — same reasoning as POST (no built-in
  // body limit; reject from the raw header without buffering an unbounded body).
  const lenHeader = req.headers.get("content-length");
  const len = lenHeader === null ? NaN : Number(lenHeader);
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const html = typeof body.html === "string" ? body.html : "";
  if (!title || !html) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (Buffer.byteLength(html, "utf8") > MAX_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  if (!html.includes("<")) {
    return NextResponse.json({ error: "not_html" }, { status: 400 });
  }

  const { slug } = await params;

  // rowCount 0 → the slug doesn't exist OR is a registry slug: undistinguished 404
  // (don't leak which). The store's UPDATE deliberately does NOT touch
  // publish_status — replacing bytes must not silently re-expose or hide a deck a
  // presenter deliberately set to a given visibility.
  let result: "ok" | "not_found";
  try {
    result = await replaceUploadedDeckHtml(slug, html);
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  if (result === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ slug });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!(await isPresenter())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { slug } = await params;

  // Look up first: only a kind='uploaded' row is deletable through this flow.
  let info: { publishStatus: string } | null;
  try {
    info = await getUploadedDeckDeletionInfo(slug);
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  // Registry slug or missing → not managed here. Registry decks live in code and
  // are not deletable/replaceable via this flow.
  if (!info) {
    return NextResponse.json({ error: "not_deletable" }, { status: 409 });
  }
  // The main deck must be EXPLICITLY demoted first (via /api/admin/publish) — we
  // never auto-demote as a delete side effect. This app prefers explicit state
  // transitions to implicit cascades, and an implicit demote here would silently
  // blank "/" as a bonus surprise.
  if (info.publishStatus === "main") {
    return NextResponse.json({ error: "demote_first" }, { status: 409 });
  }

  let deleted: boolean;
  try {
    deleted = await deleteUploadedDeck(slug); // deck_slides cascade via the FK
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  if (!deleted) {
    // Raced with another delete between the lookup and here — already gone.
    return NextResponse.json({ error: "not_deletable" }, { status: 409 });
  }

  // Best-effort: purge any live-session / pinboard Redis state keyed by this slug
  // so a later deck that reuses the freed slug can't inherit stale position/pins.
  // allSettled + the helpers' own swallowing mean a cleanup error NEVER fails the
  // delete — the row is already gone, this is just hygiene.
  await Promise.allSettled([clearSession(slug), clearPinboard(slug)]);

  return NextResponse.json({ slug });
}
