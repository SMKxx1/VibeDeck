import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, SESSION_MAX_AGE, createSessionToken, type Role } from "@/lib/auth";
import {
  deriveOrigin,
  exchangeCode,
  redirectUriFor,
  verifyGoogleIdToken,
  NONCE_COOKIE,
  STATE_COOKIE,
  OAUTH_COOKIE_PATH,
} from "@/lib/google-oauth";
import { getIdentity, linkIdentity } from "@/lib/identities";
import { getUserByEmail, getUserById } from "@/lib/users";
import { createRequest } from "@/lib/account-requests";
import { notifyAccountRequest } from "@/lib/telegram";

// Google OAuth callback — step 2. Verifies state (CSRF), exchanges the code,
// verifies the id_token (signature/iss/aud/exp via jose + our nonce), REQUIRES
// email_verified === true, then routes on the stable `sub`:
//   (a) identity already linked            → mint session, /dashboard
//   (b) email already has a users row      → auto-link + mint session (an
//       invited presenter / the seeded admin adopting Google sign-in)
//   (c) unknown                            → park an account_requests row, ping
//       the owner on Telegram (best-effort), /login?pending=1 — NO session
//
// EVERY failure is a clean 302 to /login?error=<code> (never a stack trace),
// and the state/nonce cookies are cleared on every exit path — they are
// one-shot by design.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROD = () => process.env.NODE_ENV === "production";

function clearOauthCookies(res: NextResponse): void {
  for (const name of [STATE_COOKIE, NONCE_COOKIE]) {
    res.cookies.set(name, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: PROD(),
      path: OAUTH_COOKIE_PATH,
      maxAge: 0,
    });
  }
}

function toLogin(origin: string, params: Record<string, string>): NextResponse {
  const url = new URL("/login", origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  clearOauthCookies(res);
  return res;
}

// Mint the session exactly like app/api/login and land on the dashboard.
function toDashboard(origin: string, userId: string, role: Role): NextResponse {
  const res = NextResponse.redirect(new URL("/dashboard", origin));
  res.cookies.set(AUTH_COOKIE, createSessionToken(userId, role), {
    httpOnly: true,
    sameSite: "lax",
    secure: PROD(),
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  clearOauthCookies(res);
  return res;
}

export async function GET(req: NextRequest) {
  const origin = deriveOrigin(req);
  try {
    const params = req.nextUrl.searchParams;

    // The user said no (or Google errored) — not a fault, just a bounce home.
    if (params.get("error")) return toLogin(origin, { error: "google_denied" });

    // CSRF gate: the state Google echoes back must match the httpOnly cookie
    // set by /start. A missing/mismatched state means this callback was not
    // initiated by our own start route in this browser — reject.
    const code = params.get("code");
    const state = params.get("state");
    const stateCookie = req.cookies.get(STATE_COOKIE)?.value;
    const nonceCookie = req.cookies.get(NONCE_COOKIE)?.value;
    if (!code || !state || !stateCookie || state !== stateCookie || !nonceCookie) {
      return toLogin(origin, { error: "state_mismatch" });
    }

    const idToken = await exchangeCode(code, redirectUriFor(origin));
    if (!idToken) return toLogin(origin, { error: "google_failed" });

    const identity = await verifyGoogleIdToken(idToken, nonceCookie);
    if (!identity) return toLogin(origin, { error: "google_failed" });

    // NEVER trust an unverified email: Google asserts ownership only when
    // email_verified is true; anything else could be a claimed-but-unproven
    // address, which must not auto-link to an existing account (b) or park a
    // request the owner would approve on the strength of that address (c).
    if (!identity.emailVerified || !identity.email) {
      return toLogin(origin, { error: "email_not_verified" });
    }

    // (a) Known identity → sign in. Lookup is by the stable `sub`, never email.
    const linked = await getIdentity("google", identity.sub);
    if (linked) {
      const user = await getUserById(linked.userId);
      // A linked identity whose user row vanished (deleted account) — the
      // CASCADE in migration 010 should have reclaimed the link, but if the
      // read raced or the DB is degraded, fail to a clean error, not a session.
      if (!user) return toLogin(origin, { error: "google_failed" });
      return toDashboard(origin, user.id, user.role);
    }

    // (b) Known email → auto-link this Google identity to that account. Safe
    // because the address is Google-verified (above), so its owner IS this
    // person. linkIdentity is an idempotent write; a failure surfaces (never a
    // session on a half-linked state).
    const byEmail = await getUserByEmail(identity.email);
    if (byEmail) {
      const link = await linkIdentity("google", identity.sub, byEmail.id, identity.email);
      if (!link.ok) return toLogin(origin, { error: "server_error" });
      return toDashboard(origin, byEmail.id, byEmail.role);
    }

    // (c) Unknown → park an approval request. createRequest dedupes on the
    // partial unique index, returning the EXISTING pending row on a re-sign-in.
    const created = await createRequest({
      provider: "google",
      providerId: identity.sub,
      email: identity.email,
      name: identity.name,
    });
    if (!created.ok) return toLogin(origin, { error: "server_error" });

    // Notify the owner ONLY when no ping has landed yet (notifyChatId is set by
    // notifyAccountRequest itself on success). A deduped re-sign-in therefore
    // never re-pings; a request whose first ping failed (or predates Telegram
    // config) gets one retry per sign-in attempt — best-effort either way.
    if (created.request.notifyChatId === null) {
      await notifyAccountRequest(created.request);
    }
    return toLogin(origin, { pending: "1" });
  } catch (err) {
    console.error("[google-callback] failed:", err);
    return toLogin(origin, { error: "server_error" });
  }
}
