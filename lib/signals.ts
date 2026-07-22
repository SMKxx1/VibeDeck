// Live viewer→presenter backchannel (#2): lightweight anonymous signals a viewer
// can send up to the presenter — reactions (👍 🎉), a "slow down" 🐢, a raised
// hand 🙋, and the important "I'm lost". A direct clone of lib/pinboard.ts (a
// capped Redis list, newest first, in-memory fallback). This is the ONLY channel
// from viewers back to the presenter and is deliberately emoji/enum-only, so there
// is nothing free-text to moderate.

import { getRedis, hasRedis } from "./redis";

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
const MEM_TTL_MS = TTL_S * 1000;
const MAX_MEM_ROOMS = 500;

const ADD_SIGNAL_SCRIPT = `
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return redis.call('LLEN', KEYS[1])
`;

// Persist the in-memory fallback across dev hot-reloads (see lib/pinboard.ts).
const g = globalThis as unknown as { __liveSignalsMem?: Map<string, Signal[]> };
const mem = (g.__liveSignalsMem ??= new Map<string, Signal[]>());
let memWrites = 0;

function sweepMemory(now: number): void {
  memWrites += 1;
  if (memWrites % 100 !== 0 && mem.size < MAX_MEM_ROOMS) return;
  for (const [slug, list] of mem) {
    if (list.length === 0 || now - list[0].at >= MEM_TTL_MS) mem.delete(slug);
  }
  while (mem.size >= MAX_MEM_ROOMS) {
    const slug = mem.keys().next().value as string | undefined;
    if (!slug) break;
    mem.delete(slug);
  }
}

export async function addSignal(slug: string, name: string, kind: SignalKind): Promise<Signal> {
  const sig: Signal = {
    name: (name ?? "").toString().trim().slice(0, 40) || "Someone",
    kind,
    at: Date.now(),
  };
  if (hasRedis()) {
    const redis = await getRedis();
    if (!redis) throw new Error("signal_store_unavailable");
    await redis.eval<number>(
      ADD_SIGNAL_SCRIPT,
      [keyFor(slug)],
      [JSON.stringify(sig), MAX, TTL_S],
    );
    return sig;
  }
  sweepMemory(sig.at);
  const list = mem.get(slug) ?? [];
  list.unshift(sig);
  mem.set(slug, list.slice(0, MAX));
  return sig;
}

/** Signals from the last `sinceMs` ms (newest first). */
export async function getSignals(slug: string, sinceMs: number): Promise<Signal[]> {
  const cutoff = Date.now() - Math.max(0, sinceMs);
  if (!hasRedis()) {
    const list = mem.get(slug) ?? [];
    if (list.length && Date.now() - list[0].at >= MEM_TTL_MS) {
      mem.delete(slug);
      return [];
    }
    return list.filter((signal) => signal.at >= cutoff);
  }
  const redis = await getRedis();
  if (redis) {
    try {
      const list = (await redis.lrange<Signal>(keyFor(slug), 0, MAX - 1)).filter(
        (s) => s && typeof s.at === "number" && isSignalKind(s.kind),
      );
      return list.filter((signal) => signal.at >= cutoff);
    } catch {
      return [];
    }
  }
  return [];
}

/** Wipe signals for a slug (companion to clearSession/clearPinboard). Best-effort. */
export async function clearSignals(slug: string): Promise<void> {
  mem.delete(slug);
  if (!hasRedis()) return;
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(keyFor(slug));
    } catch {
      /* best-effort */
    }
  }
}
