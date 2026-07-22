import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authSecretConfigError } from "./lib/config";

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
// routes: on the deck host, the ONLY things that survive are /d-content/* (the
// deck HTML) and /d-assets/* (the Deck Asset Vault's image bytes, which the
// deck's strict CSP loads as same-origin 'self'). A new API route added next
// year is unreachable here by construction — no one has to remember to add it
// to a list. That property is the whole point; do not turn this into "if path
// is /api or /login, 404".
//
// Kept deliberately minimal and free of Node-only APIs so it runs on the Edge
// runtime with no surprises. The actual file read lives in the route handler,
// which opts into the Node runtime.

// No hardcoded default. If DECK_HOST is unset we treat it as "no deck host
// configured" and the deck-host branch below can never match — so /d-content/*
// fails closed (404) on every host until infra sets this. That is intentional:
// a missing config must not silently expose deck content on the app origin.
const DECK_HOST = normalizeHost(process.env.DECK_HOST ?? null);

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
  // A weak signing key is an authentication bypass, not a warning. Enforce this
  // at the request boundary as well as in lib/auth so a bad production deploy is
  // visibly unhealthy even before somebody attempts to sign in.
  if (authSecretConfigError()) {
    return new NextResponse(null, {
      status: 503,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }

  const host = normalizeHost(req.headers.get("host"));
  const pathname = req.nextUrl.pathname;
  // The deck-host allowlist: untrusted deck HTML and its vault-served images.
  const isDeckServing =
    pathname.startsWith("/d-content/") || pathname.startsWith("/d-assets/");

  // Deck host: allowlist. ONLY /d-content/* and /d-assets/* survive; everything
  // else — every /api/*, /login, /dashboard, /d/* — is a bare 404 by construction.
  if (DECK_HOST && host === DECK_HOST) {
    if (isDeckServing) return NextResponse.next();
    return new NextResponse(null, { status: 404 });
  }

  // Any other host (including the real app host, and including the no-DECK_HOST
  // fail-closed case): deck content (and deck assets) must NEVER be reachable on
  // the app's origin, or we'd have re-created the very same-origin exposure F1
  // is about. 404 it. Everything else on the app host passes through untouched.
  if (isDeckServing) return new NextResponse(null, { status: 404 });

  // Central request-body ceiling (DoS guard). next.config.mjs sets
  // experimental.middlewareClientMaxBodySize="55mb" GLOBALLY — needed so the
  // Deck Asset Vault upload routes can receive multi-MB images — but that cap
  // applies to EVERY /api/* route this middleware matches. Without a ceiling
  // here, any anonymous viewer POST (/api/ask, /api/poll/vote, /api/login, ...)
  // could stream up to 55MB into the Node heap before the handler's req.json()
  // even runs; a few dozen concurrent 55MB bodies would OOM-kill the single
  // Railway instance. So we apply the same DEFAULT-DENY ALLOWLIST philosophy to
  // body size: cap everyone at a small ceiling, and allowlist only the routes
  // that legitimately need large bodies. This is a best-effort header check — we
  // cannot read the body on Edge — that defeats the realistic
  // "Content-Length: 55000000" attack; the framework 55mb cap stays the
  // absolute backstop for chunked / mislabeled bodies.
  const MAX_BODY = 2 * 1024 * 1024; // 2MB — generous for every JSON route (largest legit viewer body is a short question).
  // Only the raw asset POST needs more than 2MB. Deck create/replace/import/draft
  // routes have much smaller handler limits and must not inherit the 55MB escape.
  const allowsLargeBody =
    req.method === "POST" && /^\/api\/admin\/decks\/[^/]+\/assets\/?$/.test(pathname);
  const rawLength = req.headers.get("content-length");
  const transferEncoding = req.headers.get("transfer-encoding");

  // Reject ambiguous request framing before a proxy/runtime disagreement can
  // become either a body-limit bypass or request-smuggling primitive.
  if (rawLength !== null && transferEncoding !== null) {
    return new NextResponse(null, { status: 400 });
  }

  let length: number | null = null;
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength)) return new NextResponse(null, { status: 400 });
    length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      return new NextResponse(null, { status: 400 });
    }
  }
  if (!allowsLargeBody && length !== null && length > MAX_BODY) {
    return new NextResponse(null, { status: 413 }); // Payload Too Large.
  }

  // All current API POST/PUT/PATCH handlers except these two parse a body. Requiring
  // its byte length closes the chunked/missing-header hole in the best-effort cap;
  // the two allowlisted POSTs are intentionally bodyless actions.
  const isBodyMethod = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
  const isBodylessAction =
    req.method === "POST" &&
    (pathname === "/api/logout" || /^\/api\/admin\/decks\/[^/]+\/duplicate\/?$/.test(pathname));
  if (pathname.startsWith("/api/") && isBodyMethod && !isBodylessAction && length === null) {
    return new NextResponse(null, { status: 411 });
  }

  return NextResponse.next();
}

// Match every path, including Next internals. Otherwise the supposedly
// default-deny deck host would still expose /_next/image and /_next/static.
// Scope is decided by the host/path logic above, not by matcher exceptions.
export const config = {
  matcher: ["/:path*"],
};
