import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, getSession, type Session } from "@/lib/auth";
import { checkDeckManage } from "@/lib/deck-authz";
import { assertSameOrigin } from "@/lib/csrf";
import {
  putAsset,
  listAssets,
  UnsupportedImageError,
  MAX_RAW_BYTES,
} from "@/lib/deck-assets";

// Deck Asset Vault — the owner-gated write/list surface for a deck's images.
//   POST → raw image bytes as the request body (NOT multipart — undici's
//          formData parser throws on multi-MB bodies; the Content-Type header
//          is advisory only, sharp sniffs the real bytes): normalize/compress
//          the image (lib/deck-assets putAsset — EXIF stripped, re-encoded
//          WebP, ≤10MB stored, dedupe by content hash) and return its vault
//          address.
//   GET  → asset metadata for the Workbench picker (never bytes).
//
// Gate order on BOTH methods (same idiom as ../draft/route.ts): authenticated
// session (401) → CSRF (403) → OWNERSHIP (checkDeckManage: admin, or the
// presenter who owns this deck; else 404, indistinguishable from a missing
// slug) → kind check (only uploaded decks reference vault assets; a registry
// slug is the same 404).
//
// SIZE POLICY (owner's decision): NO total-storage or per-deck count cap. The
// only limits are the 50MB RAW ceiling here (rejected 413 before buffering,
// via Content-Length, so a large original still has headroom to compress) and
// the ≤10MB STORED cap that putAsset's compression enforces.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function currentSession() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return getSession(token);
}

// Shared gate for both methods: session → CSRF → ownership → uploaded-only.
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
  // Only uploaded decks carry vault assets. A registry slug gets the same 404
  // as a missing/foreign one — this route never confirms registry slugs exist.
  if (perm.kind !== "uploaded") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return null;
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const denied = await gate(req, slug);
  if (denied) return denied;

  // Metadata only, never bytes — fail-open [] on a DB blip (the picker just
  // shows nothing; nothing here is a mutation).
  const assets = await listAssets(slug);
  return NextResponse.json({ assets });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const denied = await gate(req, slug);
  if (denied) return denied;

  // Content-Length ceiling BEFORE buffering the body — same reasoning as the
  // upload/replace/draft routes (App Router handlers have no built-in body
  // limit; reject an oversized or header-less request from the raw header).
  // The ceiling has a little headroom over the raw cap, and the actual bytes
  // are re-checked below after buffering.
  const lenHeader = req.headers.get("content-length");
  const len = lenHeader === null ? NaN : Number(lenHeader);
  if (!Number.isFinite(len) || len <= 0 || len > MAX_RAW_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  // The body IS the image — no multipart envelope (undici's formData parser
  // throws on multi-MB uploads, which broke the whole feature). Buffer it and
  // enforce the raw cap on the bytes we actually received.
  const input = Buffer.from(await req.arrayBuffer());
  if (input.length === 0) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }
  if (input.length > MAX_RAW_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  // putAsset: decode → strip metadata → compress to ≤10MB → content-address →
  // dedupe. The declared MIME type is deliberately ignored — sharp sniffs the
  // real bytes, and everything stored is our own re-encoded WebP.
  try {
    const asset = await putAsset(slug, input);
    return NextResponse.json(
      {
        hash: asset.hash,
        url: asset.url,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof UnsupportedImageError) {
      // Not an image / undecodable / can't fit the cap — the client's problem.
      return NextResponse.json({ error: "unsupported_image" }, { status: 415 });
    }
    // A write that failed is a DB problem — surface it, never fake success.
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
}
