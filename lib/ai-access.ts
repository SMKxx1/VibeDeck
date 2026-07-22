import crypto from "crypto";
import { sign } from "./auth";

const ACCESS_MAX_AGE_SECONDS = 60 * 60 * 8;
export const AI_ACCESS_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-vibedeck_ai_access" : "vibedeck_ai_access";

function configuredPassword(): string | null {
  const value = process.env.AI_CLASS_PASSWORD?.trim();
  return value || null;
}

export function isAiAccessRequired(): boolean {
  return configuredPassword() !== null;
}

export function verifyAiClassPassword(candidate: unknown): boolean {
  const expected = configuredPassword();
  if (!expected || typeof candidate !== "string") return !expected;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createAiAccessToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, purpose: "ai-access", exp: Date.now() + ACCESS_MAX_AGE_SECONDS * 1000 }),
  ).toString("base64url");
  return `${payload}.${sign(`ai-access:${payload}`)}`;
}

export function verifyAiAccessToken(token: string | null | undefined): boolean {
  if (!configuredPassword()) return true;
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(`ai-access:${payload}`));
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: unknown;
      purpose?: unknown;
      exp?: unknown;
    };
    return (
      parsed.v === 1 &&
      parsed.purpose === "ai-access" &&
      typeof parsed.exp === "number" &&
      Number.isFinite(parsed.exp) &&
      Date.now() < parsed.exp
    );
  } catch {
    return false;
  }
}

export const AI_ACCESS_MAX_AGE = ACCESS_MAX_AGE_SECONDS;
