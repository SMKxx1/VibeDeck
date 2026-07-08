import { readFile } from "fs/promises";
import path from "path";

// Serves untrusted deck HTML on the isolated deck origin (see middleware.ts).
// This route is only ever reachable when the request arrives on DECK_HOST — the
// root middleware 404s /d-content/* on every other host. So the security story
// is: separate origin + the locked-down CSP below = the deck can't touch the
// real app.
//
// PLACEHOLDER FOR PHASE 1: this validation-pass version ignores [id] entirely
// and always serves the one existing static deck straight off disk, purely so
// there is real HTML to prove the serving+isolation mechanism end-to-end. The
// final version will look up deck HTML by id from the database (the kind/html
// column that Phase 1 will add). Do not build Phase 1 here.

// fs/promises forces the Node.js runtime — fine for a route handler (only the
// middleware must stay Edge-safe).
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
// are allowed because the deck HTML is self-contained inline content.
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
].join("; ");

// Read the existing static deck once per request off disk. Temporary: [id] is
// ignored (see header note) — every id serves this same file for now.
const DECK_HTML_PATH = path.join(
  process.cwd(),
  "public",
  "decks",
  "build-host-website",
  "index.html",
);

export async function GET() {
  const html = await readFile(DECK_HTML_PATH, "utf-8");
  return new Response(html, {
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
