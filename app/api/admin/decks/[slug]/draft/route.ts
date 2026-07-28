import { NextResponse } from "next/server";
import { createPreviewToken, currentSession, type Session } from "@/lib/auth";
import { checkDeckManage } from "@/lib/deck-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { getUploadedDeckHtml } from "@/lib/uploaded-decks";
import {
  getDraftHtml,
  saveDraftHtml,
  publishDraft,
  discardDraft,
} from "@/lib/deck-drafts";
import { validateDeckHtml } from "@/lib/deck-validator";

// VDML Workbench: the owner-gated draft lifecycle for an UPLOADED deck's HTML.
//   GET    → the working copy (draft if one exists, else the published html) + a
//            fresh signed preview URL for the ?draft=1 serve path.
//   PUT    → save the draft (size-capped, DELIBERATELY UNVALIDATED — a draft may
//            be mid-edit/broken; only Publish gates on validateDeckHtml).
//   POST   → publish: validate + atomically swap draft→html (422 with the
//            validator's issues when the draft isn't a conforming bundle).
//   DELETE → discard the draft; the published bytes are untouched.
//
// Gate order on EVERY method (same idiom as ../route.ts): authenticated session
// (401) → CSRF (403) → OWNERSHIP (checkDeckManage: admin, or the presenter who
// owns this deck; else 404, indistinguishable from a missing slug) → kind check
// (only uploaded decks have editable HTML; a registry slug is the same 404).
// Every write is ALSO scoped to kind='uploaded' at the SQL level.
//
// SECURITY: the preview URL minted here is the ONLY thing that opens the
// fail-closed ?draft=1 gate on /d-content (the DECK_ORIGIN has no session
// cookie), so minting it sits BEHIND the full session+CSRF+ownership stack — a
// non-owner can never obtain a capability to view someone else's draft.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same cap as upload/replace (app/api/admin/decks/route.ts): a draft may not be
// bigger than what could ever be published.
const MAX_BYTES = 2_000_000;

// The absolute origin that serves uploaded-deck HTML (see lib/uploaded-decks).
// Unset → previewUrl is null and the Workbench shows its "preview unavailable —
// deck origin not configured" note instead of a broken frame.
const DECK_ORIGIN = process.env.DECK_ORIGIN;

// Shared gate for all four methods: session → CSRF → ownership → uploaded-only.
// Returns the failure response to send verbatim, or null to proceed.
async function gate(req: Request, slug: string): Promise<NextResponse | null> {
  const session: Session | null = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const perm = await checkDeckManage(session, slug);
  if (!perm.ok) {
    return NextResponse.json({ error: perm.error }, { status: perm.status });
  }
  // Only uploaded decks carry editable HTML. A registry slug gets the same 404
  // as a missing/foreign one — this route never confirms registry slugs exist.
  if (perm.kind !== "uploaded") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return null;
}

// A fresh signed capability URL for the draft preview frame, or null when
// DECK_ORIGIN isn't configured (the client degrades gracefully).
function draftPreviewUrl(slug: string): string | null {
  if (!DECK_ORIGIN) return null;
  const token = createPreviewToken(slug);
  return `${DECK_ORIGIN}/d-content/${slug}?draft=1&t=${token}`;
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const denied = await gate(req, slug);
  if (denied) return denied;

  // Working copy: the draft when one exists, else the published html. Both reads
  // fail closed to null; the ownership gate just proved the row exists and the DB
  // is up, so a null published html here means the DB dropped mid-request → 503.
  const draft = await getDraftHtml(slug);
  let html = draft;
  if (html === null) {
    const published = await getUploadedDeckHtml(slug);
    if (!published) {
      return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
    }
    html = published.html;
  }

  // Informational only (validateDeckHtml never throws; a broken draft reports 0).
  const slideCount = validateDeckHtml(html).slideCount;

  return NextResponse.json({
    html,
    hasDraft: draft !== null,
    slideCount,
    previewUrl: draftPreviewUrl(slug),
  });
}

interface PutBody {
  html?: unknown;
}

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const denied = await gate(req, slug);
  if (denied) return denied;

  // Content-Length cap before req.json() — same reasoning as the upload/replace
  // routes (no built-in body limit; reject from the raw header without buffering
  // an unbounded body).
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

  // A draft may be empty or broken mid-edit — the ONLY requirements are "it's a
  // string" and the byte cap. validateDeckHtml runs at publish time, not here.
  if (typeof body.html !== "string") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (Buffer.byteLength(body.html, "utf8") > MAX_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  let result: "ok" | "not_found";
  try {
    result = await saveDraftHtml(slug, body.html);
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  if (result === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Fresh token so the client can reload the preview frame immediately.
  return NextResponse.json({ slug, hasDraft: true, previewUrl: draftPreviewUrl(slug) });
}

// POST = publish: validate the draft and atomically swap it into the live bytes.
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const denied = await gate(req, slug);
  if (denied) return denied;

  let result: Awaited<ReturnType<typeof publishDraft>>;
  try {
    result = await publishDraft(slug);
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  if (!result.ok) {
    if (result.reason === "invalid") {
      return NextResponse.json(
        { error: "invalid_deck", issues: result.issues, warnings: result.warnings },
        { status: 422 },
      );
    }
    if (result.reason === "no_draft") {
      return NextResponse.json({ error: "no_draft" }, { status: 409 });
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ slug, warnings: result.warnings });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const denied = await gate(req, slug);
  if (denied) return denied;

  let result: "ok" | "not_found";
  try {
    result = await discardDraft(slug);
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  if (result === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ slug });
}
