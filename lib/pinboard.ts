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
const MAX_PINS = 200;

// Persist the in-memory fallback across dev hot-reloads (see lib/session.ts).
const g = globalThis as unknown as { __livePinboardMem?: Map<string, Pin[]> };
const mem = (g.__livePinboardMem ??= new Map<string, Pin[]>());

/** Normalize a submitted link into a safe absolute http(s) URL, or null. */
export function normalizeUrl(raw: string): string | null {
  let s = (raw ?? "").toString().trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null; // reject bare words
    return u.toString();
  } catch {
    return null;
  }
}

export async function addPin(slug: string, name: string, rawUrl: string): Promise<Pin | null> {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  const pin: Pin = {
    name: (name ?? "").toString().trim().slice(0, 40) || "Someone",
    url,
    at: Date.now(),
  };
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.lpush(keyFor(slug), pin);
      await redis.ltrim(keyFor(slug), 0, MAX_PINS - 1);
      return pin;
    } catch {
      /* fall through to memory */
    }
  }
  const list = mem.get(slug) ?? [];
  list.unshift(pin);
  mem.set(slug, list.slice(0, MAX_PINS));
  return pin;
}

export async function getPins(slug: string): Promise<Pin[]> {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.lrange<Pin>(keyFor(slug), 0, MAX_PINS - 1);
      return raw.filter((p) => p && typeof p.url === "string");
    } catch {
      /* fall through to memory */
    }
  }
  return mem.get(slug) ?? [];
}
