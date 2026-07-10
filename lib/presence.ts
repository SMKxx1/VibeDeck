// Live presence / roster (#1). Who is watching a live deck right now, what slide
// each viewer is on, and whether they're auto-following the presenter. Backed by a
// Redis HASH (one field per viewer name → {index, at, follow}) so concurrent
// viewer heartbeats are per-field atomic writes — never a lost-update
// read-modify-write on a single JSON blob. In-memory fallback (single instance)
// when Redis is absent, matching lib/session.ts / lib/pinboard.ts.
//
// Viewers are anonymous (a self-chosen localStorage name) — presence is a live
// "who's here" signal, deliberately NOT an identity or attendance-of-record.

import { getRedis } from "./redis";

export interface Presence {
  name: string;
  index: number; // the slide the viewer is currently on
  follow: boolean; // auto-following the presenter's position
  at: number; // last heartbeat
}

interface Entry {
  index: number;
  at: number;
  follow: boolean;
}

const keyFor = (slug: string) => `live:presence:${slug}`;
const FRESH_MS = 30_000; // a viewer whose last heartbeat is within 30s is "present"
const TTL_S = 60 * 60 * 8; // the whole roster key self-expires after 8h
const MAX_ROSTER = 500; // guard against a flood of fabricated names

// Persist the in-memory fallback across dev hot-reloads (see lib/session.ts).
const g = globalThis as unknown as {
  __livePresenceMem?: Map<string, Map<string, Entry>>;
};
const mem = (g.__livePresenceMem ??= new Map<string, Map<string, Entry>>());

/** A viewer heartbeat: record/refresh their presence. Best-effort. */
export async function markPresent(
  slug: string,
  name: string,
  index: number,
  follow: boolean,
): Promise<void> {
  const entry: Entry = { index: Math.max(0, Math.floor(index || 0)), at: Date.now(), follow: !!follow };
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.hset(keyFor(slug), name, entry);
      await redis.expire(keyFor(slug), TTL_S);
      return;
    } catch {
      /* fall through to memory */
    }
  }
  let m = mem.get(slug);
  if (!m) {
    m = new Map();
    mem.set(slug, m);
  }
  m.set(name, entry);
}

/** The fresh roster (viewers seen within FRESH_MS), newest heartbeat first. */
export async function getRoster(slug: string): Promise<Presence[]> {
  const now = Date.now();
  const redis = await getRedis();
  if (redis) {
    try {
      const all = await redis.hgetall<Entry>(keyFor(slug));
      const roster: Presence[] = [];
      const stale: string[] = [];
      for (const [name, e] of Object.entries(all)) {
        if (!e || typeof e.at !== "number" || now - e.at > FRESH_MS) {
          stale.push(name);
          continue;
        }
        roster.push({ name, index: e.index ?? 0, follow: !!e.follow, at: e.at });
      }
      // Prune stale fields so the hash can't grow without bound over a long session.
      if (stale.length) {
        try {
          await redis.hdel(keyFor(slug), ...stale.slice(0, 100));
        } catch {
          /* best-effort cleanup */
        }
      }
      return roster.sort((a, b) => b.at - a.at).slice(0, MAX_ROSTER);
    } catch {
      /* fall through to memory */
    }
  }
  const m = mem.get(slug);
  if (!m) return [];
  const roster: Presence[] = [];
  for (const [name, e] of m) {
    if (now - e.at <= FRESH_MS) roster.push({ name, index: e.index, follow: e.follow, at: e.at });
    else m.delete(name);
  }
  return roster.sort((a, b) => b.at - a.at).slice(0, MAX_ROSTER);
}

/**
 * Wipe presence for a slug. Companion to lib/session.ts clearSession — called on
 * uploaded-deck DELETE so a reused slug can't inherit a stale roster. Best-effort.
 */
export async function clearPresence(slug: string): Promise<void> {
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
