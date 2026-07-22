// Presenter authentication (server-only). The presenter signs in at /login with
// an env-configured password; on success we set an HMAC-signed session cookie.
// Viewers never authenticate — they just pick a name.
//
// This is a lightweight gate for a classroom/workshop tool, not a bank: one
// shared presenter credential, a signed stateless cookie. Keep AUTH_SECRET and
// PRESENTER_PASSWORD out of the client bundle (this module is server-only).

import crypto from "crypto";
import { authSecretConfigError } from "./config";

export const AUTH_COOKIE = "presenter_session";
const MAX_AGE_SECONDS = 60 * 60 * 12; // a session lasts a workday

function secret(): string {
  const s = process.env.AUTH_SECRET;
  const configError = authSecretConfigError(s);
  if (configError) throw new Error(configError);
  if (s) return s;
  // FAIL CLOSED in production. Without AUTH_SECRET the HMAC key would be the
  // public default, so ANYONE could mint a validly-signed `{v:2, role:"admin"}`
  // cookie — total auth bypass (own/delete any deck, mint invites). A dev-only
  // default is acceptable locally where NODE_ENV !== "production".
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be set in production");
  }
  return "dev-insecure-secret-change-me";
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

// Exported for lib/telegram.ts callback tokens — one secret, one HMAC
// construction, one place to reason about (same reuse rationale as the preview
// tokens below). Callers MUST domain-separate their payloads: telegram signs
// strings containing '.'/':' which can never collide with the pure-base64url
// JSON payloads the session/preview tokens sign.
export function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

// NOTE: login no longer compares against an env password. The single shared
// PRESENTER_USERNAME/PRESENTER_PASSWORD are used ONCE, at boot, to SEED the admin
// row (lib/schema ensureAdminUser); every login thereafter is scrypt-verified
// against the users table (app/api/login). There is deliberately no env-credential
// code path here anymore.

// The payload carries an explicit schema version `v`. History:
//   v:0 — pre-versioning, no `v` field. {role:"presenter", iat}.
//   v:1 — {v:1, role:"presenter", iat}.
//   v:2 — {v:2, userId, role, iat} (Phase 4 accounts; role ∈ admin|presenter).
// The ~16 boolean gates call verifySessionToken (unchanged signature). Routes
// that need identity/authorization call getSession. Legacy v:0/v:1 cookies (no
// userId) are mapped to the ADMIN identity by getSession — the single shared
// presenter of the pre-accounts era WAS the admin, so existing sessions keep full
// access with no forced re-login. The signature is HMAC over the whole payload,
// so a tampered role/userId or a version downgrade fails without AUTH_SECRET.

export type Role = "admin" | "presenter";
export interface Session {
  // null only for a legacy (v<2) cookie mapped to the admin — it has no user row.
  userId: string | null;
  role: Role;
}

/** Mint a v:2 session token binding a user id + role. */
export function createSessionToken(userId: string, role: Role): string {
  const payload = b64url(JSON.stringify({ v: 2, userId, role, iat: Date.now() }));
  return `${payload}.${sign(payload)}`;
}

// Verify the HMAC (timing-safe, FIRST) and parse the payload. Returns the parsed
// object or null. No CLAIM checks here — callers apply version-specific claim
// logic — but this is the single crypto+parse gate both verify and getSession
// use, so neither can accidentally skip the signature.
interface RawPayload {
  v?: number;
  userId?: unknown;
  role?: unknown;
  iat?: unknown;
}
function verifiedPayload(token: string | undefined | null): RawPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as RawPayload;
  } catch {
    return null;
  }
}

function notExpired(iat: unknown): boolean {
  return typeof iat === "number" && Date.now() - iat <= MAX_AGE_SECONDS * 1000;
}

// The role a given version is ALLOWED to carry. v<2 only ever minted "presenter";
// v:2 may be admin or presenter. This is what prevents a forged-looking downgrade
// from being accepted with an unexpected role — but the signature already makes
// forgery impossible; this is claim-shape discipline.
function roleOkFor(v: number | undefined, role: unknown): boolean {
  if (v === 2) return role === "admin" || role === "presenter";
  return role === "presenter"; // v:0 / v:1
}

/**
 * Boolean gate used by the ~16 presenter-gated routes. True iff the token is
 * validly signed, not expired, and carries an accepted (version-appropriate)
 * role. Widened for v:2 so admin cookies also pass every gate.
 */
export function verifySessionToken(token: string | undefined | null): boolean {
  const data = verifiedPayload(token);
  if (!data) return false;
  if (!notExpired(data.iat)) return false;
  if (!roleOkFor(data.v, data.role)) return false;
  if (data.v === 2 && typeof data.userId !== "string") return false;
  return data.v === undefined || data.v === 1 || data.v === 2;
}

/**
 * Identity + role for authorization (ownership, admin-only actions). Runs the
 * IDENTICAL signature + expiry + role checks as verifySessionToken (returns null
 * for anything invalid/expired — an expired admin cookie must NOT manage decks),
 * THEN maps: v:2 → its stored {userId, role}; legacy v:0/v:1 → the admin identity
 * with a null userId (the pre-accounts presenter was the admin).
 */
export function getSession(token: string | undefined | null): Session | null {
  const data = verifiedPayload(token);
  if (!data) return null;
  if (!notExpired(data.iat)) return null;
  if (!roleOkFor(data.v, data.role)) return null;
  if (data.v === 2) {
    if (typeof data.userId !== "string") return null;
    return { userId: data.userId, role: data.role as Role };
  }
  if (data.v === undefined || data.v === 1) {
    return { userId: null, role: "admin" }; // legacy admin
  }
  return null; // unknown future version
}

/**
 * Authorization for a specific deck. An admin manages anything. A presenter
 * manages ONLY a deck they own — `ownerId && ownerId === session.userId`. The
 * `ownerId &&` guard is load-bearing: a registry/system deck has ownerId=null and
 * a legacy-admin session has userId=null, so `null === null` must NOT grant
 * access — but a legacy admin already passed via role==='admin' above, and a real
 * presenter's non-null userId can never equal a null ownerId.
 */
export function canManageDeck(session: Session, ownerId: string | null): boolean {
  if (session.role === "admin") return true;
  return !!ownerId && ownerId === session.userId;
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
