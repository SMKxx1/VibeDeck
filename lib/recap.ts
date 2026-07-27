// Room recap broadcast (comprehension checkpoint). When the presenter sees the
// "I'm lost" meter spike they can push ONE short recap of the current slide to
// every viewer; it rides the EXISTING /api/session poll (no new viewer request)
// and renders as a dismissible overlay in parent app-chrome. At most one recap is
// active per deck — sending a new one replaces the old (a fresh id re-shows it to
// viewers who dismissed the previous one). That "one record per deck" storage is
// lib/live-slot.ts: 8h TTL, in-memory fallback, best-effort — never throws.

import { makeLiveSlot } from "./live-slot";
import { newId } from "./redis-util";

export interface Recap {
  id: string;
  text: string;
  slideIndex: number;
  at: number;
}

const MAX_TEXT = 4000; // recaps are model answers (~700 tokens) — this is a hard backstop

// The key prefix, TTL and globalThis fallback name are the on-disk/on-instance
// format: prod Redis holds live recaps under exactly these, so they must not drift.
const slot = makeLiveSlot<Recap>({
  keyPrefix: "live:recap",
  ttlSeconds: 60 * 60 * 8,
  memoryKey: "__liveRecapMem",
  isValid: (v): v is Recap =>
    !!v && typeof (v as Recap).id === "string" && typeof (v as Recap).text === "string",
});

/** Set (or replace) the active recap for a deck. */
export async function setRecap(
  slug: string,
  input: { text: string; slideIndex: number },
): Promise<Recap> {
  return slot.set(slug, {
    id: newId(),
    text: (input.text ?? "").toString().trim().slice(0, MAX_TEXT),
    slideIndex: Math.max(0, Math.floor(input.slideIndex)),
    at: Date.now(),
  });
}

/** The active recap for a deck, or null. */
export const getRecap = slot.get;

/** Clear the active recap (removes the overlay for viewers). Best-effort. */
export const clearRecap = slot.clear;
