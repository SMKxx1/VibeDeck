import crypto from "crypto";
import { checkRateLimit } from "./kv";

// Deck slugs are persisted in URLs, SQL rows, and Redis keys. Keep one strict
// grammar at every public ingress so arbitrary attacker strings cannot create an
// unbounded key namespace.
export const MAX_SLUG_LENGTH = 64;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidDeckSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SLUG_LENGTH && SLUG_RE.test(value);
}

function requestAddress(req: Request): string {
  // These headers are trustworthy only when the production proxy overwrites
  // them. Even if a direct client can spoof them, combining this dimension with
  // the room/name limiter is still strictly stronger than trusting a display name
  // alone. Deployment docs require stripping inbound forwarded headers.
  const candidates = [
    req.headers.get("cf-connecting-ip"),
    req.headers.get("x-real-ip"),
    req.headers.get("x-forwarded-for")?.split(",")[0],
  ];
  return candidates.find((v) => v && v.trim())?.trim().slice(0, 128) || "unknown";
}

/** Stable, non-reversible rate key; never persist a participant's raw IP. */
export function clientFingerprint(req: Request): string {
  return crypto.createHash("sha256").update(requestAddress(req)).digest("hex").slice(0, 24);
}

export async function checkPublicRateLimit(
  req: Request,
  scope: string,
  identity: string,
  options: { max?: number; windowSeconds?: number; paid?: boolean } = {},
): Promise<{ allowed: boolean; retryAfter: number }> {
  const normalizedIdentity = identity.trim().slice(0, 80) || "anonymous";
  const shared = options.paid === true && process.env.NODE_ENV === "production";
  const params = {
    max: options.max,
    windowSeconds: options.windowSeconds,
    requireSharedStore: shared,
  };
  const [byClient, byIdentity] = await Promise.all([
    checkRateLimit(`${scope}:ip:${clientFingerprint(req)}`, params),
    checkRateLimit(`${scope}:id:${normalizedIdentity}`, params),
  ]);
  return {
    allowed: byClient.allowed && byIdentity.allowed,
    retryAfter: Math.max(byClient.retryAfter, byIdentity.retryAfter),
  };
}

export function safeHttpsUrl(raw: unknown, maxLength = 2048): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > maxLength) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
