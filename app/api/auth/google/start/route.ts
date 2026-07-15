import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import {
  buildAuthUrl,
  deriveOrigin,
  googleClientId,
  isGoogleConfigured,
  redirectUriFor,
  NONCE_COOKIE,
  STATE_COOKIE,
  OAUTH_COOKIE_MAX_AGE,
  OAUTH_COOKIE_PATH,
} from "@/lib/google-oauth";

// "Sign in with Google" — step 1 of the Authorization-Code flow. Generates the
// state (CSRF guard: the callback only proceeds when the ?state Google echoes
// back matches this httpOnly cookie) and nonce (replay guard: bound INSIDE the
// signed id_token, checked against its own cookie), parks both in short-lived
// path-scoped cookies, and bounces to Google's consent screen.
//
// Unconfigured env → clean 503, never a throw: the login page's button is the
// primary guard (it renders disabled), this is the backstop for a direct hit.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isGoogleConfigured()) {
    return NextResponse.json({ error: "google_not_configured" }, { status: 503 });
  }

  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const origin = deriveOrigin(req);

  const res = NextResponse.redirect(
    buildAuthUrl({
      clientId: googleClientId()!,
      redirectUri: redirectUriFor(origin),
      state,
      nonce,
    }),
  );
  // sameSite lax on purpose: Google's redirect back to the callback is a
  // top-level GET navigation, which Lax cookies DO accompany — strict would
  // strand the callback without its state/nonce.
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_COOKIE_MAX_AGE,
  };
  res.cookies.set(STATE_COOKIE, state, cookieOpts);
  res.cookies.set(NONCE_COOKIE, nonce, cookieOpts);
  return res;
}
