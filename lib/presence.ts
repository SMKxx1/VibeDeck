// Live presence / roster (#1). Who is watching a live deck right now, what slide
// each viewer is on, and whether they're auto-following the presenter. Backed by a
// Redis HASH (one field per viewer name → {index, at, follow}) so concurrent
// viewer heartbeats are per-field atomic writes — never a lost-update
// read-modify-write on a single JSON blob. In-memory fallback (single instance)
// when Redis is absent, matching lib/session.ts / lib/pinboard.ts.
//
// Viewers are anonymous (a self-chosen localStorage name) — presence is a live
// "who's here" signal, deliberately NOT an identity or attendance-of-record.

import { getRedis, hasRedis } from "./redis";
import { requireRedis as requireSharedRedis } from "./redis-util";

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
const seenKeyFor = (slug: string) => `live:presence-seen:${slug}`;
const FRESH_MS = 30_000; // a viewer whose last heartbeat is within 30s is "present"
const TTL_S = 60 * 60 * 8; // the whole roster key self-expires after 8h
const MAX_ROSTER = 500; // guard against a flood of fabricated names
const MAX_MEM_ROOMS = 500;

const MARK_PRESENT_SCRIPT = `
if redis.call('HLEN', KEYS[1]) > tonumber(ARGV[3]) * 2 then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
end
-- One-time migration for a pre-index roster: build the freshness ZSET from the
-- bounded hash, pruning malformed/stale legacy fields while doing so.
if redis.call('ZCARD', KEYS[2]) == 0 and redis.call('HLEN', KEYS[1]) > 0 then
  local all = redis.call('HGETALL', KEYS[1])
  local staleBefore = tonumber(ARGV[4])
  for i = 1, #all, 2 do
    local ok, entry = pcall(cjson.decode, all[i + 1])
    if not ok or type(entry) ~= 'table' or tonumber(entry.at) == nil or tonumber(entry.at) < staleBefore then
      redis.call('HDEL', KEYS[1], all[i])
    else
      redis.call('ZADD', KEYS[2], tonumber(entry.at), all[i])
    end
  end
end

local stale = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[4]))
if #stale > 0 then redis.call('HDEL', KEYS[1], unpack(stale)) end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[4]))

local exists = redis.call('HEXISTS', KEYS[1], ARGV[1])
if exists == 0 and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then
  return {0, redis.call('HLEN', KEYS[1])}
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], tonumber(ARGV[6]), ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
return {1, redis.call('HLEN', KEYS[1])}
`;

// Persist the in-memory fallback across dev hot-reloads (see lib/session.ts).
const g = globalThis as unknown as {
  __livePresenceMem?: Map<string, Map<string, Entry>>;
};
const mem = (g.__livePresenceMem ??= new Map<string, Map<string, Entry>>());
let memWrites = 0;

function sweepMemory(now: number): void {
  memWrites += 1;
  if (memWrites % 100 !== 0 && mem.size < MAX_MEM_ROOMS) return;
  for (const [slug, room] of mem) {
    for (const [name, entry] of room) {
      if (now - entry.at > FRESH_MS) room.delete(name);
    }
    if (room.size === 0) mem.delete(slug);
  }
  while (mem.size >= MAX_MEM_ROOMS) {
    const slug = mem.keys().next().value as string | undefined;
    if (!slug) break;
    mem.delete(slug);
  }
}

/** The shared store, or throw with THIS module's error code (lib/redis-util.ts). */
const requireRedis = () => requireSharedRedis("presence_store_unavailable");

export interface MarkPresentResult {
  status: "ok" | "full";
  watching: number;
}

/** A viewer heartbeat. `full` rejects a new fabricated identity at the cap. */
export async function markPresent(
  slug: string,
  name: string,
  index: number,
  follow: boolean,
): Promise<MarkPresentResult> {
  const entry: Entry = { index: Math.max(0, Math.floor(index || 0)), at: Date.now(), follow: !!follow };
  if (hasRedis()) {
    const redis = await requireRedis();
    const [accepted, watching] = await redis.eval<[number, number]>(
      MARK_PRESENT_SCRIPT,
      [keyFor(slug), seenKeyFor(slug)],
      [name, JSON.stringify(entry), MAX_ROSTER, entry.at - FRESH_MS, TTL_S, entry.at],
    );
    return { status: Number(accepted) === 1 ? "ok" : "full", watching: Number(watching) || 0 };
  }
  sweepMemory(entry.at);
  let m = mem.get(slug);
  if (!m) {
    m = new Map();
    mem.set(slug, m);
  }
  if (!m.has(name) && m.size >= MAX_ROSTER) {
    for (const [existingName, existing] of m) {
      if (entry.at - existing.at > FRESH_MS) m.delete(existingName);
    }
    if (m.size >= MAX_ROSTER) return { status: "full", watching: m.size };
  }
  m.set(name, entry);
  return { status: "ok", watching: m.size };
}

/** The fresh roster (viewers seen within FRESH_MS), newest heartbeat first. */
export async function getRoster(slug: string): Promise<Presence[]> {
  const now = Date.now();
  if (!hasRedis()) {
    const m = mem.get(slug);
    if (!m) return [];
    const roster: Presence[] = [];
    for (const [name, e] of m) {
      if (now - e.at <= FRESH_MS) roster.push({ name, index: e.index, follow: e.follow, at: e.at });
      else m.delete(name);
    }
    if (m.size === 0) mem.delete(slug);
    return roster.sort((a, b) => b.at - a.at).slice(0, MAX_ROSTER);
  }
  const redis = await getRedis();
  if (redis) {
    try {
      // Avoid materializing a legacy/attacked hash that predates the atomic cap.
      // The next heartbeat's migration script resets such a roster safely.
      if ((await redis.hlen(keyFor(slug))) > MAX_ROSTER * 2) return [];
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
      const sorted = roster.sort((a, b) => b.at - a.at);
      // Prune stale and legacy over-cap fields so the hash itself—not only the
      // returned projection—stays bounded.
      const excess = sorted.slice(MAX_ROSTER).map((entry) => entry.name);
      const remove = [...stale, ...excess];
      if (remove.length) {
        try {
          await redis.hdel(keyFor(slug), ...remove);
        } catch {
          /* best-effort cleanup */
        }
      }
      return sorted.slice(0, MAX_ROSTER);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Wipe presence for a slug. Companion to lib/session.ts clearSession — called on
 * uploaded-deck DELETE so a reused slug can't inherit a stale roster. Best-effort.
 */
export async function clearPresence(slug: string): Promise<void> {
  mem.delete(slug);
  if (!hasRedis()) return;
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(keyFor(slug));
      await redis.del(seenKeyFor(slug));
    } catch {
      /* best-effort */
    }
  }
}
