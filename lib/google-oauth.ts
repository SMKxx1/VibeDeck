// Google OAuth (server-only). Authorization-Code flow, hand-rolled: we build the
// auth URL ourselves, exchange the code server-to-server (the client secret
// never leaves this module), and verify the returned id_token against Google's
// JWKS with `jose`. No client SDK, no implicit flow, no access-token use — the
// id_token IS the product; we never call Google APIs on the user's behalf.
//
// Env (ALL optional — the feature degrades to "button disabled / start 503s"):
//   GOOGLE_CLIENT_ID      — the OAuth client id (aud of the id_token)
//   GOOGLE_CLIENT_SECRET  — server-only; used ONLY in the code exchange
// Both are read at CALL time, never at import/build time (house rule: missing
// env must never throw during a build).
//
// The redirect URI is DERIVED from each request's own Host header
// (`${origin}/api/auth/google/callback`) rather than configured, so the same
// code serves dev + prod apex + www — the same self-consistency argument as
// lib/csrf.ts assertSameOrigin (which also trusts Host, with the same
// NODE_ENV-driven scheme). Every origin in use must simply be registered as an
// authorized redirect URI in the Google console; Google rejects unregistered
// ones, so a spoofed Host cannot redirect a code anywhere useful.

import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
// Google's `iss` is documented as either form; accept both.
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// The state/nonce cookies live only under the OAuth routes (start sets them,
// callback consumes them) — path-scoping keeps them off every other request.
export const OAUTH_COOKIE_PATH = "/api/auth/google";
export const STATE_COOKIE = "g_oauth_state";
export const NONCE_COOKIE = "g_oauth_nonce";
export const OAUTH_COOKIE_MAX_AGE = 60 * 10; // 10 min to complete the Google hop

export function googleClientId(): string | null {
  return process.env.GOOGLE_CLIENT_ID || null;
}

function googleClientSecret(): string | null {
  return process.env.GOOGLE_CLIENT_SECRET || null;
}

/** True when BOTH halves are set — start refuses early rather than stranding the
 * user at a callback that can't complete the code exchange. */
export function isGoogleConfigured(): boolean {
  return !!(googleClientId() && googleClientSecret());
}

/**
 * The app origin as this request sees it: Host header + the same
 * NODE_ENV-driven scheme lib/csrf.ts uses (Railway terminates TLS, so the
 * request itself arrives as http in prod; x-forwarded-proto is deliberately not
 * consulted — no other part of the app trusts forwarded headers).
 */
export function deriveOrigin(req: Request): string {
  const host = req.headers.get("host") ?? "localhost:3000";
  const scheme = process.env.NODE_ENV === "production" ? "https" : "http";
  return `${scheme}://${host}`;
}

export function redirectUriFor(origin: string): string {
  return `${origin}/api/auth/google/callback`;
}

/** The Google consent-screen URL for one sign-in attempt. */
export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("access_type", "online"); // no refresh token — we only want the id_token
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  return url.toString();
}

/**
 * Exchange an authorization code for the id_token (server-to-server; this is
 * where the client secret is spent). null on any failure — the callback maps
 * that to a clean ?error= redirect, never a throw.
 */
export async function exchangeCode(code: string, redirectUri: string): Promise<string | null> {
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret) return null;
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
    if (!res.ok || typeof body?.id_token !== "string") {
      console.error("[google-oauth] code exchange failed:", res.status);
      return null;
    }
    return body.id_token;
  } catch (err) {
    console.error("[google-oauth] code exchange threw:", err);
    return null;
  }
}

// Lazy module-level JWKS: jose caches the fetched keys and refreshes on
// unknown-kid, so one instance serves every verification. Created on first use
// (never at import time — no network/env work during a build).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) jwks = createRemoteJWKSet(new URL(JWKS_URL));
  return jwks;
}

export interface GoogleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Verify an id_token: signature against Google's JWKS, issuer, audience (our
 * client id), exp (jose enforces it), and the nonce claim against the value we
 * parked in the nonce cookie (replay guard — a captured id_token can't be
 * replayed into a different sign-in attempt). Returns the claims we act on, or
 * null on ANY failure. email_verified is returned, not enforced, so the caller
 * can show a distinct "verify your email" message.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expectedNonce: string,
): Promise<GoogleIdentity | null> {
  const clientId = googleClientId();
  if (!clientId) return null;
  try {
    const { payload } = await jwtVerify(idToken, getJwks(), {
      issuer: ISSUERS,
      audience: clientId,
    });
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (typeof payload.nonce !== "string" || payload.nonce !== expectedNonce) return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" ? payload.name : null,
    };
  } catch (err) {
    console.error("[google-oauth] id_token verification failed:", err);
    return null;
  }
}
