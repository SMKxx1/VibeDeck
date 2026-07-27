// The live presentation session — the shared state that lets one presenter drive
// many viewers across devices (slide-system-rules.md §5, extended to a server so
// it works on phones + laptop, not just one browser).
//
//   index — the presenter's current slide (0-based)
//   max   — the highest slide unlocked for viewers. Grows as the presenter shows
//           new slides; "reset lock" pins it back to the presenter's current slide.
//
// Backed by Upstash Redis when configured; otherwise an in-memory map (single
// instance only). A tiny in-instance read cache dedupes bursts of viewer polls so
// a room of phones doesn't hammer Redis.

import { getRedis, hasRedis, type RedisClient } from "./redis";
import type { Session } from "./auth";

export interface SessionState {
  index: number;
  max: number;
  updatedAt: number;
  /** Last time a presenter was seen (drove or heartbeat). Drives `live`. */
  seenAt: number;
  /**
   * Co-host mode: the userId currently holding "the clicker" (slide control).
   * Unset until a presenter first drives — a legacy session simply has no driver,
   * and the first writer claims it. Other presenters are moderators (roster,
   * polls, recaps, Q&A) until they takeClicker().
   */
  driverId?: string;
}

/**
 * Co-host mode: the clicker is held per presenter IDENTITY, so every route that
 * writes or reads `driverId` must derive it the same way. A legacy (v<2) cookie has
 * no user row (userId null) but is one stable identity — the pre-accounts admin —
 * so it maps to a sentinel that can hold and contest the clicker like anyone else.
 * Shared by /api/session (drive, take, isDriver) and /api/poll (branch routing).
 */
export function driverIdFor(session: Session): string {
  return session.userId ?? "legacy-admin";
}

// A session is "live" (presenter actively presenting → viewers locked/synced) if
// a presenter has been seen within this window. Otherwise viewers browse freely.
export const LIVE_WINDOW_MS = 25_000;

export function isLive(state: SessionState): boolean {
  return state.seenAt > 0 && Date.now() - state.seenAt < LIVE_WINDOW_MS;
}

const DEFAULT: SessionState = { index: 0, max: 0, updatedAt: 0, seenAt: 0 };
const keyFor = (slug: string) => `live:session:${slug}`;
const TTL_S = 60 * 60 * 8;
const MEM_TTL_MS = TTL_S * 1000;
const MAX_MEM_SESSIONS = 500;

// Store the in-memory fallback on globalThis so Next's dev hot-reload (which
// re-evaluates modules) doesn't wipe the live session between edits. In
// production the Redis store is the source of truth anyway.
const g = globalThis as unknown as { __liveSessionMem?: Map<string, SessionState> };
const mem = (g.__liveSessionMem ??= new Map<string, SessionState>());

const CACHE_MS = 750;
const MAX_CACHE_ENTRIES = 1_000;
const cache = new Map<string, { at: number; state: SessionState }>();

const MUTATE_SESSION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local state = { index = 0, max = 0, updatedAt = 0, seenAt = 0 }
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then state = decoded end
end

state.index = math.max(0, math.floor(tonumber(state.index) or 0))
state.max = math.max(0, math.floor(tonumber(state.max) or state.index))
state.updatedAt = tonumber(state.updatedAt) or 0
state.seenAt = tonumber(state.seenAt) or 0
if type(state.driverId) ~= 'string' or state.driverId == '' then state.driverId = nil end

local action = ARGV[1]
local now = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local requestedIndex = math.max(0, math.floor(tonumber(ARGV[4]) or 0))
local driverId = ARGV[5]

if action == 'move' then
  if driverId ~= '' and state.driverId and state.driverId ~= driverId then
    return cjson.encode(state)
  end
  state.index = requestedIndex
  state.max = math.max(state.max, requestedIndex)
  state.updatedAt = now
  state.seenAt = now
  if not state.driverId and driverId ~= '' then state.driverId = driverId end
