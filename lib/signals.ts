// Live viewer→presenter backchannel (#2): lightweight anonymous signals a viewer
// can send up to the presenter — reactions (👍 🎉), a "slow down" 🐢, a raised
// hand 🙋, and the important "I'm lost". A direct clone of lib/pinboard.ts (a
// capped Redis list, newest first, in-memory fallback). This is the ONLY channel
// from viewers back to the presenter and is deliberately emoji/enum-only, so there
// is nothing free-text to moderate.

import { getRedis } from "./redis";

export const SIGNAL_KINDS = ["up", "party", "slow", "hand", "lost"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export function isSignalKind(k: string): k is SignalKind {
  return (SIGNAL_KINDS as readonly string[]).includes(k);
}

export interface Signal {
  name: string;
  kind: SignalKind;
  at: number;
}

const keyFor = (slug: string) => `live:signals:${slug}`;
const MAX = 200;
const TTL_S = 60 * 60 * 8;

// Persist the in-memory fallback across dev hot-reloads (see lib/pinboard.ts).
const g = globalThis as unknown as { __liveSignalsMem?: Map<string, Signal[]> };
const mem = (g.__liveSignalsMem ??= new Map<string, Signal[]>());

export async function addSignal(slug: string, name: string, kind: SignalKind): Promise<Signal> {
  const sig: Signal = {
    name: (name ?? "").toString().trim().slice(0, 40) || "Someone",
    kind,
    at: Date.now(),
  };
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.lpush(keyFor(slug), sig);
      await redis.ltrim(keyFor(slug), 0, MAX - 1);
      await redis.expire(keyFor(slug), TTL_S);
      return sig;
    } catch {
      /* fall through to memory */
    }
  }
  const list = mem.get(slug) ?? [];
  list.unshift(sig);
  mem.set(slug, list.slice(0, MAX));
  return sig;
}

/** Signals from the last `sinceMs` ms (newest first). */
export async function getSignals(slug: string, sinceMs: number): Promise<Signal[]> {
  const cutoff = Date.now() - Math.max(0, sinceMs);
  const redis = await getRedis();
  let list: Signal[];
  if (redis) {
    try {
      list = (await redis.lrange<Signal>(keyFor(slug), 0, MAX - 1)).filter(
        (s) => s && typeof s.at === "number" && isSignalKind(s.kind),
      );
    } catch {
      list = mem.get(slug) ?? [];
    }
  } else {
    list = mem.get(slug) ?? [];
  }
  return list.filter((s) => s.at >= cutoff);
}

/** Wipe signals for a slug (companion to clearSession/clearPinboard). Best-effort. */
export async function clearSignals(slug: string): Promise<void> {
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
