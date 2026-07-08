import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Origin isolation for untrusted deck HTML (architecture review finding F1).
//
// A same-origin iframe sandbox does NOT protect the main app: anyone can open
// the raw deck URL directly and, being same-origin, inherit full authority over
// the real site — admin APIs, and any future BYO API keys parked in
// localStorage. The only real boundary is a genuinely separate browser origin.
// So we bind untrusted deck content to a dedicated host (DECK_HOST) and, on that
// host, expose NOTHING except the deck-content route. Everything else 404s.
//
// This is enforced as a DEFAULT-DENY ALLOWLIST, not a blocklist of "sensitive"
// routes: on the deck host, the ONLY thing that survives is /d-content/*. A new
// API route added next year is unreachable here by construction — no one has to
// remember to add it to a list. That property is the whole point; do not turn
// this into "if path is /api or /login, 404".
//
// Kept deliberately minimal and free of Node-only APIs so it runs on the Edge
// runtime with no surprises. The actual file read lives in the route handler,
// which opts into the Node runtime.

// No hardcoded default. If DECK_HOST is unset we treat it as "no deck host
// configured" and the deck-host branch below can never match — so /d-content/*
// fails closed (404) on every host until infra sets this. That is intentional:
// a missing config must not silently expose deck content on the app origin.
const DECK_HOST = process.env.DECK_HOST;

// Normalize a Host header for comparison: lowercase, and drop any trailing
// ":port" (Railway/local dev often carry one, e.g. "decks.test.local:3000").
// IPv6 literals in Host are bracketed ("[::1]:3000"), so only strip a port that
// follows the last colon when there is no bracket to confuse it — for our
// hostname-vs-hostname equality this simple form is sufficient and safe.
function normalizeHost(host: string | null): string {
  if (!host) return "";
  const lower = host.toLowerCase().trim();
  // Bracketed IPv6 — leave the bracketed part intact, strip a port after "]".
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end === -1 ? lower : lower.slice(0, end + 1);
  }
  const colon = lower.lastIndexOf(":");
  return colon === -1 ? lower : lower.slice(0, colon);
}

export function middleware(req: NextRequest) {
  const host = normalizeHost(req.headers.get("host"));
  const isDeckContent = req.nextUrl.pathname.startsWith("/d-content/");

  // Deck host: allowlist. ONLY /d-content/* survives; everything else — every
  // /api/*, /login, /dashboard, /d/* — is a bare 404 by construction.
  if (DECK_HOST && host === DECK_HOST) {
    if (isDeckContent) return NextResponse.next();
    return new NextResponse(null, { status: 404 });
  }

  // Any other host (including the real app host, and including the no-DECK_HOST
  // fail-closed case): deck content must NEVER be reachable on the app's origin,
  // or we'd have re-created the very same-origin exposure F1 is about. 404 it.
  // Everything else on the app host passes through untouched.
  if (isDeckContent) return new NextResponse(null, { status: 404 });
  return NextResponse.next();
}

// Match everything EXCEPT Next's own internal static/image assets and the
// favicon. Crucially this DOES cover /api/* — the whole design depends on API
// routes being gated on the deck host. We intentionally do NOT use Next's
// stock "exclude anything with a file extension" matcher: that would silently
// stop gating asset-looking paths and give a false sense that the matcher
// narrows scope. Scope is decided by the host/path logic above, not the matcher.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
