// Room recap broadcast (comprehension checkpoint). When the presenter sees the
// "I'm lost" meter spike they can push ONE short recap of the current slide to
// every viewer; it rides the EXISTING /api/session poll (no new viewer request)
// and renders as a dismissible overlay in parent app-chrome. At most one recap is
// active per deck — sending a new one replaces the old (a fresh id re-shows it to
// viewers who dismissed the previous one). Same Redis conventions as
// lib/signals.ts / lib/poll.ts: 8h TTL, in-memory fallback, best-effort — never
// throws.

import { randomBytes } from "crypto";
import { getRedis } from "./redis";

export interface Recap {
  id: string;
  text: string;
  slideIndex: number;
  at: number;
}

const keyFor = (slug: string) => `live:recap:${slug}`;
const TTL_S = 60 * 60 * 8;
const MAX_TEXT = 4000; // recaps are model answers (~700 tokens) — this is a hard backstop

// Persist the in-memory fallback across dev hot-reloads (see lib/pinboard.ts).
const g = globalThis as unknown as { __liveRecapMem?: Map<string, Recap> };
const mem = (g.__liveRecapMem ??= new Map<string, Recap>());

function newId(): string {
  return randomBytes(9).toString("base64url");
}

/** Set (or replace) the active recap for a deck. */
export async function setRecap(
  slug: string,
  input: { text: string; slideIndex: number },
): Promise<Recap> {
  const recap: Recap = {
    id: newId(),
    text: (input.text ?? "").toString().trim().slice(0, MAX_TEXT),
    slideIndex: Math.max(0, Math.floor(input.slideIndex)),
    at: Date.now(),
  };
  mem.set(slug, recap);
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(keyFor(slug), recap, { ex: TTL_S });
    } catch {
      /* best-effort */
    }
  }
  return recap;
}

/** The active recap for a deck, or null. */
export async function getRecap(slug: string): Promise<Recap | null> {
  const redis = await getRedis();
  if (redis) {
    try {
      const r = await redis.get<Recap>(keyFor(slug));
      return r && typeof r.id === "string" && typeof r.text === "string" ? r : null;
    } catch {
      /* fall through to memory */
    }
  }
  return mem.get(slug) ?? null;
}

/** Clear the active recap (removes the overlay for viewers). Best-effort. */
export async function clearRecap(slug: string): Promise<void> {
  mem.delete(slug);
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(keyFor(slug));
    } catch {
      /* best-effort */
    }
  }
}
