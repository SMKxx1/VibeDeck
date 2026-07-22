import { getAsset } from "@/lib/deck-assets";

// Serves Deck Asset Vault image bytes on the ISOLATED deck origin — this route
// is only ever reachable when the request arrives on DECK_HOST (the root
// middleware's default-deny allowlist admits /d-assets/* there and 404s it on
// every other host, exactly like /d-content/*). A deck references these as
// root-relative <img src="/d-assets/<slug>/<hash>">, which resolves against
// the deck origin inside the sandboxed frame — 'self' under the deck CSP's
// "img-src 'self' data:", so no CSP change was needed. This route serves BYTES
// only, never HTML, so the deck CSP itself does not apply here; nosniff + the
// stored image content-type keep it un-renderable as anything else.
//
// AUTHZ MODEL (deliberate): the unguessable sha256 hash IS the capability. The
// sandboxed deck frame runs in an OPAQUE origin with no cookie/storage, so an
// <img> it loads can never carry a session token — the only workable gate is
// an unguessable URL, the same way user media is conventionally served. The
// hash is only ever revealed to the deck owner (the owner-gated upload/list
// route) and to whoever the owner shows the deck to.
//
// Cache-Control is IMMUTABLE and safe to be: the URL is content-addressed
// (hash of the stored bytes), so the bytes behind a given URL can never change.

export const runtime = "nodejs"; // the DB layer (pg) is Node-only
export const dynamic = "force-dynamic";

// Cheap shape gate before touching the DB: a real hash is exactly 64 lowercase
// hex chars. Anything else can't exist and 404s without a query.
const HASH_RE = /^[a-f0-9]{64}$/;

// A bare 404 with no body — "no such asset", "no such deck", "DB down" are all
// indistinguishable from outside, same contract as /d-content.
function notFound(): Response {
  return new Response(null, { status: 404 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; hash: string }> },
) {
  const { slug, hash } = await params;
  if (!HASH_RE.test(hash)) return notFound();

  // Fail CLOSED: null on miss AND on any DB error (lib/deck-assets getAsset) —
  // serving untrusted stored content never degrades to serving something else.
  const asset = await getAsset(slug, hash);
  if (!asset) return notFound();

  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.byteSize),
      "X-Content-Type-Options": "nosniff",
      // The prod deck HTML runs in a sandboxed (no allow-same-origin) frame, so
      // its <img> requests originate from an OPAQUE origin — a "same-origin"
      // CORP check would block every vault image. "cross-origin" is safe here:
      // the unguessable sha256 in the URL is the capability, nosniff pins the
      // type, and immutable content-addressed caching is unaffected.
      "Cross-Origin-Resource-Policy": "cross-origin",
      // Content-addressed URL → the bytes can never change → cache forever.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