elseif action == 'take' then
  state.driverId = driverId
  state.seenAt = now
elseif action == 'reset' then
  state.max = state.index
  state.updatedAt = now
  state.seenAt = now
elseif action == 'heartbeat' then
  state.seenAt = now
else
  return redis.error_reply('unknown session action')
end

local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded, 'EX', ttl)
return encoded
`;

function normalize(s: unknown): SessionState | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Partial<SessionState>;
  if (typeof o.index !== "number") return null;
  return {
    index: Math.max(0, Math.floor(o.index)),
    max: Math.max(0, Math.floor(typeof o.max === "number" ? o.max : o.index)),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
    seenAt: typeof o.seenAt === "number" ? o.seenAt : 0,
    ...(typeof o.driverId === "string" && o.driverId ? { driverId: o.driverId } : {}),
  };
}

function cacheState(slug: string, state: SessionState, now = Date.now()): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(slug)) {
    for (const [key, entry] of cache) {
      if (now - entry.at >= CACHE_MS) cache.delete(key);
    }
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }
  cache.set(slug, { at: now, state });
}

function sweepMemory(now: number): void {
  if (mem.size < MAX_MEM_SESSIONS) return;
  for (const [slug, state] of mem) {
    const last = Math.max(state.updatedAt, state.seenAt);
    if (last <= 0 || now - last >= MEM_TTL_MS) {
      mem.delete(slug);
      cache.delete(slug);
    }
  }
  while (mem.size >= MAX_MEM_SESSIONS) {
    const oldest = mem.keys().next().value as string | undefined;
    if (!oldest) break;
    mem.delete(oldest);
    cache.delete(oldest);
  }
}

function readMemory(slug: string, now = Date.now()): SessionState {
  const state = mem.get(slug);
  if (!state) return DEFAULT;
  const last = Math.max(state.updatedAt, state.seenAt);
  if (last <= 0 || now - last >= MEM_TTL_MS) {
    mem.delete(slug);
    cache.delete(slug);
    return DEFAULT;
  }
  return state;
}

/** Fresh read (bypasses the poll cache) — for presenter writes. */
async function readRaw(slug: string): Promise<SessionState> {
  if (!hasRedis()) return readMemory(slug);
  const redis = await getRedis();
  if (redis) {
    try {
      const s = normalize(await redis.get<SessionState>(keyFor(slug)));
      if (s) return s;
    } catch {
      return DEFAULT;
    }
  }
  return DEFAULT;
}

function persistMemory(slug: string, state: SessionState): SessionState {
  sweepMemory(Date.now());
  mem.set(slug, state);
  cacheState(slug, state);
  return state;
}

type SessionAction = "move" | "take" | "reset" | "heartbeat";

function mutateMemory(
  slug: string,
  action: SessionAction,
  index = 0,
  driverId = "",
): SessionState {
  const prev = readMemory(slug);
  const now = Date.now();
  if (action === "move" && driverId && prev.driverId && prev.driverId !== driverId) {
    return prev;
  }
  let next: SessionState;
  if (action === "move") {
    const idx = Math.max(0, Math.floor(index));
    next = {
      index: idx,
      max: Math.max(prev.max, idx),
      updatedAt: now,
      seenAt: now,
      ...(prev.driverId ?? driverId ? { driverId: prev.driverId ?? driverId } : {}),
    };
  } else if (action === "take") {
    next = { ...prev, driverId, seenAt: now };
  } else if (action === "reset") {
    next = { ...prev, max: prev.index, updatedAt: now, seenAt: now };
  } else {
    next = { ...prev, seenAt: now };
  }
  return persistMemory(slug, next);
}

async function mutateRedis(
  redis: RedisClient,
  slug: string,
  action: SessionAction,
  index = 0,
  driverId = "",
): Promise<SessionState> {
  const raw = await redis.eval<string>(
    MUTATE_SESSION_SCRIPT,
    [keyFor(slug)],
    [action, Date.now(), TTL_S, index, driverId],
  );
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* normalize below turns a malformed script response into a write failure */
  }
  const state = normalize(parsed);
  if (!state) throw new Error("session_state_unavailable");
  cacheState(slug, state);
  return state;
}

async function mutate(
  slug: string,
  action: SessionAction,
  index = 0,
  driverId = "",
): Promise<SessionState> {
  if (!hasRedis()) return mutateMemory(slug, action, index, driverId);
  const redis = await getRedis();
  if (!redis) throw new Error("session_store_unavailable");
  return mutateRedis(redis, slug, action, index, driverId);
}

/** Cached read — what viewers poll. */
export async function getLiveSession(slug: string): Promise<SessionState> {
  const now = Date.now();
  const c = cache.get(slug);
  if (c && now - c.at < CACHE_MS) return c.state;
  const state = await readRaw(slug);
  cacheState(slug, state, now);
  return state;
}

/**
 * Presenter moved to `index`. Unlocks every slide up to there for viewers.
 *
 * Co-host mode: when a driver is on record, ONLY that presenter moves the shared
 * index — a different presenter's write is ignored (they're a moderator until they
 * takeClicker(); the current state is returned so their console still reconciles).
 * A session with no driver yet (fresh or legacy) is claimed by the first writer.
 * Callers that pass no driverId (legacy behavior) drive unconditionally, as today.
 */
export async function setPresenterIndex(slug: string, index: number, driverId?: string): Promise<SessionState> {
  return mutate(slug, "move", Math.max(0, Math.floor(index)), driverId ?? "");
}

/**
 * Internal companion for a transition that must update another in-memory live
 * store in the same event-loop turn. Production Redis callers must use an
 * atomic multi-key script instead; accepting them here would reintroduce the
 * split-brain fallback this module deliberately prevents.
 */
export function setPresenterIndexMemoryOnly(
  slug: string,
  index: number,
  driverId?: string,
): SessionState {
  if (hasRedis()) throw new Error("memory_session_disabled");
  return mutateMemory(slug, "move", Math.max(0, Math.floor(index)), driverId ?? "");
}

/** Drop a short-lived read snapshot after another live-state script wrote this key. */
export function invalidateSessionCache(slug: string): void {
  cache.delete(slug);
}

/**
 * Co-host handoff: the caller claims the clicker (slide control). Last claim wins
 * — "pass the clicker" is simply the other presenter taking it. Position and lock
 * are untouched; seenAt bumps so the claim also counts as presenter liveness.
 */
export async function takeClicker(slug: string, driverId: string): Promise<SessionState> {
  return mutate(slug, "take", 0, driverId);
}

/** Who holds the clicker (undefined = unclaimed — first presenter to drive wins). */
export async function getDriverId(slug: string): Promise<string | undefined> {
  return (await readRaw(slug)).driverId;
}

/** Presenter hit "reset lock": the current slide becomes the viewer ceiling. */
export async function resetLock(slug: string): Promise<SessionState> {
  return mutate(slug, "reset");
}

/** Presenter is still here — keep the session "live" without changing position. */
export async function heartbeat(slug: string): Promise<SessionState> {
  return mutate(slug, "heartbeat");
}

/**
 * Wipe ALL live-session state for a slug: the Redis key, the poll cache, and the
 * in-instance memory fallback. Called when an uploaded deck is DELETED so a later
 * deck that happens to reuse the freed slug can't inherit a stale presenter
 * position/max. Best-effort by contract — swallows a Redis blip (memory is already
 * cleared for this instance) so it can never fail the delete that invoked it.
 */
export async function clearSession(slug: string): Promise<void> {
  mem.delete(slug);
  cache.delete(slug);
  if (!hasRedis()) return;
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(keyFor(slug));
    } catch {
      /* best-effort — the memory fallback is already cleared for this instance */
    }
  }
}
