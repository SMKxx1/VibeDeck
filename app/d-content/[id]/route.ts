import { getUploadedDeckHtml } from "@/lib/uploaded-decks";
import { verifyPreviewToken } from "@/lib/auth";
import { renderUploadedDeckHtml } from "@/lib/deck-runtime";

// Serves untrusted deck HTML on the isolated deck origin (see middleware.ts).
// This route is only ever reachable when the request arrives on DECK_HOST — the
// root middleware 404s /d-content/* on every other host. So the security story
// is: separate origin + the locked-down CSP below = the deck can't touch the
// real app.
//
// `[id]` IS the deck slug directly — no separate opaque content-id is needed
// because origin isolation + the CSP already contain the content, so the slug
// carries no authority on its own. We look the row up in the DB (kind='uploaded'
// only) and serve its stored html. A missing slug, or a slug that exists but is
// a registry deck, is a BARE 404 — indistinguishable, so this route can't be
// used to probe whether any registry slug exists.

// Node.js runtime: the DB layer (pg) is Node-only. Only the middleware must stay
// Edge-safe.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// APP_ORIGIN is the ONLY origin permitted to frame this content (the main app
// embedding a deck in its sandboxed iframe). Read from env — differs per
// environment (prod apex vs dev). FAIL CLOSED if unset: 'none' means nothing
// may frame it at all, which is strictly safer than omitting frame-ancestors
// (omitting would fall back to same-origin, i.e. only the deck host itself, but
// being explicit and closed here avoids any ambiguity if this is misdeployed).
const APP_ORIGIN = process.env.APP_ORIGIN;
const frameAncestors = APP_ORIGIN ? APP_ORIGIN : "'none'";

// Strict, exfiltration-resistant CSP. default-src 'none' denies everything not
// re-granted below. connect-src 'none' + webrtc 'block' kill network exfil
// paths (fetch/XHR/beacon and the WebRTC side-channel). base-uri/form-action
// 'none' block base-tag and form-based redirection tricks. Inline script/style
// are allowed because the deck HTML is self-contained inline content. The
// `sandbox` directive is defense-in-depth ON TOP of the iframe's sandbox
// attribute: it forces the sandbox even if the frame is ever loaded outside our
// iframe (opened directly, or framed with a laxer attribute), and — by granting
// allow-scripts but NOT allow-same-origin — keeps the document in an opaque
// origin with no access to any cookie/storage bucket, so stored deck HTML can
// never reach back into an app origin it might otherwise share a site with.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'self'",
  "style-src 'unsafe-inline' 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  `frame-ancestors ${frameAncestors}`,
  "base-uri 'none'",
  "form-action 'none'",
  "webrtc 'block'",
  "sandbox allow-scripts",
].join("; ");

// A bare 404 with no body — the ONLY signal this route ever gives about a slug
// it won't serve, so "doesn't exist", "is a registry deck", "is unpublished with
// no valid token", and "DB is down" are all indistinguishable from outside.
function notFound(): Response {
  return new Response(null, { status: 404 });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: slug } = await params;

  // Fail CLOSED: null means missing, a registry slug, OR the DB is unreachable.
  // Unlike the fail-OPEN isDeckViewable() path for registry decks (whose whole
  // point is to keep the live site up during a DB blip), serving untrusted stored
  // content has no such urgency — a DB outage here simply serves nothing.
  const row = await getUploadedDeckHtml(slug);
  if (!row) return notFound();

  // Publish gate. 'main'/'normal' serve normally. 'unpublished' serves ONLY when
  // a valid preview token (?t=) proves the requester is a presenter who minted it
  // for THIS slug and it hasn't expired — the DECK_ORIGIN has no session cookie,
  // so the signed token is the only authority that reaches this far. Any other
  // status value (should be impossible given the CHECK constraint) also 404s.
  if (row.publishStatus === "unpublished") {
    const token = new URL(req.url).searchParams.get("t");
    if (!verifyPreviewToken(token, slug)) return notFound();
  } else if (row.publishStatus !== "main" && row.publishStatus !== "normal") {
    return notFound();
  }

  // Inline-inject the shared platform runtime (lib/deck-runtime) so the deck
  // renders and reports slide changes without shipping its own engine.
  const body = await renderUploadedDeckHtml(row.html);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cache-Control": "no-store",
    },
  });
}
