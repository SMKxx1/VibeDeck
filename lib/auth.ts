// Presenter authentication (server-only). The presenter signs in at /login with
// an env-configured password; on success we set an HMAC-signed session cookie.
// Viewers never authenticate — they just pick a name.
//
// This is a lightweight gate for a classroom/workshop tool, not a bank: one
// shared presenter credential, a signed stateless cookie. Keep AUTH_SECRET and
// PRESENTER_PASSWORD out of the client bundle (this module is server-only).

import crypto from "crypto";

export const AUTH_COOKIE = "presenter_session";
const MAX_AGE_SECONDS = 60 * 60 * 12; // a session lasts a workday

function secret(): string {
  return process.env.AUTH_SECRET || "dev-insecure-secret-change-me";
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Check the presenter credentials against env (with a documented dev default). */
export function checkPresenterCredentials(username: string, password: string): boolean {
  const u = process.env.PRESENTER_USERNAME || "presenter";
  const p = process.env.PRESENTER_PASSWORD || "present"; // dev default — override in env
  if (!password) return false;
  // Constant-time-ish compare on the password.
  const pw = Buffer.from(password);
  const expected = Buffer.from(p);
  const okPw = pw.length === expected.length && crypto.timingSafeEqual(pw, expected);
  return username === u && okPw;
}

// The payload carries an explicit schema version `v` so the token shape can grow
// without touching the 8 boolean gates that call verifySessionToken: the
// discriminator lives inside the signed token, not in the function signature.
// `v: 1` is the shape this change mints. Tokens minted before versioning had no
// `v` field at all — we treat "missing v" as implicit legacy version 0 and apply
// the exact old claims rule, so presenters logged in across the deploy keep their
// session until it ages out (<=12h). A future `v: 2` (e.g. adding userId) becomes
// a new `case` here plus a widened claims type — not a rewrite of any caller.

/** Mint a signed session token: base64url(payload).signature — payload is v:1. */
export function createSessionToken(): string {
  const payload = b64url(JSON.stringify({ v: 1, role: "presenter", iat: Date.now() }));
  return `${payload}.${sign(payload)}`;
}

/** Verify a session token: valid signature, presenter role, not expired. */
export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Signature check is unchanged and runs FIRST: legacy and new tokens are both
  // cryptographically bound before we ever inspect claims. We only teach the
  // claims validator two shapes; we do not weaken the crypto layer.
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      v?: number;
      role?: string;
      iat?: number;
    };
    // Shared claims rule (identical to the pre-versioning logic).
    const claimsOk =
      data.role === "presenter" &&
      typeof data.iat === "number" &&
      Date.now() - data.iat <= MAX_AGE_SECONDS * 1000;
    switch (data.v) {
      case undefined: // implicit legacy version 0 — no `v` was ever written before this change
      case 1:
        return claimsOk;
      default: // any version this build doesn't understand (future v, or garbage)
        return false;
    }
  } catch {
    return false;
  }
}

export const SESSION_MAX_AGE = MAX_AGE_SECONDS;

// Preview tokens: a short-lived capability that lets a presenter view an
// 'unpublished' uploaded deck on the isolated DECK_ORIGIN, where there is NO
// session cookie to authenticate against (that content lives on a genuinely
// separate origin — see middleware.ts / lib/csrf.ts). The token is the ONLY
// thing that opens the fail-closed /d-content gate for unpublished content, so
// it MUST be unforgeable and MUST expire. We reuse the exact HMAC mechanism the
// session cookie uses (secret() + sign() above) rather than inventing a second
// signing scheme — one secret, one construction, one place to reason about.
const PREVIEW_MAX_AGE_MS = 5 * 60 * 1000; // ~5 minutes: long enough to click, short enough to not linger

/**
 * Mint a signed preview token binding a specific slug to an expiry. Shape mirrors
 * the session token: base64url(payload).signature. The slug is INSIDE the signed
 * payload so a token minted for deck A can never be replayed against deck B.
 */
export function createPreviewToken(slug: string): string {
  const payload = b64url(JSON.stringify({ slug, exp: Date.now() + PREVIEW_MAX_AGE_MS }));
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a preview token: valid signature, not expired, and bound to exactly the
 * slug being requested. Any failure returns false — this is the gate that lets
 * untrusted-content serving fail closed, so it must never throw or fuzzy-match.
 */
export function verifyPreviewToken(token: string | undefined | null, slug: string): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Signature FIRST, timing-safe — same discipline as verifySessionToken: bind
  // the token cryptographically before trusting any claim inside it.
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      slug?: string;
      exp?: number;
    };
    return (
      data.slug === slug &&
      typeof data.exp === "number" &&
      Date.now() < data.exp
    );
  } catch {
    return false;
  }
}
