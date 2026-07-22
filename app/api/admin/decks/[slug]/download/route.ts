import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, getSession } from "@/lib/auth";
import { checkDeckManage } from "@/lib/deck-authz";
import { getUploadedDeckHtml } from "@/lib/uploaded-decks";
import { renderUploadedDeckHtml } from "@/lib/deck-runtime";
import { getAsset, listAssets } from "@/lib/deck-assets";

// Owner-gated DOWNLOAD (GET) — hand back a fully self-contained, offline-capable
// copy of an uploaded deck for low-bandwidth / offline use. This DELIBERATELY
// bypasses the publish gate that /d-content enforces (it serves an 'unpublished'
// deck's bytes too), so it MUST NOT be public: gate with an authenticated session
// (401) + OWNERSHIP (checkDeckManage → 404 on !ok, admin or the deck's owner
// only; indistinguishable from a missing slug). No CSRF check: this is a read-only
// GET navigation, not a state change — assertSameOrigin guards WRITES, and a file
// download triggered by window.location can't send custom headers anyway.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function currentSession() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return getSession(token);
}

// Matches a src attribute pointing at THIS deck's vault: root-relative or
// absolute (any origin prefix) /d-assets/<slug>/<64-hex-hash>. The slug is
// interpolated but its charset is [a-z0-9-] (SLUG_RE at upload time), so it is
// regex-inert. Captures: quote, hash, closing quote.
function assetRefRe(slug: string): RegExp {
  return new RegExp(
    `(src=["'])(?:https?://[^"']*)?/d-assets/${slug}/([a-f0-9]{64})(["'])`,
    "g",
  );
}

// Defensive ceiling on the offline-inline size: every referenced vault asset is
// base64'd into ONE in-memory HTML string, so a photo-heavy deck (many ~10MB
// images) could spike hundreds of MB on the single instance. Measured in STORED
// bytes (byte_size); base64 inflates ~4/3, so 150MB of assets → a ~200MB string.
const MAX_INLINE_TOTAL_BYTES = 150 * 1024 * 1024; // 150MB of stored asset bytes

// Signals the referenced assets exceed MAX_INLINE_TOTAL_BYTES — the GET handler
// maps it to 413 instead of building the giant string.
class DeckTooLargeError extends Error {}

// Replace every vault reference with a data: URI of the stored bytes. Two
// passes: collect the unique hashes and read each ONCE (an image reused across
// slides costs one query), then a synchronous replace from the map.
async function inlineDeckAssets(html: string, slug: string): Promise<string> {
  const re = assetRefRe(slug);
  const hashes = new Set<string>();
  for (const m of html.matchAll(re)) hashes.add(m[2]);
  if (hashes.size === 0) return html;

  // OOM guard: sum the referenced assets' stored sizes from the metadata-only
  // listing (NO bytes loaded) and bail before inlining anything if the offline
  // bundle would be oversized. Fail-open [] from listAssets just skips the guard
  // (getAsset then fails closed per-asset), so a DB blip can't false-positive.
  const sizes = new Map((await listAssets(slug)).map((a) => [a.hash, a.byteSize] as const));
  let total = 0;
  for (const hash of hashes) total += sizes.get(hash) ?? 0;
  if (total > MAX_INLINE_TOTAL_BYTES) throw new DeckTooLargeError();

  const dataUris = new Map<string, string>();
  for (const hash of hashes) {
    const asset = await getAsset(slug, hash); // fail-closed null → keep the URL
    if (asset) {
      dataUris.set(hash, `data:${asset.contentType};base64,${asset.bytes.toString("base64")}`);
    }
  }

  return html.replace(re, (whole, open: string, hash: string, close: string) => {
    const uri = dataUris.get(hash);
    return uri ? `${open}${uri}${close}` : whole;
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { slug } = await params;

  // Ownership before we read any bytes: a non-owner (or a registry/missing slug)
  // gets a flat 404 and learns nothing about the deck.
  const perm = await checkDeckManage(session, slug);
  if (!perm.ok) {
    return NextResponse.json({ error: perm.error }, { status: perm.status });
  }

  // Only uploaded decks have stored html — a registry/missing slug (or a DB blip)
  // is null → 404, same fail-closed contract as /d-content.
  const row = await getUploadedDeckHtml(slug);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Serve the SAME serve-time transform /d-content uses (lib/deck-runtime), so the
  // downloaded file is a complete deck with the platform runtime inlined — it opens
  // and presents straight off disk, with no network and no separate runtime.
  let renderedHtml = await renderUploadedDeckHtml(row.html);

  // TRUE offline: inline THIS deck's Asset Vault images as data: URIs. Off disk
  // there is no deck origin to resolve /d-assets/<slug>/<hash> against, so each
  // referenced asset's stored bytes are fetched from the vault at download time
  // and swapped into the src. Best-effort per reference — an asset that can't be
  // read (deleted, DB blip) keeps its original URL (still fine online) rather
  // than failing the download. Only this slug's own assets are inlined.
  try {
    renderedHtml = await inlineDeckAssets(renderedHtml, slug);
  } catch (err) {
    if (err instanceof DeckTooLargeError) {
      return NextResponse.json({ error: "deck_too_large_to_export" }, { status: 413 });
    }
    throw err;
  }

  return new NextResponse(renderedHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}.html"`,
      "Cache-Control": "no-store",
    },
  });
}
