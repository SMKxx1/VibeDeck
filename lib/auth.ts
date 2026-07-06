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

/** Mint a signed session token: base64url(payload).signature */
export function createSessionToken(): string {
  const payload = b64url(JSON.stringify({ role: "presenter", iat: Date.now() }));
  return `${payload}.${sign(payload)}`;
}

/** Verify a session token: valid signature, presenter role, not expired. */
export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      role?: string;
      iat?: number;
    };
    if (data.role !== "presenter") return false;
    if (typeof data.iat !== "number") return false;
    if (Date.now() - data.iat > MAX_AGE_SECONDS * 1000) return false;
    return true;
  } catch {
    return false;
  }
}

export const SESSION_MAX_AGE = MAX_AGE_SECONDS;
