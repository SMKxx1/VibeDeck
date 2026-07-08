// CSRF hardening: an Origin-vs-Host check for presenter-authenticated,
// state-changing endpoints. Server-only (reads request headers + NODE_ENV).
//
// WHY THIS IS NEEDED (the non-obvious part). The presenter's session cookie is
// SameSite=Lax (lib/auth.ts / app/api/login). SameSite=Lax blocks cross-SITE
// requests but NOT cross-origin requests that are still SAME-SITE — and a
// subdomain of the same registrable domain is "same-site" per the cookie spec.
// Untrusted deck HTML is now served from a genuinely separate ORIGIN
// (middleware.ts + app/d-content/[id]/route.ts, closing architecture finding
// F1), and the planned production deck host is a SUBDOMAIN of the app's own
// domain (e.g. decks.wss-lodge.com under wss-lodge.com). That subdomain is
// same-site, so a Lax cookie IS still attached to a fetch() the deck page makes
// back to the app. Origin isolation alone therefore does NOT stop a compromised
// deck from firing a credentialed
//   fetch('https://wss-lodge.com/api/admin/publish', { credentials: 'include' })
// that rides the presenter's live session. This Origin check closes that gap by
// requiring the browser-attested Origin to match the app's own origin.
// (Today's dev test used a deck host on a *different* registrable domain, where
// Lax already blocks the cookie, so this exact gap isn't exercised yet — but the
// code must be correct for the planned same-site-subdomain production topology.)
//
// WHY Origin-vs-Host, and DELIBERATELY NOT an env var (e.g. APP_ORIGIN). An env
// var must be set correctly in every environment (it is unset in prod today) and
// both failure modes are harmful: fail-closed on missing config blocks every
// request, fail-open allows every request. Deriving the expected origin from the
// request's OWN Host header is self-consistent in every environment with zero
// new configuration — the request states which host it believes it's talking to,
// and we require the browser's Origin header to agree. This matches how the app
// already trusts the Host header directly (middleware.ts compares it to
// DECK_HOST); we introduce no new, separately-configured source of truth.
//
// WHY an ABSENT Origin is ALLOWED through, not blocked. Browsers reliably send
// Origin on state-changing fetch/XHR/form-POST from a page, so its absence means
// a non-browser client (curl, scripts — this app is manually tested that way) or
// an ancient browser. CSRF is specifically a browser-mediated attack, so "no
// Origin" is not the vector this closes; failing closed on absence would only
// break legitimate tooling for no security benefit.

// Expected scheme, mirroring the app's existing prod/dev split — the same
// predicate that decides the session cookie's `secure` flag
// (app/api/login/route.ts: secure: process.env.NODE_ENV === "production").
// Railway serves the app over https in production; local `next dev` is http. We
// deliberately do NOT consult x-forwarded-proto: no other part of the app reads
// forwarded headers (middleware.ts trusts the raw Host header), so honoring one
// here would add a new, untested trust assumption instead of staying consistent.
const EXPECTED_SCHEME = process.env.NODE_ENV === "production" ? "https" : "http";

/**
 * True if the request may proceed: either it carries no Origin header (a
 * non-browser client — not a CSRF vector) or its Origin matches the app's own
 * origin reconstructed from this request's Host header. False only when a
 * browser-attested Origin does NOT match — the cross-origin write to reject.
 *
 * Call this FIRST in a state-changing presenter handler, before body parsing,
 * auth checks, or business logic — it's cheap and fails fast.
 */
export function assertSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser client — see file header for why we allow

  const host = req.headers.get("host");
  if (!host) return false; // Origin present but no Host to compare against — reject

  return origin === `${EXPECTED_SCHEME}://${host}`;
}
