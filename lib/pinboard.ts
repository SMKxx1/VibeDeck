// The live pinboard — viewers submit a link to their site on the showcase slide;
// every submission pins up here (newest first), hyperlinked, with the submitter's
// name on top. Backed by Upstash Redis when configured; in-memory otherwise.

import { getRedis } from "./redis";

export interface Pin {
  name: string;
  url: string;
  at: number;
}

const keyFor = (slug: string) => `live:pinboard:${slug}`;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 64;
const MAX_PINS = 100;
const MAX_MEMORY_BOARDS = 100;
const PINBOARD_TTL_S = 24 * 60 * 60;
export const MAX_PIN_NAME_LENGTH = 40;
export const MAX_PIN_URL_LENGTH = 2_048;

// Persist the in-memory fallback across dev hot-reloads (see lib/session.ts).
interface MemoryBoard {
  pins: Pin[];
  expiresAt: number;
  touchedAt: number;
}
const g = globalThis as unknown as { __livePinboardMemV2?: Map<string, MemoryBoard> };
const mem = (g.__livePinboardMemV2 ??= new Map<string, MemoryBoard>());

export function isValidPinboardSlug(slug: string): boolean {
  return slug.length <= MAX_SLUG_LENGTH && SLUG_RE.test(slug);
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home")
  ) {
    return true;
  }

  // URL canonicalizes unusual IPv4 spellings before this check, so decimal,
  // octal, and hexadecimal loopback forms cannot sidestep these ranges.
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Normalize a submitted link into a safe absolute http(s) URL, or null. */
export function normalizeUrl(raw: string): string | null {
  let s = (raw ?? "").toString().trim();
  if (!s || s.length > MAX_PIN_URL_LENGTH) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (!u.hostname.includes(".") || u.hostname.length > 253) return null; // reject bare words
    if (isPrivateOrLocalHost(u.hostname)) return null;
    const normalized = u.toString();
    return normalized.length <= MAX_PIN_URL_LENGTH ? normalized : null;
  } catch {
    return null;
  }
}

function cleanName(name: unknown): string {
  return typeof name === "string"
    ? name.trim().slice(0, MAX_PIN_NAME_LENGTH) || "Someone"
    : "Someone";
}

function cleanStoredPin(raw: unknown): Pin | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Pin>;
  if (typeof value.url !== "string") return null;
  const url = normalizeUrl(value.url);
  if (!url) return null;
  return {
    name: cleanName(value.name),
    url,
    at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
  };
}

function pruneMemory(now: number): void {
  for (const [slug, board] of mem) {
    if (board.expiresAt <= now) mem.delete(slug);
  }
}

function makeRoomForMemoryBoard(): void {
  if (mem.size < MAX_MEMORY_BOARDS) return;
  let oldestSlug: string | null = null;
  let oldestTouch = Number.POSITIVE_INFINITY;
  for (const [slug, board] of mem) {
    if (board.touchedAt < oldestTouch) {
      oldestSlug = slug;
      oldestTouch = board.touchedAt;
    }
  }
  if (oldestSlug) mem.delete(oldestSlug);
}

export async function addPin(slug: string, name: string, rawUrl: string): Promise<Pin | null> {
  if (!isValidPinboardSlug(slug)) return null;
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  const pin: Pin = {
    name: cleanName(name),
    url,
    at: Date.now(),
  };
  const redis = await getRedis();
  if (redis) {
    try {
      const key = keyFor(slug);
      await redis.lpush(key, pin);
      await Promise.all([
        redis.ltrim(key, 0, MAX_PINS - 1),
        redis.expire(key, PINBOARD_TTL_S),
      ]);
      return pin;
    } catch {
      /* fall through to memory */
    }
  }
  const now = Date.now();
  pruneMemory(now);
  const existing = mem.get(slug);
  if (!existing) makeRoomForMemoryBoard();
  mem.set(slug, {
    pins: [pin, ...(existing?.pins ?? [])].slice(0, MAX_PINS),
    expiresAt: now + PINBOARD_TTL_S * 1000,
    touchedAt: now,
  });
  return pin;
}

export async function getPins(slug: string): Promise<Pin[]> {
  if (!isValidPinboardSlug(slug)) return [];
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.lrange<Pin>(keyFor(slug), 0, MAX_PINS - 1);
      return raw.map(cleanStoredPin).filter((pin): pin is Pin => pin !== null);
    } catch {
      /* fall through to memory */
    }
  }
  const now = Date.now();
  pruneMemory(now);
  const board = mem.get(slug);
  if (!board) return [];
  board.touchedAt = now;
  return board.pins.map(cleanStoredPin).filter((pin): pin is Pin => pin !== null);
}

/**
 * Wipe the pinboard for a slug (Redis list + memory fallback). Companion to
 * lib/session.ts's clearSession: called on uploaded-deck DELETE so a reused slug
 * can't inherit stale pins. Best-effort — never throws, so it can't fail the delete.
 */
export async function clearPinboard(slug: string): Promise<void> {
  mem.delete(slug);
  if (!isValidPinboardSlug(slug)) return;
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(keyFor(slug));
    } catch {
      /* best-effort — memory is already cleared for this instance */
    }
  }
}
